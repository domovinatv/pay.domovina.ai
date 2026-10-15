#!/usr/bin/env node
// deploy-roles: Zodiac Roles v2 proxy za glavni Safe (ADR 0026), bez dozvole vlasnika.
//
//   node deploy-roles.mjs --env sandbox [--safe 0x<glavni Safe>] [--dry]
//
// ModuleProxyFactory.deployModule(mastercopy, setUp(owner=avatar=target=Safe), salt)
// deploya minimal proxy verificiranog mastercopyja. Proxy ne radi ništa dok ga 2/3
// vlasnika ne uključe kao modul (batch safe-tx/009), pa ga smije deployati bilo tko,
// ovdje deployer EOA iz .env.<env>. Adresa i blok se upisuju u .env.<env>
// (PROJECT_ROUTER_ROLES, PROJECT_ROUTER_FROM_BLOCK). Idempotentno: isti salt daje
// istu adresu, a postojeći proxy se samo provjeri.
import { parseArgs } from 'node:util';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, concat, getContractAddress, toHex, parseEventLogs, parseAbiItem } from 'viem';
import { clients, loadEnv, saltFromLabel, setEnvVar } from './lib.mjs';
import { MODULE_PROXY_FACTORY, ROLES_ABI, ROLES_MASTERCOPY } from '../../backend/safe-tx/lib/roles-v2.mjs';
import { ENVS as TX_ENVS } from '../../backend/safe-tx/009-project-router-role.mjs';

const { values: a } = parseArgs({
  options: { env: { type: 'string', default: 'sandbox' }, safe: { type: 'string' }, dry: { type: 'boolean', default: false } },
});
const vars = loadEnv(a.env);
const chainEnv = a.env === 'prod' ? 'gnosis' : 'chiado';
const safe = getAddress(a.safe ?? vars.MAIN_SAFE ?? TX_ENVS[chainEnv].safe);
const c = clients(a.env, vars.DEPLOYER_PRIVATE_KEY);

const FACTORY_ABI = [{ type: 'function', name: 'deployModule', stateMutability: 'nonpayable',
  inputs: [{ name: 'masterCopy', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }],
  outputs: [{ name: 'proxy', type: 'address' }] }];
const SETUP_ABI = [{ type: 'function', name: 'setUp', stateMutability: 'nonpayable', inputs: [{ name: 'initParams', type: 'bytes' }], outputs: [] }];
const MODULE_PROXY_CREATION = parseAbiItem('event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)');

const initializer = encodeFunctionData({
  abi: SETUP_ABI, functionName: 'setUp',
  args: [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [safe, safe, safe])],
});
const saltNonce = saltFromLabel(`roles:project-router:${safe.toLowerCase()}`);
// ModuleProxyFactory: salt = keccak256(keccak256(initializer) ++ saltNonce), EIP-1167 bytecode.
const salt = keccak256(concat([keccak256(initializer), toHex(saltNonce, { size: 32 })]));
const bytecode = concat([
  '0x602d8060093d393df3363d3d373d3d3d363d73',
  ROLES_MASTERCOPY.toLowerCase(),
  '0x5af43d82803e903d91602b57fd5bf3',
]);
const predicted = getContractAddress({ opcode: 'CREATE2', from: MODULE_PROXY_FACTORY, salt, bytecode });

console.log(`Safe      : ${safe}`);
console.log(`Roles     : ${predicted} (predviđeno)`);
const code = await c.pub.getCode({ address: predicted });
if (code && code !== '0x') {
  console.log('već deployan');
} else if (a.dry) {
  console.log('dry run — nije deployano');
  process.exit(0);
} else {
  if (!c.wallet) throw new Error(`nema DEPLOYER_PRIVATE_KEY u .env.${a.env}`);
  const hash = await c.wallet.writeContract({
    address: MODULE_PROXY_FACTORY, abi: FACTORY_ABI, functionName: 'deployModule',
    args: [ROLES_MASTERCOPY, initializer, saltNonce],
  });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  const ev = parseEventLogs({ abi: [MODULE_PROXY_CREATION], logs: r.logs })[0];
  if (r.status !== 'success' || !ev || getAddress(ev.args.proxy) !== predicted) {
    throw new Error(`deploy nije uspio ili adresa ne odgovara (${hash})`);
  }
  console.log(`deployan ${c.cfg.explorer}/tx/${hash} (blok ${r.blockNumber})`);
  setEnvVar(a.env, 'PROJECT_ROUTER_FROM_BLOCK', String(r.blockNumber));
}
for (const f of ['owner', 'avatar', 'target']) {
  const v = await c.pub.readContract({ address: predicted, abi: ROLES_ABI, functionName: f });
  if (getAddress(v) !== safe) throw new Error(`Roles.${f}() = ${v}, očekivan ${safe}`);
}
console.log('owner = avatar = target = Safe ✓');
setEnvVar(a.env, 'PROJECT_ROUTER_ROLES', predicted);
if (!vars.PROJECT_ROUTER_FROM_BLOCK && code && code !== '0x') {
  console.log('PROJECT_ROUTER_FROM_BLOCK nije upisan: postavi ga ručno na blok deploya proxyja');
}
