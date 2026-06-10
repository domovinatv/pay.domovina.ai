/**
 * ADR 0013 — Passkey = identity (one), Safe = account (many).
 *
 * The local registry in `passkey.ts` keys by credentialId: one passkey = one
 * Safe. This module layers the MANY-accounts-per-identity model on top WITHOUT
 * disturbing that validated path:
 *
 *   - The "bootstrap" account of an identity IS its PasskeyRecord (the EOA-owned
 *     1-of-2 Safe deployed at creation, address = predict(EOA, salt 0)). It keeps
 *     sending via the relay hot path exactly as before.
 *   - DERIVED accounts (this module's `domovina_accounts_v3` store, keyed by
 *     safeAddress) are minted on demand under the SAME passkey signer at fresh
 *     saltNonces. Each is a 1-of-2 `[passkeySigner, recoveryOwner]` Safe so it is
 *     NEVER passkey-only (Postmortem 0001), deployed lazily on first send via the
 *     relay cold path. Minting is pure-local: no Face ID, no on-chain tx, no gas
 *     until the account first spends.
 *
 * The reusable recovery owner is the identity's `recoveryOwner` address (born as
 * the bootstrap seed, ADR 0012). All of an identity's derived accounts share it,
 * so the user backs up ONE key that controls everything (ADR 0013 Decision 2).
 */
import type { Address } from 'viem';
import { predictSafeAddressForOwners, publicClient, readSafeOwners } from './safe';
import {
  listKnownPasskeys,
  lookupPasskey,
  recordRpId,
  savePasskey,
  type PasskeyRecord,
} from './passkey';
import {
  fetchAccountsFromBackend,
  lookupWallet,
  registerAccountWithBackend,
  registerWalletWithBackend,
} from './registry';

const STORAGE_KEY_V3 = 'domovina_accounts_v3';
const ACTIVE_ACCOUNT_KEY = 'domovina_active_account';

/** A derived (saltNonce-based) account under an identity. Persisted in v3.
 * Bootstrap accounts are NOT stored here — they live as PasskeyRecords. */
export type AccountRecord = {
  /** CREATE2 address of the 1-of-2 [signer, recoveryOwner] Safe at saltNonce. */
  safeAddress: Address;
  /** FK to the owning identity (PasskeyRecord.credentialId). */
  credentialId: string;
  /** Decimal uint256 saltNonce; unique among this identity's derived accounts. */
  saltNonce: string;
  /** Recovery owner address captured at mint time (snapshot of the identity's
   * recoveryOwner) so the account's derivation stays reproducible even if the
   * identity record is later edited. */
  recoveryOwner: Address;
  /** In-app account label (e.g. "Ušteđevina"). Lives here, not in the keychain. */
  name: string;
  createdAt: string;
};

/** Unified view the UI + Send consume — bootstrap and derived collapsed into one
 * shape. `kind` tells Send which relay path applies. */
export type WalletAccount = {
  safeAddress: Address;
  kind: 'bootstrap' | 'derived';
  /** Derived only; undefined for bootstrap (which sends via the hot path). */
  saltNonce?: string;
  /** Derived only; the 2nd owner the relay cold-path must bake into the deploy. */
  recoveryOwner?: Address;
  // Identity (shared across all of an identity's accounts):
  credentialId: string;
  pubKey: { x: string; y: string };
  signerAddress: Address;
  rpId?: string;
  keychainName?: string;
  // Display:
  name: string;
  createdAt: string;
};

type AccountRegistry = Record<string, AccountRecord>;

function loadAccounts(): AccountRegistry {
  const raw = localStorage.getItem(STORAGE_KEY_V3);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AccountRegistry;
  } catch {
    return {};
  }
}

function saveAccounts(reg: AccountRegistry): void {
  localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(reg));
}

/** Canonical owner order for an ADR-0013 derived account. MUST match the order
 * the relayer builds its setup() initializer in (functions/api/relay.ts), or the
 * predicted address drifts from the deployed one. The relay's CREATE2 guard is
 * the safety net, but keep these in lockstep so it never has to fire. */
export function derivedOwners(signerAddress: Address, recoveryOwner: Address): Address[] {
  return [signerAddress, recoveryOwner];
}

/** Build the bootstrap account view from an identity record. Exported so the
 * identity-level entry flows (Landing) can set the active account with a proper
 * in-app name + bootstrap kind in one store write. */
export function bootstrapAccountView(id: PasskeyRecord): WalletAccount {
  return {
    safeAddress: id.safeAddress,
    kind: 'bootstrap',
    credentialId: id.credentialId,
    pubKey: id.pubKey,
    signerAddress: id.signerAddress,
    rpId: id.rpId,
    keychainName: id.keychainName,
    name: id.keychainName || (id.nameSuffix ? `wa_${id.nameSuffix}` : 'Glavni'),
    createdAt: id.createdAt,
  };
}

/** Resolve a stored derived record against its identity into a full view.
 * Returns null if the identity is no longer known on this device (e.g. archived);
 * such orphans are simply hidden, never crash the picker. */
function derivedToAccount(rec: AccountRecord): WalletAccount | null {
  const id = lookupPasskey(rec.credentialId);
  if (!id) return null;
  return {
    safeAddress: rec.safeAddress,
    kind: 'derived',
    saltNonce: rec.saltNonce,
    recoveryOwner: rec.recoveryOwner,
    credentialId: id.credentialId,
    pubKey: id.pubKey,
    signerAddress: id.signerAddress,
    rpId: id.rpId,
    keychainName: id.keychainName,
    name: rec.name,
    createdAt: rec.createdAt,
  };
}

/** All derived records belonging to one identity. */
function derivedRecordsFor(credentialId: string): AccountRecord[] {
  return Object.values(loadAccounts()).filter((a) => a.credentialId === credentialId);
}

/** Every account (bootstrap + derived) across every known identity, oldest
 * first within each identity. */
export function listAllAccounts(): WalletAccount[] {
  const out: WalletAccount[] = [];
  for (const id of listKnownPasskeys()) {
    out.push(bootstrapAccountView(id));
    derivedRecordsFor(id.credentialId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .forEach((rec) => {
        const acc = derivedToAccount(rec);
        if (acc) out.push(acc);
      });
  }
  return out;
}

/** Accounts under a single identity (bootstrap first, then derived oldest→newest). */
export function listAccountsForIdentity(credentialId: string): WalletAccount[] {
  const id = lookupPasskey(credentialId);
  if (!id) return [];
  const derived = derivedRecordsFor(credentialId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(derivedToAccount)
    .filter((a): a is WalletAccount => a !== null);
  return [bootstrapAccountView(id), ...derived];
}

/** Look up any account (bootstrap or derived) by its Safe address. */
export function getAccountByAddress(safeAddress: string): WalletAccount | null {
  const target = safeAddress.toLowerCase();
  return listAllAccounts().find((a) => a.safeAddress.toLowerCase() === target) ?? null;
}

/** Next free saltNonce for an identity's derived accounts: max existing + 1,
 * starting at 0. Derived accounts use the 2-owner initializer, a distinct
 * CREATE2 preimage from the bootstrap EOA Safe and the 1-owner pinka/recover
 * Safes, so saltNonce 0 here never collides with those. */
function nextSaltNonce(credentialId: string): string {
  const used = derivedRecordsFor(credentialId).map((a) => {
    try {
      return BigInt(a.saltNonce);
    } catch {
      return -1n;
    }
  });
  const max = used.reduce((m, v) => (v > m ? v : m), -1n);
  return (max + 1n).toString();
}

/**
 * Mint a new account under an identity. Pure-local: predicts the 1-of-2
 * [signer, recoveryOwner] Safe at the next saltNonce, persists it, and best-
 * effort registers it with the backend. No Face ID, no tx — the Safe deploys on
 * first send. Throws if the identity has no recoveryOwner (legacy pre-ADR-0013
 * record); such identities can only mint accounts after re-creation.
 */
export async function deriveAccount(
  credentialId: string,
  name: string,
): Promise<WalletAccount> {
  const id = lookupPasskey(credentialId);
  if (!id) throw new Error('Identitet nije poznat na ovom uređaju.');
  if (!id.recoveryOwner) {
    throw new Error(
      'Ovaj wallet je kreiran prije recovery-ključ modela — novi računi traže recovery vlasnika. Kreiraj wallet u novoj verziji.',
    );
  }
  const recoveryOwner = id.recoveryOwner;
  const saltNonce = nextSaltNonce(credentialId);
  const owners = derivedOwners(id.signerAddress, recoveryOwner);
  const safeAddress = await predictSafeAddressForOwners(owners, 1, saltNonce);

  const rec: AccountRecord = {
    safeAddress,
    credentialId,
    saltNonce,
    recoveryOwner,
    name: name.trim() || `Račun ${saltNonce}`,
    createdAt: new Date().toISOString(),
  };
  const reg = loadAccounts();
  reg[safeAddress.toLowerCase()] = rec;
  saveAccounts(reg);
  setActiveAccountAddress(safeAddress);

  void registerAccountWithBackend({ credentialId, safeAddress, saltNonce, recoveryOwner, name: rec.name });

  const acc = derivedToAccount(rec);
  if (!acc) throw new Error('Neuspješno kreiranje računa.');
  return acc;
}

/**
 * Soft-delete a derived account from the local list. The Safe + funds onchain are
 * untouched; it can be re-derived at the same saltNonce. Bootstrap accounts are
 * not stored here, so this no-ops for them (archive the identity via passkey.ts
 * archivePasskey instead).
 */
export function archiveDerivedAccount(safeAddress: string): void {
  const reg = loadAccounts();
  const key = safeAddress.toLowerCase();
  if (!reg[key]) return;
  delete reg[key];
  saveAccounts(reg);
  if (getActiveAccountAddress()?.toLowerCase() === key) {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  }
}

export function getActiveAccountAddress(): string | null {
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
}

export function setActiveAccountAddress(safeAddress: string): void {
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, safeAddress);
}

/** Whether an identity can mint additional accounts (has a recovery owner). */
export function canDeriveAccounts(credentialId: string): boolean {
  return !!lookupPasskey(credentialId)?.recoveryOwner;
}

/**
 * Two-way sync of an identity's derived accounts with the backend, so the SAME N
 * accounts show on every device (ADR 0013 cross-device restore). Call after entering
 * the wallet (especially a cross-device open):
 *   1. PULL — add any backend account missing from this device's local store
 *      (the second-device case: accounts minted elsewhere become visible here);
 *   2. PUSH — register any local-only account the backend doesn't have yet
 *      (backfills accounts minted before the backend endpoint existed, so they
 *      finally become visible on other devices).
 * Best-effort and idempotent; never throws. Returns true if the local store changed
 * (so the caller can refresh a list). The Safe addresses are deterministic CREATE2,
 * so a pulled account is byte-identical to one derived locally.
 */
export async function syncAccountsWithBackend(credentialId: string): Promise<boolean> {
  const id = lookupPasskey(credentialId);
  if (!id) return false;
  const remote = await fetchAccountsFromBackend(credentialId);

  const reg = loadAccounts();
  let changed = false;
  for (const r of remote) {
    const key = r.safe_address.toLowerCase();
    if (!reg[key]) {
      reg[key] = {
        safeAddress: r.safe_address,
        credentialId,
        saltNonce: r.salt_nonce,
        recoveryOwner: r.recovery_owner,
        name: r.name,
        createdAt: r.created_at,
      };
      changed = true;
    }
  }
  if (changed) saveAccounts(reg);

  // Push local-only accounts up (backfill). Skip if this identity has no recovery
  // owner snapshot on the record (can't happen for derived records — they always
  // store it — but guards a malformed entry).
  const remoteKeys = new Set(remote.map((r) => r.safe_address.toLowerCase()));
  for (const rec of derivedRecordsFor(credentialId)) {
    if (!remoteKeys.has(rec.safeAddress.toLowerCase())) {
      void registerAccountWithBackend({
        credentialId,
        safeAddress: rec.safeAddress,
        saltNonce: rec.saltNonce,
        recoveryOwner: rec.recoveryOwner,
        name: rec.name,
      });
    }
  }
  return changed;
}

async function backfillIdentityToBackend(rec: PasskeyRecord, recoveryOwner: Address): Promise<void> {
  if (rec.pubKey.x === '0' || rec.pubKey.y === '0') return; // stub — can't register
  await registerWalletWithBackend({
    credentialId: rec.credentialId,
    pubKeyX: rec.pubKey.x,
    pubKeyY: rec.pubKey.y,
    signerAddress: rec.signerAddress,
    safeAddress: rec.safeAddress,
    rpId: recordRpId(rec),
    recoveryOwner,
  });
}

/**
 * Make the identity's recovery owner available on THIS device, so "Novi račun" works
 * everywhere — not just the device that created the wallet. Without it, a second
 * device can VIEW synced accounts but can't MINT new ones (deriveAccount needs the
 * recovery owner), and "what if I lose my phone?" has no answer.
 *
 * Resolution order (all idempotent, best-effort, never throws):
 *   1. Already local → re-register to the backend so OTHER devices can pull it.
 *   2. Backend has it (another device backfilled) → save locally.
 *   3. Derive it from the bootstrap Safe's ON-CHAIN owners — the non-signer EOA
 *      (codeless) owner is the recovery owner (ADR-0013 'add' mode keeps it as a
 *      1-of-2 owner). Works even if the creating device is gone — no duplicate
 *      passkey needed. Then save locally + backfill the backend.
 *
 * NOTE: this is the correct path; "Kreiraj novi wallet" would instead mint a NEW
 * passkey/identity (a duplicate) and is never the right answer for an existing wallet.
 */
export async function ensureRecoveryOwner(credentialId: string): Promise<void> {
  const rec = lookupPasskey(credentialId);
  if (!rec) return;
  if (rec.recoveryOwner) {
    void backfillIdentityToBackend(rec, rec.recoveryOwner);
    return;
  }

  let ro: Address | null = null;
  try {
    const remote = await lookupWallet(credentialId);
    if (remote?.recovery_owner) ro = remote.recovery_owner as Address;
  } catch {
    /* ignore — fall through to on-chain */
  }

  if (!ro) {
    const owners = await readSafeOwners(rec.safeAddress);
    const candidates = owners.filter(
      (o) => o.toLowerCase() !== rec.signerAddress.toLowerCase(),
    );
    for (const cand of candidates) {
      const code = await publicClient.getCode({ address: cand });
      if (!code || code === '0x') {
        ro = cand; // EOA (codeless) = the recovery owner; passkey signers are contracts
        break;
      }
    }
    if (!ro && candidates[0]) ro = candidates[0]; // fallback: first non-signer owner
  }

  if (!ro) return;
  savePasskey({ ...rec, recoveryOwner: ro });
  void backfillIdentityToBackend(rec, ro);
}

/** Suggested one-tap account names for the "Novi račun" step. */
export const ACCOUNT_NAME_SUGGESTIONS: readonly string[] = [
  'Glavni',
  'Ušteđevina',
  'Firma',
  'Test',
  'Pokloni',
];
