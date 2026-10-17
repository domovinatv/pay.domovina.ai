import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import { MoneriumClient } from '../monerium/client';
import { getTenantRail, type RailChain } from '../tenants/rail';
import { ADDR_RE, ID_RE, campaignIdFree, registerCampaign } from '../tenants/campaigns';
// @ts-expect-error — plain .mjs shared with the setup dApp and tools/funding
import * as ps from '../../safe-tx/lib/project-safe.mjs';

/// "Dodaj projekt" (ADR 0027): one call makes a project real on the rail.
///
///   1. Plan the project Safe from owners, threshold and salt `project:<id>`
///      (CREATE2, born with the Monerium link message signed).
///   2. Not deployed yet: the Worker's deployer for that chain sends
///      createProxyWithNonce (sandbox: CHIADO_DEPLOYER_PRIVATE_KEY), or the
///      page deploys from MetaMask and calls again.
///   3. Check on chain: code, exact owners/threshold, ERC-1271 with "0x".
///   4. Monerium POST /addresses with the TENANT's own credentials.
///   5. Campaign + payout whitelist + audit. The ProjectRouter role learns
///      the Safe only when 2/3 owners sign the plan on the setup page.
///
/// The deployer key can only buy gas for a factory call whose arguments the
/// Worker computed itself; it is never a Safe owner and moves no money.
/// The Monerium address name needs a web session (link-safe.mjs), so the
/// response carries the console snippet funding-init prints.

export const MONERIUM_UI = { sandbox: 'https://sandbox.monerium.dev', production: 'https://monerium.app' } as const;
const CHAINS = { gnosis, chiado: gnosisChiado } as const;

export interface ProjectChain {
  chain: RailChain;
  version: string;
  creationCode(): Promise<Hex>;
  hasCode(a: Address): Promise<boolean>;
  isLinkSigned(a: Address): Promise<boolean>;
  readOwners(a: Address): Promise<{ owners: Address[]; threshold: number }>;
  /// Present only when the Worker has a deployer key for this chain.
  deployer?: { address: Address; deploy(factory: Address, args: readonly unknown[]): Promise<Hex> };
}

export interface ProjectMonerium {
  sandbox: boolean;
  profileId(): Promise<string>;
  findAddress(a: string): Promise<{ chains: string[] } | null>;
  link(profile: string, a: string, chain: string): Promise<{ state?: string }>;
}

export interface AddProjectInput {
  campaign_id?: string;
  label?: string;
  owners?: string[];
  threshold?: number;
  /// false = only check / plan; the page deploys from MetaMask itself.
  deploy?: boolean;
}

export type AddProjectResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 502; body: { error: string; [k: string]: unknown } };

/// Normalised deployer key (trim, 0x, 64 hex) or null — a malformed secret
/// means "no deployer", never a crash on the admin page.
export function deployerKey(env: Env, chain: RailChain): Hex | null {
  let k = (chain === 'chiado' ? env.CHIADO_DEPLOYER_PRIVATE_KEY : env.GNOSIS_DEPLOYER_PRIVATE_KEY)?.trim() ?? '';
  if (!k) return null;
  if (!k.startsWith('0x')) k = `0x${k}`;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
}

export function deployerAddress(env: Env, chain: RailChain): Address | null {
  const k = deployerKey(env, chain);
  return k ? privateKeyToAccount(k).address : null;
}

export function projectChain(env: Env, chain: RailChain, rpcUrl: string): ProjectChain {
  const pub = createPublicClient({ chain: CHAINS[chain], transport: http(rpcUrl) }) as PublicClient;
  const version = ps.SAFE_VERSION[chain] as string;
  const key = deployerKey(env, chain);
  const account = key ? privateKeyToAccount(key) : null;
  return {
    chain,
    version,
    creationCode: async () => {
      await ps.assertSafeContracts(pub, version);
      return ps.readProxyCreationCode(pub, version);
    },
    hasCode: (a) => ps.hasCode(pub, a),
    isLinkSigned: (a) => ps.isLinkSigned(pub, a),
    readOwners: (a) => ps.readSafeOwners(pub, a),
    ...(account
      ? {
          deployer: {
            address: account.address,
            deploy: async (factory: Address, args: readonly unknown[]) => {
              const wallet = createWalletClient({ account, chain: CHAINS[chain], transport: http(rpcUrl) });
              const { request } = await pub.simulateContract({ account, address: factory, abi: ps.FACTORY_ABI, functionName: 'createProxyWithNonce', args: args as never });
              const hash = await wallet.writeContract(request as never);
              const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
              if (rc.status !== 'success') throw new Error(`deploy tx nije uspio: ${hash}`);
              return hash;
            },
          },
        }
      : {}),
  };
}

export function projectMonerium(m: MoneriumClient, sandbox: boolean): ProjectMonerium {
  return {
    sandbox,
    profileId: () => m.resolveProfileId(),
    findAddress: async (a) => {
      const hit = (await m.listAddresses()).find((x) => x.address?.toLowerCase() === a.toLowerCase());
      return hit ? { chains: hit.chains ?? [] } : null;
    },
    link: async (profile, a, chain) =>
      m.linkAddress({ profile, address: a, chain, message: ps.MONERIUM_LINK_MESSAGE, signature: '0x' }),
  };
}

/// Monerium web-UI console snippet that names the address (Wallets → Save).
export function moneriumNameSnippet(address: string, name: string): string {
  return `console.log((await fetch('/api/addresses/${address}/config', { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(name)} }) })).status)`;
}

const fail = (status: 400 | 404 | 409 | 502, error: string, extra: Record<string, unknown> = {}): AddProjectResult =>
  ({ status, body: { error, ...extra } });

export async function addProject(
  env: Env,
  args: { tenantId: string; mainSafe: string | null; input: AddProjectInput; actor: string },
  deps: { chain: ProjectChain; monerium: ProjectMonerium },
): Promise<AddProjectResult> {
  const { tenantId, input } = args;
  const campaignId = (input.campaign_id ?? '').trim();
  const label = (input.label ?? '').trim() || null;
  const owners = input.owners?.length ? input.owners.map((o) => String(o).trim()) : (ps.DEFAULT_OWNERS as string[]);
  const threshold = input.threshold ?? (input.owners?.length ? NaN : (ps.DEFAULT_THRESHOLD as number));
  if (!ID_RE.test(campaignId)) return fail(400, 'invalid_campaign_id');
  try {
    ps.checkOwners(owners, threshold);
  } catch (err) {
    return fail(400, 'invalid_owners', { detail: (err as Error).message });
  }
  if (!(await campaignIdFree(env, tenantId, campaignId))) return fail(409, 'campaign_owned_by_other_tenant');

  const { chain } = deps;
  const plan = ps.projectSafePlan({
    version: chain.version, owners, threshold, saltLabel: ps.projectSaltLabel(campaignId), preSignLink: true,
    creationCode: await chain.creationCode(),
  }) as { address: Address; factory: Address; args: readonly unknown[] };
  const safe = getAddress(plan.address);
  if (args.mainSafe && args.mainSafe.toLowerCase() === safe.toLowerCase()) return fail(409, 'main_safe_is_not_a_project');
  const planned = { safe_address: safe, chain: chain.chain, safe_version: chain.version, owners, threshold, salt: ps.projectSaltLabel(campaignId) };

  let deployTx: Hex | null = null;
  if (!(await chain.hasCode(safe))) {
    if (input.deploy === false || !chain.deployer) {
      return fail(409, 'safe_not_deployed', {
        ...planned,
        factory: plan.factory,
        deployer: chain.deployer?.address ?? null,
      });
    }
    try {
      deployTx = await chain.deployer.deploy(plan.factory, plan.args);
    } catch (err) {
      return fail(502, 'deploy_failed', { ...planned, deployer: chain.deployer.address, detail: (err as Error).message.split('\n')[0] });
    }
    if (!(await chain.hasCode(safe))) return fail(502, 'deploy_no_code', { ...planned, deploy_tx: deployTx });
  }

  // The CREATE2 address already pins owners/threshold; reading them back
  // catches a wrong factory or singleton on an unexpected chain.
  const on = await chain.readOwners(safe);
  if (!ps.sameOwners(owners, on.owners) || on.threshold !== threshold) {
    return fail(409, 'owners_mismatch', { ...planned, on_chain: on });
  }
  if (!(await chain.isLinkSigned(safe))) return fail(409, 'link_not_signed', planned);

  const moneriumChain = chain.chain;
  let monerium: { state: string; already: boolean };
  try {
    const found = await deps.monerium.findAddress(safe);
    if (found) {
      monerium = { state: 'linked', already: true };
    } else {
      const r = await deps.monerium.link(await deps.monerium.profileId(), safe, moneriumChain);
      monerium = { state: r.state ?? 'linked', already: false };
    }
  } catch (err) {
    // Nothing written yet: a retry starts clean (the Safe exists, so it only links).
    return fail(502, 'monerium_link_failed', { ...planned, deploy_tx: deployTx, detail: (err as Error).message.slice(0, 300) });
  }

  const r = await registerCampaign(env, {
    tenantId, campaignId, safeAddress: safe, label, actor: args.actor, action: 'project.add',
    detail: { owners, threshold, chain: chain.chain, deploy_tx: deployTx, monerium: monerium.state },
  });
  if (!r.ok) return fail(r.error === 'campaign_owned_by_other_tenant' ? 409 : 400, r.error);

  const name = `${deps.monerium.sandbox ? 'Projekt (sandbox) ' : 'Projekt '}${label ?? campaignId} · ${campaignId}`;
  return {
    status: 200,
    body: {
      ok: true,
      campaign_id: campaignId,
      ...planned,
      safe_address: r.safeAddress,
      deploy_tx: deployTx,
      deployer: deployTx ? chain.deployer!.address : null,
      monerium,
      monerium_name: {
        ui: deps.monerium.sandbox ? MONERIUM_UI.sandbox : MONERIUM_UI.production,
        snippet: moneriumNameSnippet(safe, name),
      },
    },
  };
}

/// Route wrapper: real chain + the tenant's own Monerium account. A tenant
/// whose rail does not resolve gets no project (fail-closed, ADR 0017).
export async function addProjectForTenant(env: Env, tenantId: string, input: AddProjectInput, actor: string): Promise<AddProjectResult> {
  const rail = await getTenantRail(env, tenantId);
  if (!rail) return fail(409, 'rail_unavailable');
  if (!ADDR_RE.test(rail.signer.safe || '')) return fail(409, 'rail_has_no_main_safe');
  const m = new MoneriumClient(env, rail.monerium);
  return addProject(
    env,
    { tenantId, mainSafe: rail.signer.safe, input, actor },
    {
      chain: projectChain(env, rail.signer.chain, rail.signer.rpcUrl),
      monerium: projectMonerium(m, rail.monerium.baseUrl.includes('monerium.dev')),
    },
  );
}
