/// Tenant on-chain setup dApp (ADR 0027), bundled by
/// scripts/build-setup-client.mjs and served at /admin/setup/client.js.
///
/// Flow: read the chain → plan the ProjectRouter batch (the same builder as
/// safe-tx/009) → simulate it as the Safe → an owner proposes and signs it
/// (EIP-712, MetaMask or a sandbox-only local key) → other owners confirm →
/// anyone with gas executes. The Safe Transaction Service is the shared queue,
/// so the same tx also shows in app.safe.global and Safe Mobile.
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseAbi,
  recoverTypedDataAddress,
  toEventSelector,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis, gnosisChiado } from 'viem/chains';

import { ROLE, buildProjectRouterBatch } from '../../../safe-tx/lib/project-router-batch.mjs';
import { ROLES_ABI, roleKeyOf } from '../../../safe-tx/lib/roles-v2.mjs';
import {
  SAFE_CHAINS,
  SAFE_TX_ABI,
  batchToSafeTx,
  confirmOnService,
  getSafeTx,
  nextNonce,
  packSignatures,
  preValidatedSignature,
  proposeToService,
  queuedSafeTxs,
  safeTxHash,
  safeTxTypedData,
  simulateSafeTx,
} from '../../../safe-tx/lib/safe-tx.mjs';
import * as ps from '../../../safe-tx/lib/project-safe.mjs';

interface Ctx {
  tenantId: string;
  tenantName: string;
  chain: 'gnosis' | 'chiado';
  chainId: number;
  rpcUrl: string;
  safe: string;
  roles: string | null;
  roleKey: string | null;
  router: string | null;
  eure: string;
  fromBlock: string | null;
  recipients: { address: string; label: string | null; campaignId: string }[];
  revoked?: { address: string; label: string | null; campaignId: string }[];
  deployer?: string | null;
  safeVersion?: string;
  defaultOwners?: string[];
  defaultThreshold?: number;
}

/// "Dodaj projekt" form. mode 'new' = a project Safe made here (CREATE2,
/// born linked to Monerium); 'existing' = a Safe that already exists.
interface NewProject {
  mode: 'new' | 'existing';
  id: string;
  label: string;
  addr: string;
  owners: string;
  threshold: string;
}
interface ProjectDone {
  campaignId: string;
  safe: string;
  deployTx: string | null;
  deployer: string | null;
  monerium: { state: string; already: boolean };
  name: { ui: string; snippet: string };
}

interface SafeTx { to: Address; value: bigint; data: Hex; operation: number }
interface Signer {
  kind: 'metamask' | 'local';
  address: Address;
  wallet: WalletClient;
}
interface Pending {
  hash: Hex;
  nonce: bigint;
  confirmations: { owner: Address; signature: Hex }[];
}

const CHAINS: Record<Ctx['chain'], Chain> = { gnosis, chiado: gnosisChiado };
const BLOCKSCOUT = { gnosis: 'https://gnosis.blockscout.com', chiado: 'https://gnosis-chiado.blockscout.com' };
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)');
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

let ctx = JSON.parse(document.getElementById('setup-config')!.textContent!) as Ctx;
const chain = CHAINS[ctx.chain];
const pub = createPublicClient({ chain, transport: http(ctx.rpcUrl) }) as PublicClient;
const app = document.getElementById('app')!;

const S: {
  signer: Signer | null;
  balance: bigint | null;
  owners: Address[];
  threshold: bigint;
  nonce: bigint;
  version: string;
  fromBlock: bigint | null;
  router: string;
  plan: Awaited<ReturnType<typeof buildProjectRouterBatch>> | null;
  tx: SafeTx | null;
  sim: { success: boolean; gas: bigint } | null;
  pending: Pending | null;
  checks: { address: string; label: string; expect: boolean; ok: boolean | null; why?: string }[];
  log: string[];
  busy: boolean;
  error: string | null;
  /// On-chain-only projects (no campaign in D1) marked for removal on this page.
  removeLocal: Set<string>;
  /// The add-project form survives re-renders (run() redraws before it acts).
  np: NewProject | null;
  /// Planned address of the form's new Safe, and whether it has code yet.
  npPlan: { address: Address; deployed: boolean } | null;
  npDone: ProjectDone | null;
} = {
  signer: null, balance: null, owners: [], threshold: 0n, nonce: 0n, version: '', fromBlock: null,
  router: ctx.router ?? '', plan: null, tx: null, sim: null, pending: null, checks: [], log: [], busy: false, error: null, removeLocal: new Set(), np: null, npPlan: null, npDone: null,
};

const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrLink = (a: string) => `<a class="mono" href="${BLOCKSCOUT[ctx.chain]}/address/${e(a)}" target="_blank" rel="noopener">${e(a)}</a>`;
const campaignOf = (a: string) => ctx.recipients.find((r) => r.address.toLowerCase() === a.toLowerCase());
const revokedOf = (a: string) => ctx.revoked?.find((r) => r.address.toLowerCase() === a.toLowerCase());
const labelOf = (a: string) => campaignOf(a)?.label ?? revokedOf(a)?.label ?? null;
const isOwner = (a?: string | null) => !!a && S.owners.some((o) => o.toLowerCase() === a.toLowerCase());
const say = (m: string) => { S.log.push(`${new Date().toLocaleTimeString('hr-HR')}  ${m}`); render(); };

// ── chain reads ───────────────────────────────────────────────────────────

async function resolveFromBlock(): Promise<bigint> {
  if (ctx.fromBlock) return BigInt(ctx.fromBlock);
  const key = `setup:fromBlock:${ctx.chainId}:${ctx.roles!.toLowerCase()}`;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return BigInt(hit);
  } catch { /* storage blocked */ }
  const block = await deployBlock(getAddress(ctx.roles!));
  try { localStorage.setItem(key, String(block)); } catch { /* storage blocked */ }
  return block;
}

/// The modifier's deploy block by binary search on eth_getCode over history
/// (~25 RPC calls). Blockscout's public API answers 429 under load (17.10.2026.).
async function deployBlock(address: Address): Promise<bigint> {
  const has = async (n: bigint) => ((await pub.getCode({ address, blockNumber: n })) ?? '0x') !== '0x';
  let hi = await pub.getBlockNumber();
  if (!(await has(hi))) throw new Error(`Roles modifier ${address} nema koda na lancu`);
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid; else lo = mid + 1n;
  }
  return lo;
}

async function refresh(): Promise<void> {
  S.error = null;
  S.plan = null; S.tx = null; S.sim = null; S.pending = null;
  render();
  const safe = getAddress(ctx.safe);
  const [owners, threshold, nonce, version] = await Promise.all([
    pub.readContract({ address: safe, abi: SAFE_TX_ABI, functionName: 'getOwners' }) as Promise<Address[]>,
    pub.readContract({ address: safe, abi: SAFE_TX_ABI, functionName: 'getThreshold' }) as Promise<bigint>,
    pub.readContract({ address: safe, abi: SAFE_TX_ABI, functionName: 'nonce' }) as Promise<bigint>,
    pub.readContract({ address: safe, abi: SAFE_TX_ABI, functionName: 'VERSION' }) as Promise<string>,
  ]);
  Object.assign(S, { owners, threshold, nonce, version });
  if (!ctx.roles) { render(); return; }
  S.fromBlock ??= await resolveFromBlock();
  const router = S.router && isAddress(S.router) ? getAddress(S.router) : undefined;
  S.plan = await buildProjectRouterBatch({
    env: ctx.chain,
    safe,
    roles: ctx.roles,
    eure: ctx.eure,
    fromBlock: S.fromBlock,
    recipients: ctx.recipients.map((r) => r.address),
    remove: [...(ctx.revoked ?? []).map((r) => r.address), ...S.removeLocal],
    router,
  }, pub);
  if (S.plan.txs.length) {
    S.tx = batchToSafeTx(S.plan.txs, ctx.chainId) as SafeTx;
    const sim = await simulateSafeTx(pub, { chainId: ctx.chainId, safe, tx: S.tx });
    S.sim = { success: sim.success, gas: sim.gas };
    S.pending = await findPending(S.tx);
  }
  await runChecks();
  S.balance = S.signer ? await pub.getBalance({ address: S.signer.address }) : null;
  render();
}

/// A queued tx with exactly our calldata (same Safe nonce or later) is the
/// one to confirm, never a second copy.
async function findPending(tx: SafeTx): Promise<Pending | null> {
  const q = await queuedSafeTxs(ctx.chainId, ctx.safe);
  const t = q.find((x: { to: string; data: string | null; nonce: string }) =>
    BigInt(x.nonce) >= S.nonce && getAddress(x.to) === getAddress(tx.to) && (x.data ?? '0x').toLowerCase() === tx.data.toLowerCase());
  if (!t) return null;
  return {
    hash: t.safeTxHash,
    nonce: BigInt(t.nonce),
    confirmations: (t.confirmations ?? []).map((c: { owner: string; signature: Hex }) => ({ owner: getAddress(c.owner), signature: c.signature })),
  };
}

/// What the router can do RIGHT NOW: one wei to every project must pass, one
/// wei to 0x…dEaD must be refused by the modifier. Plain eth_call from the
/// router address — nothing is sent.
async function runChecks(): Promise<void> {
  S.checks = [];
  const router = S.router && isAddress(S.router) ? getAddress(S.router) : null;
  if (!ctx.roles || !router || !S.plan || S.plan.before.length === 0) return;
  const roleKey = roleKeyOf(ROLE);
  const probe = async (to: string, label: string, expect: boolean) => {
    const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [getAddress(to), 1n] });
    const call = encodeFunctionData({
      abi: ROLES_ABI, functionName: 'execTransactionWithRole',
      args: [getAddress(ctx.eure), 0n, data, 0, roleKey, true],
    });
    try {
      await pub.call({ account: router, to: getAddress(ctx.roles!), data: call });
      S.checks.push({ address: to, label, expect, ok: expect });
    } catch (err) {
      S.checks.push({ address: to, label, expect, ok: !expect, why: (err as Error).message.split('\n')[0].slice(0, 120) });
    }
  };
  for (const r of S.plan.before) await probe(r, labelOf(r) ?? 'projekt', true);
  await probe(DEAD, 'kontrola: nije projekt', false);
}

// ── signers ───────────────────────────────────────────────────────────────

type Eip1193 = {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, f: (x: unknown) => void): void;
};

// EIP-6963: prefer MetaMask by rdns, since Brave Wallet (or another extension)
// may own window.ethereum.
const announced: { rdns: string; provider: Eip1193 }[] = [];
window.addEventListener('eip6963:announceProvider', (ev) => {
  const d = (ev as CustomEvent<{ info: { rdns: string }; provider: Eip1193 }>).detail;
  if (d?.provider && !announced.some((a) => a.provider === d.provider)) announced.push({ rdns: d.info.rdns, provider: d.provider });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

let watched: Eip1193 | null = null;

function injected(): Eip1193 {
  const eth = announced.find((a) => a.rdns === 'io.metamask')?.provider ?? (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('MetaMask nije pronađen u ovom pregledniku');
  return eth;
}

async function ensureChain(wallet: WalletClient): Promise<void> {
  if ((await wallet.getChainId()) === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
}

function useMetaMaskAccount(eth: Eip1193, address: string): void {
  S.signer = { kind: 'metamask', address: getAddress(address), wallet: createWalletClient({ chain, transport: custom(eth) }) };
  say(`MetaMask: ${address}${isOwner(address) ? ' (vlasnik)' : ' (nije vlasnik)'}`);
}

/// Follow the account picked in MetaMask, as app.safe.global does: a switch in
/// the extension replaces the signer without another click.
function watch(eth: Eip1193): void {
  if (watched === eth || !eth.on) return;
  watched = eth;
  eth.on('accountsChanged', (x) => {
    if (S.signer?.kind !== 'metamask') return;
    const [a] = (x as string[]) ?? [];
    if (!a) {
      S.signer = null;
      say('MetaMask: račun odspojen');
    } else if (getAddress(a) !== S.signer.address) {
      useMetaMaskAccount(eth, a);
    } else return;
    void run('MetaMask račun', async () => {});
  });
  eth.on('chainChanged', (x) => {
    if (S.signer?.kind === 'metamask' && Number(x) !== chain.id) say(`MetaMask je prešao na lanac ${Number(x)}; prije potpisa vraćam na ${chain.name}`);
  });
}

/// On load: an account this site is already allowed to see becomes the signer
/// without a click or a popup (eth_accounts never prompts).
async function autoConnect(): Promise<void> {
  let eth: Eip1193;
  try { eth = injected(); } catch { return; }
  const [a] = ((await eth.request({ method: 'eth_accounts' }).catch(() => [])) as string[]) ?? [];
  if (!a || S.signer) return;
  watch(eth);
  useMetaMaskAccount(eth, a);
}

/// A repeat click opens MetaMask's account picker (wallet_requestPermissions),
/// so an account not yet connected to this site can be chosen.
async function connectMetaMask(): Promise<void> {
  const eth = injected();
  watch(eth);
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  let address: string | undefined;
  try {
    await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    [address] = await wallet.getAddresses();
  } catch (err) {
    if ((err as { code?: number }).code === 4001) throw err;
    [address] = await wallet.requestAddresses();
  }
  if (!address) throw new Error('MetaMask nije dao račun');
  await ensureChain(wallet);
  useMetaMaskAccount(eth, address);
}

/// Sandbox only: a generated test owner key, kept in this tab's memory and
/// gone on reload. Production owner keys never touch a web page (ADR 0027).
function loadLocalKey(raw: string): void {
  if (ctx.chain !== 'chiado') throw new Error('Lokalni ključ je dopušten samo na Chiadu (sandbox)');
  let k = raw.trim();
  if (!k.startsWith('0x')) k = `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('Ključ mora imati 64 hex znaka');
  const account = privateKeyToAccount(k as Hex);
  const wallet = createWalletClient({ account, chain, transport: http(ctx.rpcUrl) });
  S.signer = { kind: 'local', address: account.address, wallet };
  say(`Lokalni ključ: ${account.address}${isOwner(account.address) ? ' (vlasnik)' : ' (nije vlasnik)'}`);
}

async function signSafeTx(nonce: bigint): Promise<{ hash: Hex; signature: Hex }> {
  const s = S.signer!;
  const hash = (await safeTxHash(pub, { chainId: ctx.chainId, safe: ctx.safe, tx: S.tx!, nonce })) as Hex;
  const td = safeTxTypedData({ chainId: ctx.chainId, safe: ctx.safe, tx: S.tx!, nonce });
  if (s.kind === 'metamask') await ensureChain(s.wallet);
  const signature = await s.wallet.signTypedData({ account: s.kind === 'local' ? s.wallet.account! : s.address, ...td } as never);
  const back = await recoverTypedDataAddress({ ...td, signature } as never);
  if (getAddress(back) !== s.address) throw new Error(`potpis je od ${back}, ne od ${s.address}`);
  return { hash, signature };
}

// ── actions ───────────────────────────────────────────────────────────────

/// D1 is the desired state: a campaign added or revoked here changes the
/// plan, and only the owners' 2/3 signature changes what the router may do.
async function reloadContext(): Promise<void> {
  const r = await fetch(`/admin/api/tenants/${encodeURIComponent(ctx.tenantId)}/setup`);
  if (!r.ok) throw new Error(`kontekst: HTTP ${r.status}`);
  ctx = { ...ctx, ...((await r.json()) as Ctx) };
}

async function campaignsApi(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<void> {
  const r = await fetch(`/admin/api/tenants/${encodeURIComponent(ctx.tenantId)}/campaigns${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
}

async function addExisting(campaignId: string, label: string, address: string): Promise<void> {
  if (!isAddress(address)) throw new Error('adresa projekta nije EVM adresa');
  if (getAddress(address) === getAddress(ctx.safe)) throw new Error('glavni Safe ne može biti projekt');
  await campaignsApi('POST', '', { campaign_id: campaignId, safe_address: address, label });
  S.np = null;
  S.removeLocal.delete(getAddress(address));
  await reloadContext();
  say(`projekt ${campaignId} upisan; plan ga dodaje u rolu`);
}

const npOwners = (np: NewProject) => np.owners.split(/[\s,;]+/).filter(Boolean);

/// Same CREATE2 plan as the Worker (safe-tx/lib/project-safe.mjs).
async function planNewSafe(np: NewProject) {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(np.id)) throw new Error('campaign_id: slova, brojke, - i _, 2–64 znaka');
  const version = ctx.safeVersion ?? (ctx.chain === 'chiado' ? '1.3.0' : '1.5.0');
  const plan = ps.projectSafePlan({
    version, owners: npOwners(np), threshold: Number(np.threshold), saltLabel: ps.projectSaltLabel(np.id),
    creationCode: await ps.readProxyCreationCode(pub, version),
  });
  S.npPlan = { address: plan.address, deployed: await ps.hasCode(pub, plan.address) };
  return plan;
}

async function projectsApi(body: unknown): Promise<{ ok: boolean; status: number; j: Record<string, unknown> }> {
  const r = await fetch(`/admin/api/tenants/${encodeURIComponent(ctx.tenantId)}/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/// One flow: plan → deploy (Worker key, or the connected wallet when the
/// Worker has none) → the Worker checks code, owners and ERC-1271, links the
/// Safe in the tenant's Monerium account and writes campaign + whitelist.
async function addNewProject(np: NewProject): Promise<void> {
  const plan = await planNewSafe(np);
  const body = { campaign_id: np.id, label: np.label, owners: npOwners(np), threshold: Number(np.threshold) };
  if (!S.npPlan!.deployed && !ctx.deployer) {
    const s = S.signer;
    if (!s) throw new Error('Worker nema deployer ključ za ovaj lanac: spoji MetaMask (plaća gas deploya)');
    if (s.kind === 'metamask') await ensureChain(s.wallet);
    say(`deployam Safe ${plan.address} iz ${short(s.address)}…`);
    const account = s.kind === 'local' ? s.wallet.account! : s.address;
    const { request } = await pub.simulateContract({ account, address: plan.factory, abi: ps.FACTORY_ABI, functionName: 'createProxyWithNonce', args: plan.args });
    const hash = await s.wallet.writeContract({ ...request, account, chain } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`deploy nije uspio: ${hash}`);
    say(`Safe deployan: ${hash}`);
  } else if (!S.npPlan!.deployed) {
    say(`Worker deploya Safe ${plan.address} (gas: ${short(ctx.deployer!)})…`);
  }
  const r = await projectsApi({ ...body, deploy: !!ctx.deployer });
  if (!r.ok) {
    const detail = r.j.detail ? `: ${String(r.j.detail)}` : '';
    throw new Error(`${String(r.j.error ?? `HTTP ${r.status}`)}${detail}`);
  }
  if (String(r.j.safe_address).toLowerCase() !== plan.address.toLowerCase()) throw new Error('Worker je izračunao drugu adresu Safe-a — prekid');
  S.npDone = {
    campaignId: np.id,
    safe: getAddress(String(r.j.safe_address)),
    deployTx: (r.j.deploy_tx as string | null) ?? null,
    deployer: (r.j.deployer as string | null) ?? null,
    monerium: r.j.monerium as ProjectDone['monerium'],
    name: r.j.monerium_name as ProjectDone['name'],
  };
  S.np = null; S.npPlan = null;
  await reloadContext();
  say(`projekt ${np.id}: Safe ${S.npDone.safe}, Monerium ${S.npDone.monerium.already ? 'već povezan' : S.npDone.monerium.state}; plan ga dodaje u rolu`);
}

async function removeCampaign(campaignId: string): Promise<void> {
  await campaignsApi('DELETE', `/${encodeURIComponent(campaignId)}`);
  await reloadContext();
  say(`kampanja ${campaignId} opozvana; plan je uklanja iz role`);
}

async function propose(): Promise<void> {
  const s = S.signer!;
  if (!isOwner(s.address)) throw new Error('predlaže vlasnik Safe-a');
  if (!S.sim?.success) throw new Error('simulacija nije prošla — ne predlažem');
  const nonce = nextNonce(S.nonce, await queuedSafeTxs(ctx.chainId, ctx.safe));
  say(`potpisujem prijedlog (nonce ${nonce})…`);
  const { hash, signature } = await signSafeTx(nonce);
  await proposeToService(ctx.chainId, {
    safe: ctx.safe, tx: S.tx, nonce, hash, sender: s.address, signature,
    origin: `MPT setup dApp: ${ROLE} (${ctx.tenantId})`,
  });
  say(`prijedlog u redu Safe-a: ${hash}`);
}

async function confirm(): Promise<void> {
  const p = S.pending!;
  if (!isOwner(S.signer!.address)) throw new Error('potvrđuje vlasnik Safe-a');
  say(`potpisujem potvrdu (nonce ${p.nonce})…`);
  const { hash, signature } = await signSafeTx(p.nonce);
  if (hash.toLowerCase() !== p.hash.toLowerCase()) throw new Error('hash u redu se ne slaže s planom');
  await confirmOnService(ctx.chainId, hash, signature);
  say('potvrda poslana');
}

/// execTransaction from the connected account. An owner who has not signed
/// yet counts itself by sending (pre-validated signature), so the last owner
/// signs and executes in one step.
async function execute(): Promise<void> {
  const p = S.pending!;
  const s = S.signer!;
  if (p.nonce !== S.nonce) throw new Error(`na redu je nonce ${S.nonce}, ovaj prijedlog ima ${p.nonce}`);
  const fresh = await getSafeTx(ctx.chainId, p.hash);
  const sigs = (fresh?.confirmations ?? p.confirmations).map((c: { owner: string; signature: Hex }) => ({ signer: getAddress(c.owner), data: c.signature }))
    .filter((c: { signer: Address }) => isOwner(c.signer));
  if (isOwner(s.address) && !sigs.some((c: { signer: Address }) => c.signer === s.address)) {
    sigs.push({ signer: s.address, data: preValidatedSignature(s.address) as Hex });
  }
  if (BigInt(sigs.length) < S.threshold) throw new Error(`${sigs.length}/${S.threshold} potpisa — još nije dovoljno`);
  const signatures = packSignatures(pickThreshold(sigs, s.address)) as Hex;
  const tx = S.tx!;
  const args = [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', signatures] as const;
  const bal = await pub.getBalance({ address: s.address });
  if (bal === 0n) throw new Error(`${short(s.address)} nema xDAI za gas`);
  if (s.kind === 'metamask') await ensureChain(s.wallet);
  say('simuliram execTransaction…');
  const { request } = await pub.simulateContract({ account: s.kind === 'local' ? s.wallet.account! : s.address, address: getAddress(ctx.safe), abi: SAFE_TX_ABI, functionName: 'execTransaction', args });
  const txHash = await s.wallet.writeContract({ ...request, account: s.kind === 'local' ? s.wallet.account! : s.address, chain } as never);
  say(`poslano: ${txHash}`);
  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  const okLog = rc.logs.some((l) => l.address.toLowerCase() === ctx.safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS);
  say(rc.status === 'success' && okLog ? `izvršeno u bloku ${rc.blockNumber} (ExecutionSuccess)` : `transakcija bez ExecutionSuccess — provjeri ${txHash}`);
}

/// The Worker's gas key sends execTransaction for a tx already signed to
/// threshold; it only pays gas (ADR 0027, src/setup/execute.ts).
async function executeByMpt(): Promise<void> {
  const p = S.pending!;
  say(`izvršava MPT (gas: ${short(ctx.deployer!)})…`);
  const r = await fetch(`/admin/api/tenants/${encodeURIComponent(ctx.tenantId)}/setup/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ safe_tx_hash: p.hash }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; detail?: string; tx_hash?: string; block?: string };
  if (!r.ok) throw new Error(`${j.error ?? `HTTP ${r.status}`}${j.detail ? `: ${j.detail}` : ''}${j.tx_hash ? ` (${j.tx_hash})` : ''}`);
  say(`izvršeno u bloku ${j.block}: ${j.tx_hash}`);
}

/// Exactly `threshold` signatures, keeping the executor's own when it has one.
function pickThreshold(sigs: { signer: Address; data: Hex }[], me: Address) {
  const mine = sigs.filter((x) => x.signer === me);
  const rest = sigs.filter((x) => x.signer !== me);
  return [...mine, ...rest].slice(0, Number(S.threshold));
}

async function run(label: string, f: () => Promise<void> | void): Promise<void> {
  if (S.busy) return;
  S.busy = true; S.error = null; render();
  try {
    await f();
    await refresh();
  } catch (err) {
    S.error = `${label}: ${(err as Error).message.split('\n')[0]}`;
    say(S.error);
  } finally {
    S.busy = false; render();
  }
}

// ── render ────────────────────────────────────────────────────────────────

function describeCall(t: { to: string; data: Hex; _label: string }): string {
  try {
    if (t._label === 'Safe.enableModule') return `Safe.enableModule(${short(ctx.roles!)}) — Roles postaje modul Safe-a`;
    const d = decodeFunctionData({ abi: ROLES_ABI, data: t.data });
    const a = d.args as readonly unknown[];
    if (d.functionName === 'scopeTarget') return `scopeTarget(${ROLE}, EURe ${short(String(a[1]))})`;
    if (d.functionName === 'revokeTarget') return `revokeTarget(${short(String(a[0]))}, ${short(String(a[1]))})`;
    if (d.functionName === 'scopeFunction') return `scopeFunction(${ROLE}, EURe.transfer, to ∈ ${S.plan!.recipients.length} projekata, iznos bez kapice, bez value/delegatecall)`;
    if (d.functionName === 'assignRoles') return `assignRoles(${short(String(a[0]))} → ${ROLE} = ${(a[2] as boolean[])[0]})`;
  } catch { /* fall through */ }
  return t._label;
}

function npDefaults(): NewProject {
  return { mode: 'new', id: '', label: '', addr: '', owners: (ctx.defaultOwners ?? []).join('\n'), threshold: String(ctx.defaultThreshold ?? 2) };
}

function renderNewProject(dis: string): string {
  const np = S.np ?? npDefaults();
  const d = S.npDone;
  const done = d ? `<div class="box"><p class="ok">Projekt ${e(d.campaignId)} dodan: ${addrLink(d.safe)}</p>
<p class="muted">${d.deployTx ? `Deploy ${e(short(d.deployTx))} (gas: ${e(d.deployer ? short(d.deployer) : 'MetaMask')}). ` : ''}Monerium: ${d.monerium.already ? 'već povezan' : e(d.monerium.state)}. Router ga smije plaćati tek kad 2/3 vlasnika potpiše plan ispod.</p>
<p>Ime adrese u Moneriumu (API ga ne dopušta, treba web sesija): otvori <a href="${e(d.name.ui)}" target="_blank" rel="noopener">${e(d.name.ui)}</a>, prijavi se i zalijepi u konzolu:</p>
<input class="mono" readonly value="${e(d.name.snippet)}"/></div>` : '';
  const radio = (m: NewProject['mode'], t: string) => `<label><input type="radio" name="npMode" value="${m}" ${np.mode === m ? 'checked' : ''} style="width:auto"/> ${t}</label> `;
  const common = `<input id="npId" class="mono" placeholder="campaign_id (npr. domovinatv-novi-projekt)" value="${e(np.id)}"/>
<input id="npLabel" placeholder="naziv projekta" value="${e(np.label)}"/>`;
  if (np.mode === 'existing') {
    return `${done}<p>${radio('new', 'Novi Safe')}${radio('existing', 'Postojeći Safe')}</p>
<p class="muted">Upis u D1 (kampanja + payout whitelista) za Safe koji već postoji. Monerium link radiš sam.</p>
${common}
<input id="npAddr" class="mono" placeholder="0x… adresa (Safe) projekta" value="${e(np.addr)}"/>
<p><button id="npBtn" ${dis}>Dodaj projekt</button></p>`;
  }
  const gas = ctx.deployer ? `Deploy plaća Worker (${addrLink(ctx.deployer)}).` : 'Worker nema deployer ključ za ovaj lanac: deploy plaća spojeni MetaMask.';
  const plan = S.npPlan ? `<p>Adresa: ${addrLink(S.npPlan.address)} <span class="muted">${S.npPlan.deployed ? 'već deployan' : 'još nije deployan'}</span></p>` : '';
  return `${done}<p>${radio('new', 'Novi Safe')}${radio('existing', 'Postojeći Safe')}</p>
<p class="muted">Safe projekta (salt <span class="mono">project:&lt;campaign_id&gt;</span>, Safe ${e(ctx.safeVersion ?? '')}) rodi se s potpisanom Monerium porukom.
Worker zatim provjeri kod, vlasnike i ERC-1271, poveže adresu u Monerium račun tenanta i upiše kampanju + whitelistu. ${gas}</p>
${common}
<label class="muted">Vlasnici (jedna adresa po retku)</label>
<textarea id="npOwners" class="mono" rows="3">${e(np.owners)}</textarea>
<label class="muted">Prag</label> <input id="npThreshold" value="${e(np.threshold)}" style="width:5em"/>
${plan}
<p><button id="npPlanBtn" class="sec" ${dis}>Izračunaj adresu</button> <button id="npBtn" ${dis}>Dodaj projekt</button></p>`;
}

function readNp(): NewProject {
  const v = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? '';
  const mode = (document.querySelector<HTMLInputElement>('input[name="npMode"]:checked')?.value ?? 'new') as NewProject['mode'];
  const prev = S.np ?? npDefaults();
  return { mode, id: v('npId'), label: v('npLabel'), addr: v('npAddr') || prev.addr, owners: v('npOwners') || prev.owners, threshold: v('npThreshold') || prev.threshold };
}

function render(): void {
  const s = S.signer;
  const owner = isOwner(s?.address);
  const p = S.pending;
  const signed = p && s ? p.confirmations.some((c) => c.owner === s.address) : false;
  const have = p ? p.confirmations.filter((c) => isOwner(c.owner)).length : 0;
  const canMptExec = !!p && !!ctx.deployer && p.nonce === S.nonce && have >= Number(S.threshold);
  const canExec = !!p && !!s && p.nonce === S.nonce && (have >= Number(S.threshold) || (owner && !signed && have + 1 >= Number(S.threshold)));
  const dis = S.busy ? 'disabled' : '';
  const safeApp = `https://app.safe.global/transactions/queue?safe=${(SAFE_CHAINS as Record<number, { app: string }>)[ctx.chainId]?.app}:${ctx.safe}`;

  const before = S.plan?.before ?? [];
  const rows = [...before];
  for (const r of ctx.recipients) if (!rows.some((x) => x.toLowerCase() === r.address.toLowerCase())) rows.push(r.address);
  const recRows = rows.map((r) => {
    const has = (l?: string[]) => !!l?.some((x) => x.toLowerCase() === r.toLowerCase());
    const status = has(S.plan?.removed) ? '<span class="bad">uklanja se</span>'
      : has(S.plan?.added) ? '<span class="muted">dodaje se</span>'
        : has(before) ? '<span class="ok">na lancu</span>' : '<span class="muted">čeka plan</span>';
    const cmp = campaignOf(r);
    const local = S.removeLocal.has(getAddress(r));
    const act = cmp ? `<button class="sec rmCamp" data-cid="${e(cmp.campaignId)}" ${dis}>Ukloni</button>`
      : revokedOf(r) ? '<span class="muted">opozvana u D1</span>'
        : `<button class="sec rmLocal" data-addr="${e(getAddress(r))}" ${dis}>${local ? 'Vrati' : 'Ukloni s lanca'}</button>`;
    const name = cmp ? `${e(cmp.label ?? cmp.campaignId)} <span class="muted mono">${e(cmp.campaignId)}</span>` : e(labelOf(r) ?? '— (samo na lancu)');
    return `<tr><td>${name}</td><td>${addrLink(r)}</td><td>${status}</td><td>${act}</td></tr>`;
  }).join('');

  app.innerHTML = `
<h2>Safe</h2>
<table><tbody>
<tr><th>Lanac</th><td>${e(chain.name)} (${ctx.chainId})</td></tr>
<tr><th>Glavni Safe</th><td>${addrLink(ctx.safe)} <span class="muted">v${e(S.version)}</span></td></tr>
<tr><th>Vlasnici</th><td>${S.owners.map((o) => `<div>${addrLink(o)}</div>`).join('')} <span class="muted">prag ${S.threshold}/${S.owners.length}, nonce ${S.nonce}</span></td></tr>
<tr><th>Roles modifier</th><td>${ctx.roles ? addrLink(ctx.roles) : '<span class="bad">nije postavljen — prvo tools/funding/deploy-roles.mjs</span>'}${S.fromBlock ? ` <span class="muted">od bloka ${S.fromBlock}</span>` : ''}</td></tr>
<tr><th>Router EOA</th><td><input id="router" class="mono" placeholder="0x… adresa router ključa" value="${e(S.router)}" ${ctx.router ? 'readonly' : ''}/></td></tr>
${ctx.roleKey && ctx.roleKey.toLowerCase() !== roleKeyOf(ROLE).toLowerCase() ? `<tr><th>Role key</th><td class="bad">rail ima ${e(ctx.roleKey)}, očekivano ${ROLE}</td></tr>` : ''}
</tbody></table>

<h2>Potpisnik</h2>
<div class="box">
${s ? `<p>${s.kind === 'metamask' ? 'MetaMask' : 'Lokalni ključ (sandbox)'}: ${addrLink(s.address)} ${owner ? '<span class="ok">vlasnik</span>' : '<span class="bad">nije vlasnik — može samo izvršiti</span>'}
<span class="muted">${S.balance === null ? '' : `${formatEther(S.balance)} xDAI za gas`}</span></p>` : '<p class="muted">Nije spojen.</p>'}
<button id="mm" ${dis}>Spoji MetaMask</button>
${ctx.chain === 'chiado' ? `<details><summary class="muted">Lokalni ključ (samo sandbox)</summary>
<p class="muted">Generirani testni ključ vlasnika. Ostaje samo u memoriji ove kartice.</p>
<input id="pk" type="password" autocomplete="off" class="mono" placeholder="0x… privatni ključ"/> <button id="pkBtn" class="sec" ${dis}>Učitaj</button></details>` : ''}
</div>

<h2>Projekti (primatelji role ${ROLE})</h2>
<table><tbody>${recRows || '<tr><td class="muted">Tenant nema kampanja.</td></tr>'}</tbody></table>
<details class="box" ${S.np || S.npDone ? 'open' : ''}><summary>Dodaj projekt</summary>
${renderNewProject(dis)}</details>

<h2>Plan</h2>
${!S.plan ? '<p class="muted">Čitam lanac…</p>' : S.plan.txs.length === 0 ? '<p class="ok">Lanac je usklađen: nema koraka.</p>' : `
<ol class="steps">${S.plan.txs.map((t) => `<li class="mono">${e(describeCall(t))}</li>`).join('')}</ol>
${S.plan.notes.map((n) => `<p class="muted">${e(n)}</p>`).join('')}
<p>Simulacija kao Safe: ${S.sim ? (S.sim.success ? `<span class="ok">prolazi</span> <span class="muted">(~${S.sim.gas} gas)</span>` : '<span class="bad">pada — ne potpisivati</span>') : '…'}</p>
${p ? `<div class="box"><p>U redu Safe-a: nonce ${p.nonce}, potpisa ${have}/${S.threshold} <span class="mono muted">${e(p.hash)}</span></p>
${p.confirmations.map((c) => `<div class="mono">✓ ${e(c.owner)}</div>`).join('')}
${p.nonce !== S.nonce ? `<p class="muted">Prije njega se moraju izvršiti transakcije s nonceom ${S.nonce}…${p.nonce - 1n}.</p>` : ''}
<button id="confirm" ${dis || !s || !owner || signed ? 'disabled' : ''}>Potpiši</button>
${ctx.deployer ? `<button id="mptExec" ${dis || !canMptExec ? 'disabled' : ''}>Izvrši, MPT plaća gas</button>` : ''}
<button id="exec" class="${ctx.deployer ? 'sec' : ''}" ${dis || !canExec ? 'disabled' : ''}>${owner && !signed ? 'Potpiši i izvrši' : 'Izvrši'} iz MetaMaska</button>
<a href="${safeApp}" target="_blank" rel="noopener">otvori u app.safe.global</a></div>`
    : `<button id="propose" ${dis || !s || !owner || !S.sim?.success ? 'disabled' : ''}>Predloži i potpiši</button>
${!s ? '<span class="muted">prvo spoji MetaMask (Potpisnik gore)</span>' : !owner ? '<span class="bad">spojeni račun nije vlasnik Safe-a — odaberi vlasnika u MetaMasku</span>' : S.sim && !S.sim.success ? '<span class="bad">simulacija pada</span>' : ''}`}`}

${S.checks.length ? `<h2>Provjera role (eth_call kao router, 1 wei)</h2><table><tbody>${S.checks.map((c) =>
    `<tr><td>${e(c.label)}</td><td class="mono">${e(short(c.address))}</td><td>${c.expect ? 'mora proći' : 'mora pasti'}</td><td>${c.ok ? '<span class="ok">✓</span>' : `<span class="bad">✗</span> <span class="muted">${e(c.why ?? '')}</span>`}</td></tr>`).join('')}</tbody></table>` : ''}

${S.error ? `<p class="bad">${e(S.error)}</p>` : ''}
<p><button id="reload" class="sec" ${dis}>Osvježi s lanca</button></p>
${S.log.length ? `<div class="log">${e(S.log.join('\n'))}</div>` : ''}`;

  const on = (id: string, f: () => void) => document.getElementById(id)?.addEventListener('click', f);
  on('mm', () => run('MetaMask', connectMetaMask));
  on('pkBtn', () => run('Lokalni ključ', () => loadLocalKey((document.getElementById('pk') as HTMLInputElement).value)));
  on('propose', () => run('Prijedlog', propose));
  on('confirm', () => run('Potvrda', confirm));
  on('exec', () => run('Izvršenje', execute));
  on('mptExec', () => run('Izvršenje (MPT)', executeByMpt));
  on('reload', () => run('Osvježavanje', async () => {}));
  document.querySelectorAll<HTMLInputElement>('input[name="npMode"]').forEach((r) => r.addEventListener('change', () => {
    S.np = { ...readNp(), mode: r.value as NewProject['mode'] };
    S.npPlan = null;
    render();
  }));
  on('npPlanBtn', () => {
    const np = readNp();
    S.np = np;
    void run('Adresa', async () => { await planNewSafe(np); });
  });
  on('npBtn', () => {
    const np = readNp();
    S.np = np; S.npDone = null;
    void run('Novi projekt', () => (np.mode === 'existing' ? addExisting(np.id, np.label, np.addr) : addNewProject(np)));
  });
  document.querySelectorAll<HTMLButtonElement>('button.rmCamp').forEach((b) => b.addEventListener('click', () => {
    const cid = b.dataset.cid!;
    if (window.confirm(`Opozvati kampanju ${cid}? Plan će je ukloniti iz role; na lancu vrijedi tek nakon 2/3 potpisa.`)) void run('Uklanjanje', () => removeCampaign(cid));
  }));
  document.querySelectorAll<HTMLButtonElement>('button.rmLocal').forEach((b) => b.addEventListener('click', () => {
    const a = getAddress(b.dataset.addr!);
    if (S.removeLocal.has(a)) S.removeLocal.delete(a); else S.removeLocal.add(a);
    void run('Plan', async () => {});
  }));
  document.getElementById('router')?.addEventListener('change', (ev) => {
    S.router = (ev.target as HTMLInputElement).value.trim();
    run('Router', async () => {
      if (S.router && !isAddress(S.router)) throw new Error('router nije adresa');
    });
  });
}

run('Učitavanje', autoConnect);
