/**
 * Zodiac Roles v2 — the pieces the safe-tx generators and tools/funding share.
 *
 * Verified 2026-10-16 against the verified source of the mastercopy behind
 * every Roles proxy we use (Gnosis + Chiado):
 *   0x9646fDAD06d3e24444381f44362a3B0eB343D337, solc 0.8.21
 *   contracts/Types.sol      — enum values below
 *   contracts/Integrity.sol  — tree rules: a logical node (And/Or/Nor) MUST
 *     have paramType None and ≥1 child; Static/Dynamic nodes have no
 *     children; BFS order (parents non-decreasing); exactly one root, [0].
 * A wrong enum value does not fail loudly — it grants a DIFFERENT permission —
 * so these are not to be edited without re-reading the deployed source.
 */
import {
  getAddress,
  isAddress,
  pad,
  parseAbiItem,
  stringToHex,
  toFunctionSelector,
} from 'viem';

export const ParameterType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 };
export const Operator = { Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualTo: 16, GreaterThan: 17, LessThan: 18 };
/// None = plain Call without xDAI value. Send = value allowed (NOT "call
/// only"), DelegateCall = delegatecall allowed.
export const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 };

export const ROLES_MASTERCOPY = '0x9646fDAD06d3e24444381f44362a3B0eB343D337';
export const MODULE_PROXY_FACTORY = '0x000000000000aDdB49795b0f9bA5BC298cDda236';
export const SENTINEL = '0x0000000000000000000000000000000000000001';
export const TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)');

const CONDITION_COMPONENTS = [
  { name: 'parent', type: 'uint8' },
  { name: 'paramType', type: 'uint8' },
  { name: 'operator', type: 'uint8' },
  { name: 'compValue', type: 'bytes' },
];

export const ROLES_ABI = [
  { type: 'function', name: 'scopeTarget', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }] },
  { type: 'function', name: 'revokeTarget', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }] },
  { type: 'function', name: 'scopeFunction', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'roleKey', type: 'bytes32' },
      { name: 'targetAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'conditions', type: 'tuple[]', components: CONDITION_COMPONENTS },
      { name: 'options', type: 'uint8' },
    ] },
  { type: 'function', name: 'assignRoles', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'module', type: 'address' },
      { name: 'roleKeys', type: 'bytes32[]' },
      { name: 'memberOf', type: 'bool[]' },
    ] },
  { type: 'function', name: 'execTransactionWithRole', stateMutability: 'nonpayable',
    outputs: [{ name: 'success', type: 'bool' }],
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'avatar', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'target', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

export const SCOPE_FUNCTION_EVENT = parseAbiItem(
  'event ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
);
export const ASSIGN_ROLES_EVENT = parseAbiItem('event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)');

export const SAFE_ABI = [
  { type: 'function', name: 'enableModule', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'module', type: 'address' }] },
  { type: 'function', name: 'disableModule', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'prevModule', type: 'address' }, { name: 'module', type: 'address' }] },
  { type: 'function', name: 'getModulesPaginated', stateMutability: 'view',
    inputs: [{ name: 'start', type: 'address' }, { name: 'pageSize', type: 'uint256' }],
    outputs: [{ name: 'array', type: 'address[]' }, { name: 'next', type: 'address' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

/// Role names are right-padded ASCII in bytes32 (ROLE_KEY in wrangler.toml).
export function roleKeyOf(name) {
  return stringToHex(name, { size: 32 });
}

function word(addr) {
  return pad(getAddress(addr).toLowerCase(), { size: 32 });
}

/// Normalise + dedupe a recipient list, refusing anything that is not an
/// address or equals the Safe itself (a memo to the main Safe is a no-op,
/// never a transfer target).
export function normaliseRecipients(list, { safe } = {}) {
  const seen = new Map();
  for (const r of list) {
    if (!isAddress(r, { strict: false })) throw new Error(`not an EVM address: ${r}`);
    const a = getAddress(r.toLowerCase());
    if (safe && a.toLowerCase() === safe.toLowerCase()) {
      throw new Error(`the main Safe ${a} must not be a recipient`);
    }
    seen.set(a.toLowerCase(), a);
  }
  if (seen.size === 0) throw new Error('at least one recipient is required');
  return [...seen.values()].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
}

/// Flattened (BFS) condition tree for `transfer(address to, uint256 amount)`:
///
///   [0]  Calldata Matches          root
///   [1]  None     Or               `to`   (Static EqualTo when one recipient)
///   [2]  Static   Pass | LessThan  `amount`
///   [3…] Static   EqualTo rᵢ       children of [1]
///
/// `capWei` (bigint) adds a strict per-transfer cap; ADR 0026 uses none.
export function transferRecipientConditions(recipients, { capWei = null } = {}) {
  if (recipients.length === 0) throw new Error('at least one recipient is required');
  if (recipients.length > 250) throw new Error('more than 250 recipients do not fit a uint8-parented tree');
  const c = [{ parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: '0x' }];
  if (recipients.length === 1) {
    c.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: word(recipients[0]) });
  } else {
    c.push({ parent: 0, paramType: ParameterType.None, operator: Operator.Or, compValue: '0x' });
  }
  c.push(capWei === null
    ? { parent: 0, paramType: ParameterType.Static, operator: Operator.Pass, compValue: '0x' }
    : { parent: 0, paramType: ParameterType.Static, operator: Operator.LessThan, compValue: pad(`0x${capWei.toString(16)}`, { size: 32 }) });
  if (recipients.length > 1) {
    for (const r of recipients) {
      c.push({ parent: 1, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: word(r) });
    }
  }
  return c;
}

/// Inverse of transferRecipientConditions for the trees WE write: returns the
/// allowed `to` set, or throws when the tree has any other shape (then a
/// human must look — never extend a tree we do not understand).
export function recipientsFromConditions(conditions) {
  const c = conditions.map((x) => ({ ...x, parent: Number(x.parent), paramType: Number(x.paramType), operator: Number(x.operator) }));
  const fail = (why) => { throw new Error(`unexpected ProjectRouter condition tree: ${why}`); };
  if (c.length < 3) fail('fewer than 3 nodes');
  if (c[0].paramType !== ParameterType.Calldata || c[0].operator !== Operator.Matches) fail('root');
  const amount = c[2];
  if (amount.parent !== 0 || amount.paramType !== ParameterType.Static) fail('amount node');
  if (amount.operator !== Operator.Pass) fail('amount is constrained (ADR 0026 has no cap)');
  const to = c[1];
  if (to.parent !== 0) fail('to node');
  const asAddr = (n) => {
    if (n.paramType !== ParameterType.Static || n.operator !== Operator.EqualTo) fail('leaf');
    return getAddress(`0x${n.compValue.slice(-40)}`);
  };
  if (to.operator === Operator.EqualTo) {
    if (c.length !== 3) fail('extra nodes after a single EqualTo');
    return [asAddr(to)];
  }
  if (to.paramType !== ParameterType.None || to.operator !== Operator.Or) fail('to is neither EqualTo nor Or');
  const leaves = c.slice(3);
  if (leaves.length === 0 || leaves.some((n) => n.parent !== 1)) fail('Or children');
  return leaves.map(asAddr);
}

const TARGET_EVENTS = [
  parseAbiItem('event ScopeTarget(bytes32 roleKey, address targetAddress)'),
  parseAbiItem('event RevokeTarget(bytes32 roleKey, address targetAddress)'),
  parseAbiItem('event AllowTarget(bytes32 roleKey, address targetAddress, uint8 options)'),
];
const FUNCTION_EVENTS = [
  SCOPE_FUNCTION_EVENT,
  parseAbiItem('event AllowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)'),
  parseAbiItem('event RevokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)'),
];

/// Current recipient set of `role` on EURe.transfer, replayed from the
/// modifier's permission events (the chain is the source of truth, ADR 0026 —
/// not the repo, not D1). Returns null when the role has never been scoped
/// on EURe.transfer. Throws when the effective permission is anything other
/// than "target scoped + transfer scoped by a tree we understand" — e.g. a
/// later allowFunction (unconditional) or revokeTarget. A human must look
/// before anyone extends such a role.
export async function readRecipientSet(client, { roles, roleKey, eure, fromBlock, chunk = 200_000n }) {
  const head = await client.getBlockNumber();
  const key = roleKey.toLowerCase();
  const target = getAddress(eure);
  let lastTarget = null;
  let lastFunction = null;
  for (let from = BigInt(fromBlock); from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({
      address: getAddress(roles),
      events: [...TARGET_EVENTS, ...FUNCTION_EVENTS],
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      const { eventName, args } = l;
      if (!args || args.roleKey.toLowerCase() !== key || getAddress(args.targetAddress) !== target) continue;
      const at = { eventName, args, blockNumber: l.blockNumber, txHash: l.transactionHash };
      if (eventName.endsWith('Target')) lastTarget = at;
      else if (args.selector.toLowerCase() === TRANSFER_SELECTOR) lastFunction = at;
    }
  }
  if (!lastFunction && !lastTarget) return null;
  if (lastTarget?.eventName !== 'ScopeTarget') {
    throw new Error(`EURe target on this role is ${lastTarget?.eventName ?? 'never scoped'} — expected ScopeTarget`);
  }
  if (lastFunction?.eventName !== 'ScopeFunction') {
    throw new Error(`EURe.transfer on this role is ${lastFunction?.eventName ?? 'never scoped'} — expected ScopeFunction`);
  }
  return {
    recipients: recipientsFromConditions(lastFunction.args.conditions),
    options: Number(lastFunction.args.options),
    blockNumber: lastFunction.blockNumber,
    txHash: lastFunction.txHash,
  };
}

/// Targets a role can still reach (last target event Scope/AllowTarget),
/// replayed from the modifier's events.
export async function readRoleTargets(client, { roles, roleKey, fromBlock, chunk = 200_000n }) {
  const head = await client.getBlockNumber();
  const key = roleKey.toLowerCase();
  const state = new Map();
  for (let from = BigInt(fromBlock); from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({ address: getAddress(roles), events: TARGET_EVENTS, fromBlock: from, toBlock: to });
    for (const l of logs) {
      if (!l.args || l.args.roleKey.toLowerCase() !== key) continue;
      state.set(getAddress(l.args.targetAddress), l.eventName !== 'RevokeTarget');
    }
  }
  return [...state].filter(([, live]) => live).map(([t]) => t);
}
