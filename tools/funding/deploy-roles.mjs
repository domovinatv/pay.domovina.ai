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
//
// Chiado zamka (16. 10. 2026.): mastercopy Roles v2 postoji, ali njegove vanjske
// biblioteke Packer (0x61c5…8a8c) i Integrity (0x6a6A…1049) nisu deployane, pa
// scopeFunction revertira ("call to non-contract"). Obje su na Gnosisu deployane
// kroz singleton factory 0xce00…cf9f (CREATE2), pa ih ovaj alat ponovi s točnim
// calldata iz Gnosis tx-a: ista adresa, isti kod (provjerava se hash koda).
import { parseArgs } from 'node:util';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, concat, getContractAddress, toHex, parseEventLogs, parseAbiItem } from 'viem';
import { gnosis } from 'viem/chains';
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

// Libraries the mastercopy calls (DELEGATECALL-free external library calls).
const ROLES_LIBS = [
  { name: 'Packer', address: '0x61c5b1be435391fdd7bc6703f3740c0d11728a8c', gnosisTx: '0xbdcf06917bde21a6b77f4408d35633c5f84c37e8b752041673d0687cfa008a1e' },
  { name: 'Integrity', address: '0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049', gnosisTx: '0x8f813b0d3e65e7403e9486e6d49620b77e87e0fbff228a7fc1ccdacaf17c3d5c' },
];
const SINGLETON_FACTORY = '0xce0042B868300000d44A59004Da54A005ffdcf9f';
const gno = createPublicClient({ chain: gnosis, transport: http('https://rpc.gnosischain.com') });
for (const lib of ROLES_LIBS) {
  const addr = getAddress(lib.address);
  const want = keccak256(await gno.getCode({ address: addr }));
  const have = await c.pub.getCode({ address: addr });
  if (have && have !== '0x') {
    if (keccak256(have) !== want) throw new Error(`${lib.name} ${addr} postoji, ali kod se razlikuje od Gnosisa`);
    console.log(`${lib.name.padEnd(10)}: ${addr} ✓`);
    continue;
  }
  if (a.dry) { console.log(`${lib.name.padEnd(10)}: ${addr} NEDOSTAJE (dry run)`); continue; }
  if (!c.wallet) throw new Error(`nema DEPLOYER_PRIVATE_KEY u .env.${a.env}`);
  const src = await gno.getTransaction({ hash: lib.gnosisTx });
  if (getAddress(src.to) !== SINGLETON_FACTORY) throw new Error(`${lib.name}: izvorni tx nije na singleton factory`);
  // Explicit gas: the factory does not revert when CREATE2 runs out of gas, so
  // an estimate happily returns a limit that deploys nothing.
  const hash = await c.wallet.sendTransaction({ to: SINGLETON_FACTORY, data: src.input, gas: 3_000_000n });
  await c.pub.waitForTransactionReceipt({ hash });
  const code = await c.pub.getCode({ address: addr });
  if (!code || keccak256(code) !== want) throw new Error(`${lib.name}: deploy ${hash} nije dao isti kod na ${addr}`);
  console.log(`${lib.name.padEnd(10)}: ${addr} deployan ${c.cfg.explorer}/tx/${hash}`);
}

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
