/**
 * ProjectRouter batch builder (ADR 0026), shared by the safe-tx/009 CLI,
 * tools/funding/router-scope.mjs and the tenant setup dApp (ADR 0027). Pure:
 * only viem and a public client, so esbuild can bundle it for the browser.
 */
import { encodeFunctionData, getAddress, isAddress } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';

import {
  ExecutionOptions,
  ROLES_ABI,
  ROLES_MASTERCOPY,
  SAFE_ABI,
  SENTINEL,
  TRANSFER_SELECTOR,
  normaliseRecipients,
  readRecipientSet,
  readRoleMembers,
  readRoleTargets,
  roleKeyOf,
  transferRecipientConditions,
} from './roles-v2.mjs';

export const ENVS = {
  gnosis: {
    chain: gnosis,
    chainId: '100',
    rpc: 'https://rpc.gnosischain.com',
    safe: '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
    roles: '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
    eure: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    // Batch 001 set the modifier up in this block; nothing older matters.
    fromBlock: 46_280_000n,
    legacyRole: 'EUReForwarder',
  },
  chiado: {
    chain: gnosisChiado,
    chainId: '10200',
    rpc: 'https://rpc.chiadochain.net',
    safe: '0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF', // italk-sandbox main Safe
    roles: null, // deployed per Safe — pass --roles
    eure: '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71',
    fromBlock: null, // pass --from-block (the modifier's deploy block)
    legacyRole: null,
  },
};

export const ROLE = 'ProjectRouter';

export async function buildProjectRouterBatch(opts, client) {
  const env = ENVS[opts.env];
  if (!env) throw new Error(`--env must be gnosis or chiado`);
  const safe = getAddress(opts.safe ?? env.safe);
  const roles = opts.roles ?? env.roles;
  if (!roles || !isAddress(roles)) throw new Error('--roles is required (Roles modifier address)');
  const rolesAddr = getAddress(roles);
  const eure = getAddress(opts.eure ?? env.eure);
  const fromBlock = opts.fromBlock ?? env.fromBlock;
  if (fromBlock === null || fromBlock === undefined) throw new Error('--from-block is required on this env');
  const roleKey = roleKeyOf(ROLE);
  const notes = [];

  // ── Preflight: the modifier must be ours and run the audited mastercopy ──
  for (const f of ['owner', 'avatar', 'target']) {
    const v = await client.readContract({ address: rolesAddr, abi: ROLES_ABI, functionName: f });
    if (getAddress(v) !== safe) throw new Error(`Roles.${f}() = ${v}, expected the Safe ${safe}`);
  }
  const code = (await client.getCode({ address: rolesAddr })) ?? '0x';
  if (!code.toLowerCase().includes(ROLES_MASTERCOPY.slice(2).toLowerCase())) {
    throw new Error(`Roles ${rolesAddr} is not a minimal proxy of the verified mastercopy ${ROLES_MASTERCOPY}`);
  }

  const txs = [];
  const roleTx = (functionName, args) => ({
    to: rolesAddr, value: '0',
    data: encodeFunctionData({ abi: ROLES_ABI, functionName, args }),
    contractMethod: null, contractInputsValues: null,
    _label: `Roles.${functionName}`,
  });

  // 1. Module on the Safe.
  const [modules] = await client.readContract({
    address: safe, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 50n],
  });
  const foreign = modules.filter((m) => getAddress(m) !== rolesAddr);
  if (foreign.length) throw new Error(`Safe has unexpected modules: ${foreign.join(', ')} — investigate first`);
  if (modules.length === 0) {
    txs.push({
      to: safe, value: '0',
      data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [rolesAddr] }),
      contractMethod: null, contractInputsValues: null, _label: 'Safe.enableModule',
    });
  } else notes.push('Roles is already an enabled module');

  // 2. The retired role must not come back to life with the module.
  if (opts.legacyCleanup !== false && env.legacyRole) {
    const legacyKey = roleKeyOf(env.legacyRole);
    const live = await readRoleTargets(client, { roles: rolesAddr, roleKey: legacyKey, fromBlock });
    for (const t of live) txs.push(roleTx('revokeTarget', [legacyKey, t]));
    notes.push(`${env.legacyRole}: ${live.length ? `revoking ${live.join(', ')}` : 'no live targets'}`);
  }

  // 3–4. Scope EURe.transfer to the full project set.
  const current = await readRecipientSet(client, { roles: rolesAddr, roleKey, eure, fromBlock });
  if (current && current.options !== ExecutionOptions.None) {
    throw new Error(`current ProjectRouter options = ${current.options}, expected None — investigate first`);
  }
  const before = current?.recipients ?? [];
  const recipients = normaliseRecipients([...before, ...opts.recipients], { safe });
  const added = recipients.filter((r) => !before.includes(r));
  const targetLive = (await readRoleTargets(client, { roles: rolesAddr, roleKey, fromBlock })).includes(eure);
  if (!targetLive) txs.push(roleTx('scopeTarget', [roleKey, eure]));
  if (added.length || !current) {
    txs.push(roleTx('scopeFunction', [
      roleKey, eure, TRANSFER_SELECTOR, transferRecipientConditions(recipients), ExecutionOptions.None,
    ]));
  } else notes.push('recipient set unchanged — no scopeFunction');

  // 5. Members (skipped when the chain already says so).
  const members = (opts.router || opts.revokeRouter)
    ? await readRoleMembers(client, { roles: rolesAddr, roleKey, fromBlock })
    : null;
  const isMember = (a) => members.some((m) => m === getAddress(a));
  if (opts.router) {
    if (isMember(opts.router)) notes.push(`${getAddress(opts.router)} is already a member`);
    else txs.push(roleTx('assignRoles', [getAddress(opts.router), [roleKey], [true]]));
  }
  if (opts.revokeRouter) {
    if (!isMember(opts.revokeRouter)) notes.push(`${getAddress(opts.revokeRouter)} is not a member`);
    else txs.push(roleTx('assignRoles', [getAddress(opts.revokeRouter), [roleKey], [false]]));
  }

  return { safe, roles: rolesAddr, eure, roleKey, before, recipients, added, members, txs, notes, chainId: env.chainId };
}

export function toTxBuilderJson(b, { name } = {}) {
  return {
    version: '1.0',
    chainId: b.chainId,
    createdAt: Date.now(),
    meta: {
      name: name ?? `MPT — ${ROLE} (ADR 0026)`,
      description:
        `${ROLE} may call ONLY EURe.transfer from this Safe, and ONLY to: ${b.recipients.join(', ')}. ` +
        `No amount cap, no value, no delegatecall. Steps: ${b.txs.map((t) => t._label).join(', ')}. ` +
        `Check that every existing project is still in the list before signing.`,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: b.safe,
    },
    transactions: b.txs.map(({ _label, ...t }) => t),
  };
}
