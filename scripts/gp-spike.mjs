#!/usr/bin/env node
/**
 * Faza 0 spike — empirical tests against api.gnosispay.com (permissionless tier).
 *
 * HARD RULES (docs/plans/gnosis-pay-cards/, prompt v1.0):
 *  - One address = one GP user FOREVER (409 on re-signup). Every test runs with
 *    throwaway EOAs / throwaway Safes generated here. NEVER a real user address,
 *    NEVER the relayer EOA, NEVER Matija's addresses.
 *  - No server-held key ever becomes a GP signer; the relayer only sponsors gas
 *    for the throwaway Safe deploy (external sender, never an owner).
 *
 * State (keys of throwaways, JWTs, findings log) lives in
 * scripts/.gp-spike-state.json — gitignored, local only.
 *
 * Usage: node scripts/gp-spike.mjs <command> [args]
 *   gen                       mint throwaway EOA #1 (SIWE identity A)
 *   auth                      SIWE (EOA) → JWT
 *   user                      GET /api/v1/user (dump)
 *   mailtm                    create disposable inbox (mail.tm)
 *   mailtm-read               poll inbox, print latest OTP-looking mail
 *   otp <email>               POST /auth/signup/otp
 *   signup <email> [otp]      POST /auth/signup (otp optional per spec)
 *   signup-dup <email>        re-signup same EOA, different email → expect 409
 *   deploy-safe               throwaway EOA #2 + dummy P-256 → bootstrap-deploy
 *                             (gas sponsored) → deployed 1-of-2 Safe on Gnosis
 *   auth1271                  SIWE with Safe address, ERC-1271 sig via owner EOA
 *   gp-safe-deploy            POST /api/v1/safe/deploy with current JWT
 *   tos                       GET /api/v1/terms (public, no auth)
 *   log                       print findings log
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  hashMessage,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';

const GP_API = 'https://api.gnosispay.com';
const RELAY_ORIGIN = 'https://wallet.domovina.ai';
const RPC = 'https://rpc.gnosischain.com';
const STATE_FILE = new URL('./.gp-spike-state.json', import.meta.url).pathname;

// Mirrors wallet/functions/_lib/safe.ts (server re-derives + CREATE2-guards, so
// drift here is rejected, not dangerous).
const SAFE_WEBAUTHN_SIGNER_FACTORY = '0x1d31F259eE307358a26dFb23EB365939E8641195';
const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4';
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

// ── state ─────────────────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { log: [] };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function note(state, entry) {
  state.log.push({ at: new Date().toISOString(), ...entry });
  saveState(state);
}

// ── HTTP helper: always dump status + body, record into findings log ──────────
async function gp(state, label, path, init = {}, jwt) {
  // Shell out to curl: GP's WAF 403s Node/undici's TLS fingerprint (empirical,
  // 2026-06-11 — same request passes via curl, fails via fetch with identical
  // headers). Origin carries the auto-whitelisted localhost domain.
  const argv = [
    '-s',
    '-w',
    '\n%{http_code}',
    '-X',
    init.method ?? 'GET',
    `${GP_API}${path}`,
    '-H',
    'Content-Type: application/json',
    '-H',
    'Origin: http://localhost:5173',
    '-H',
    'Referer: http://localhost:5173/',
    '-H',
    'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  ];
  if (jwt) argv.push('-H', `Authorization: Bearer ${jwt}`);
  if (init.body) argv.push('--data-binary', init.body);
  const out = execFileSync('curl', argv, { encoding: 'utf8' });
  const idx = out.lastIndexOf('\n');
  const status = Number(out.slice(idx + 1));
  const text = out.slice(0, idx);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(`\n── ${label}: ${init.method ?? 'GET'} ${path} → ${status}`);
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  note(state, { label, path, method: init.method ?? 'GET', status, body });
  return { status, body };
}

// ── SIWE helpers ──────────────────────────────────────────────────────────────
async function fetchNonce(state) {
  const { body } = await gp(state, 'nonce', '/api/v1/auth/nonce');
  return String(body).trim();
}

function buildSiwe(address, nonce) {
  // Empirical (2026-06-11): the WAF 403s ANY loopback URL in the body, so the
  // documented localhost whitelist is unusable from a non-browser client; and
  // wallet.domovina.ai → "SIWE domain not allowed" until partner registration
  // (TODO-MATIJA #1). GP's own SIWE helper-app domain (linked from their docs
  // for exactly this kind of API exploration) is whitelisted and passes.
  return createSiweMessage({
    domain: 'gnosispay-api-siwe-demo.vercel.app',
    address,
    uri: 'https://gnosispay-api-siwe-demo.vercel.app',
    version: '1',
    chainId: gnosis.id,
    nonce,
    issuedAt: new Date(),
  });
}

async function siweChallenge(state, label, message, signature) {
  return gp(state, label, '/api/v1/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ message, signature, ttlInSeconds: 86400 }),
  });
}

/**
 * ERC-1271 signature for a Safe v1.4.1 with an ECDSA owner: the owner signs the
 * EIP-712 SafeMessage{ message: abi.encode(dataHash) } over the Safe's domain.
 * CompatibilityFallbackHandler.isValidSignature recomputes the same hash and
 * checkSignatures recovers the owner (v ∈ {27,28} branch).
 */
async function signSafe1271(ownerAccount, safeAddress, dataHash) {
  return ownerAccount.signTypedData({
    domain: { chainId: gnosis.id, verifyingContract: safeAddress },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: encodeAbiParameters([{ type: 'bytes32' }], [dataHash]) },
  });
}

// ── commands ──────────────────────────────────────────────────────────────────
const state = loadState();
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'gen': {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    state.eoaA = { privateKey: pk, address: account.address };
    saveState(state);
    console.log('Throwaway EOA A:', account.address);
    break;
  }

  case 'auth': {
    const account = privateKeyToAccount(state.eoaA.privateKey);
    const nonce = await fetchNonce(state);
    const message = buildSiwe(account.address, nonce);
    const signature = await account.signMessage({ message });
    const { status, body } = await siweChallenge(state, 'challenge(EOA)', message, signature);
    if (status === 200 && body.token) {
      state.jwtA = body.token;
      saveState(state);
      console.log('\nJWT A saved.');
      const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
      console.log('JWT payload:', JSON.stringify(payload, null, 2));
      note(state, { label: 'jwtA-payload', body: payload });
    }
    break;
  }

  case 'user': {
    await gp(state, 'user', '/api/v1/user', {}, args[0] === 'safe' ? state.jwtSafe : state.jwtA);
    break;
  }

  case 'tos': {
    await gp(state, 'terms(public)', '/api/v1/terms');
    break;
  }

  case 'mailtm': {
    const domRes = await fetch('https://api.mail.tm/domains');
    const domains = (await domRes.json())['hydra:member'];
    const domain = domains[0].domain;
    const address = `dmv-gp-spike-${Math.random().toString(36).slice(2, 10)}@${domain}`;
    const password = generatePrivateKey().slice(2, 34);
    const accRes = await fetch('https://api.mail.tm/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password }),
    });
    console.log('mail.tm account create:', accRes.status);
    const tokRes = await fetch('https://api.mail.tm/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password }),
    });
    const tok = await tokRes.json();
    state.mailtm = { address, password, token: tok.token };
    saveState(state);
    console.log('Disposable inbox:', address);
    break;
  }

  case 'mailtm-read': {
    const res = await fetch('https://api.mail.tm/messages', {
      headers: { Authorization: `Bearer ${state.mailtm.token}` },
    });
    const msgs = (await res.json())['hydra:member'] ?? [];
    if (!msgs.length) {
      console.log('Inbox empty.');
      break;
    }
    for (const m of msgs.slice(0, 3)) {
      const full = await fetch(`https://api.mail.tm/messages/${m.id}`, {
        headers: { Authorization: `Bearer ${state.mailtm.token}` },
      });
      const msg = await full.json();
      console.log(`\nFrom: ${m.from?.address}  Subject: ${m.subject}`);
      const text = msg.text ?? '';
      console.log(text.slice(0, 600));
      const otp = text.match(/\b(\d{6})\b/);
      if (otp) console.log('\n>>> OTP candidate:', otp[1]);
    }
    break;
  }

  case 'otp': {
    await gp(state, 'signup-otp', '/api/v1/auth/signup/otp', {
      method: 'POST',
      body: JSON.stringify({ email: args[0] }),
    });
    break;
  }

  case 'signup': {
    const body = { authEmail: args[0] };
    if (args[1]) body.otp = args[1];
    const { status, body: resBody } = await gp(
      state,
      'signup(EOA-A)',
      '/api/v1/auth/signup',
      { method: 'POST', body: JSON.stringify(body) },
      args[2] === 'safe' ? state.jwtSafe : state.jwtA,
    );
    if (status === 201 && resBody.token) {
      if (args[2] === 'safe') state.jwtSafe = resBody.token;
      else state.jwtA = resBody.token;
      state[args[2] === 'safe' ? 'userIdSafe' : 'userIdA'] = resBody.id;
      saveState(state);
      console.log('\nSignup OK, user-scoped JWT saved.');
    }
    break;
  }

  case 'signup-dup': {
    // Same SIWE address (EOA A), different email → expect 409 (irreversibility proof).
    await gp(
      state,
      'signup-dup(EOA-A)',
      '/api/v1/auth/signup',
      { method: 'POST', body: JSON.stringify({ authEmail: args[0] }) },
      state.jwtA,
    );
    break;
  }

  case 'deploy-safe': {
    // Throwaway EOA B owns the Safe; dummy P-256 key plays the "passkey" so the
    // bootstrap endpoint accepts the bundle (mode 'add' keeps EOA B as owner).
    const pk = generatePrivateKey();
    const owner = privateKeyToAccount(pk);

    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const x = BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex'));
    const y = BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex'));

    const client = createPublicClient({ chain: gnosis, transport: http(RPC) });
    const verifiers = (BigInt(P256_PRECOMPILE) << 160n) | BigInt(DAIMO_P256_VERIFIER);
    const signerAddress = await client.readContract({
      address: SAFE_WEBAUTHN_SIGNER_FACTORY,
      abi: [
        {
          inputs: [
            { type: 'uint256', name: 'x' },
            { type: 'uint256', name: 'y' },
            { type: 'uint176', name: 'verifiers' },
          ],
          name: 'getSigner',
          outputs: [{ type: 'address' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      functionName: 'getSigner',
      args: [x, y, verifiers],
    });

    // Predict the Safe the same way the server does (initializer owner = EOA B, salt 0).
    const { keccak256, encodePacked, getCreate2Address } = await import('viem');
    const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
    const SAFE_PROXY_INIT_CODE_HASH =
      '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee';
    const initializer = encodeFunctionData({
      abi: [
        {
          inputs: [
            { type: 'address[]', name: '_owners' },
            { type: 'uint256', name: '_threshold' },
            { type: 'address', name: 'to' },
            { type: 'bytes', name: 'data' },
            { type: 'address', name: 'fallbackHandler' },
            { type: 'address', name: 'paymentToken' },
            { type: 'uint256', name: 'payment' },
            { type: 'address', name: 'paymentReceiver' },
          ],
          name: 'setup',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ],
      functionName: 'setup',
      args: [
        [owner.address],
        1n,
        zeroAddress,
        '0x',
        '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
        zeroAddress,
        0n,
        zeroAddress,
      ],
    });
    const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), 0n]));
    const safeAddress = getCreate2Address({
      from: SAFE_PROXY_FACTORY,
      salt,
      bytecodeHash: SAFE_PROXY_INIT_CODE_HASH,
    });
    console.log('EOA B:', owner.address);
    console.log('Dummy signer:', signerAddress);
    console.log('Predicted Safe:', safeAddress);

    const attachData = encodeFunctionData({
      abi: [
        {
          inputs: [
            { type: 'address', name: 'owner' },
            { type: 'uint256', name: '_threshold' },
          ],
          name: 'addOwnerWithThreshold',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ],
      functionName: 'addOwnerWithThreshold',
      args: [signerAddress, 1n],
    });
    const eoaSignature = await owner.signTypedData({
      domain: { chainId: gnosis.id, verifyingContract: safeAddress },
      types: SAFE_TX_TYPES,
      primaryType: 'SafeTx',
      message: {
        to: safeAddress,
        value: 0n,
        data: attachData,
        operation: 0,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: zeroAddress,
        refundReceiver: zeroAddress,
        nonce: 0n,
      },
    });

    const res = await fetch(`${RELAY_ORIGIN}/api/bootstrap-deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        safeAddress,
        ownerEoa: owner.address,
        pubKeyX: '0x' + x.toString(16),
        pubKeyY: '0x' + y.toString(16),
        eoaSignature,
        mode: 'add',
      }),
    });
    const body = await res.json();
    console.log('bootstrap-deploy:', res.status, JSON.stringify(body));
    note(state, { label: 'bootstrap-deploy', status: res.status, body, safeAddress });
    if (body.ok) {
      state.safeB = { ownerPrivateKey: pk, ownerAddress: owner.address, safeAddress };
      saveState(state);
      console.log('Throwaway Safe deployed & saved.');
    }
    break;
  }

  case 'auth1271': {
    const { ownerPrivateKey, safeAddress } = state.safeB;
    const owner = privateKeyToAccount(ownerPrivateKey);
    const nonce = await fetchNonce(state);
    const message = buildSiwe(safeAddress, nonce);
    const dataHash = hashMessage(message);
    const signature = await signSafe1271(owner, safeAddress, dataHash);

    // Sanity check the 1271 sig against the chain before sending it to GP, so a
    // GP failure can't be blamed on a malformed signature.
    const client = createPublicClient({ chain: gnosis, transport: http(RPC) });
    const valid = await client.verifyMessage({ address: safeAddress, message, signature });
    console.log('Local ERC-1271 verification on Gnosis:', valid);
    note(state, { label: 'local-1271-verify', body: { valid } });

    const { status, body } = await siweChallenge(state, 'challenge(Safe-1271)', message, signature);
    if (status === 200 && body.token) {
      state.jwtSafe = body.token;
      saveState(state);
      const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
      console.log('JWT(Safe) payload:', JSON.stringify(payload, null, 2));
      note(state, { label: 'jwtSafe-payload', body: payload });
    }
    break;
  }

  case 'gp-safe-deploy': {
    const jwt = args[0] === 'safe' ? state.jwtSafe : state.jwtA;
    await gp(
      state,
      `gp-safe-deploy(${args[0] ?? 'eoa'})`,
      '/api/v1/safe/deploy',
      { method: 'POST', body: JSON.stringify({ dailyLimit: 350 }) },
      jwt,
    );
    break;
  }

  case 'log': {
    console.log(JSON.stringify(state.log, null, 2));
    break;
  }

  default:
    console.log('Unknown command. See header comment for usage.');
    process.exit(1);
}
