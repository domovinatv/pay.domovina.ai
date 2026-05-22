# ADR 0001 — `wallet.domovina.ai` is 100% self-custody. No server-side recovery.

**Status:** Accepted, permanent.
**Date:** 2026-05-22
**Decision owners:** Matija Stepanic, ITalk d.o.o.

## Context

In the same session that introduced `wallet.domovina.ai` (commit history
on branch `feat/wallet-pwa`, May 2026), an extended Phase 4 recovery
architecture was brainstormed:

- **Phase 4b** — deploy a Zodiac Roles Modifier on each user Safe at
  creation time, granting a single backend EOA (`RECOVERY_EOA`) the
  permission to call `addOwnerWithThreshold` and `swapOwner` (and
  nothing else) on the user's Safe.
- **Phase 4c** — implement a recovery flow: user verifies a phone via
  `otp.domovina.ai`, our backend uses `RECOVERY_EOA` to onchain
  swap in a new passkey signer as Safe owner.
- **Phase 4d** — wrap recovery in a Zodiac Delay Modifier with 24-48h
  cooldown + push/SMS notification, so the original owner can cancel a
  hostile recovery (e.g. SIM-swap attack) before it finalizes.

This pattern is **the industry-standard MPC-lite social recovery model
used by Privy, Magic.link, and most "passkey wallet" providers**. It
provides a clean recovery story for the common consumer case of "I lost
my passkey and have no other passkey-enrolled device."

After consideration, this entire family of recovery patterns is
**rejected and will not be implemented**.

## Decision

`wallet.domovina.ai` is, and will remain, **fully peer-to-peer
self-custody**. The only entity that can ever mutate ownership of a user
Safe or move funds from it is the user themselves, exclusively via
their own passkey-derived signature, validated onchain by Safe's
ERC-1271 path.

Hard rules (binding):

1. **No backend-held key ever has any onchain authority over user
   Safes.** No `RECOVERY_EOA`, no admin role on Zodiac modules, no
   `enableModule` that the user didn't sign for personally.
2. **No Zodiac Roles Modifier, Delay Modifier, Recovery Module, or any
   other Safe module that can mutate ownership or move funds will be
   added to user Safes at creation or later by us.**
3. **The CF Worker relay's only on-chain role is gas sponsorship:** it
   submits user-signed `safe.execTransaction` payloads and pays xDAI
   gas. The transaction body is authored and signed entirely client-side
   by the passkey. The relay holds no Safe-authoritative key.
4. **All Safe ownership changes happen onchain, authorized by the
   current owner(s) of that Safe via their passkey.** Cross-device
   onboarding, multi-passkey upgrades, and any future "social
   recovery" patterns must be expressible as user-signed Safe txs with
   no offchain modification path open to us.
5. **If a user permanently loses every passkey that owns their Safe,
   the funds in that Safe are permanently inaccessible.** This is the
   honest trade-off of self-custody, and the wallet UX must be explicit
   about it.

## Why this rule is non-negotiable

### Self-custody can't be partial

If `wallet.domovina.ai` is "self-custody, but Domovina has a key that
can move owners," then in any practical sense it is custodial — we are
just one subpoena, one legal mistake, or one breached Cloudflare account
away from being able to move user funds. A correctly-shaped attacker
who compromises the `RECOVERY_EOA` (or coerces us to use it) drains
every user wallet on the platform. That is structurally indistinguishable
from a custodial wallet that misuses its custody.

The whole reason to ship a passkey + Safe architecture instead of just
using Privy or Magic.link from day one is to **avoid being a single
point of failure**. Reintroducing one in the recovery flow defeats the
purpose.

### iCloud Keychain + Google Password Manager are sufficient for the
### consumer happy path

Modern OS-level passkey storage already provides:

- **End-to-end encrypted sync** across all of a user's devices on the
  same Apple ID or Google account, with hardware-bound keys never
  leaving Secure Enclave / TPM
- **Automatic recovery via the OS vendor's existing account recovery**
  flows (Apple recovery contacts, Google account recovery, etc.)
- **Multi-device redundancy** without us doing anything

A user who has *any* working Apple or Google device that has *ever*
signed into their account can recover their passkey. The remaining
failure case — "lost every Apple device + lost Apple ID + lost every
recovery contact + no Google sync either" — is statistically rare
enough, and so deeply pathological for the user's broader digital life,
that it doesn't justify centralizing trust for the other 99.9% of
users.

### True P2P recovery patterns exist and are preferred

If we ever want to offer a recovery story stronger than "OS Keychain
sync," the acceptable patterns are user-controlled, not us-controlled:

- **Multi-passkey 2-of-N Safe upgrade**: user enrolls passkeys on
  multiple devices (iPhone + iPad + MacBook + Android via hybrid
  transport), Safe is configured 2-of-N. Loss of one device is a
  zero-event. All ownership changes signed by surviving owners. No
  server involvement.
- **User-chosen "guardian" signers**: user picks N trusted friends or
  family members. Their personal wallets are added as Safe owners with
  a delay modifier. M-of-N can rescue. *The user picks guardians, not
  us.* If we are ever a guardian, it must be one of many, and the user
  must consciously opt to trust us at that level.
- **Hardware wallet as secondary signer**: user adds a Ledger / Trezor /
  GridPlus as a Safe owner, kept offline. Survives any digital
  ecosystem loss. Pure self-custody.
- **Paper / steel cold backup signer**: user generates an EOA, stores
  the seed offline, adds the EOA as Safe owner. Equivalent to
  traditional crypto cold storage but layered on top of the passkey
  daily-use signer.

All of these are pure onchain operations authorized by the user. None
require us to hold any key with authority over their Safe.

## Consequences

### What we lose vs the rejected Phase 4 design

- **Recovery for the user who lost iCloud / Google + every passkey.**
  We will not rescue them. Funds gone. Documented honestly in the UX.
- **A "forgot device, prove it's you with SMS" flow.** Not available.
  SMS knowledge does not authorize anything onchain in our design.
- **Industry-standard convenience that Privy and Magic.link offer.**
  We accept the UX hit for the architectural integrity.

### What we keep

- **Customer-counting metric** via the wallet registry on `mpt.domovina.ai`.
  Stores `credentialId → safe_address` for analytics + cross-device
  login lookup. Holds no Safe-authoritative key.
- **Optional phone binding via `otp.domovina.ai`.** Stored as
  `HMAC(PHONE_PEPPER, e164_phone)`. **Does not enable recovery.** Its
  surviving uses, if we keep the feature at all (see Open Question
  below), are: anti-abuse rate-limiting per phone hash, customer
  support identification, and possibly future P2P recovery flows where
  the user opts in to allow OTP as one of several user-chosen factors —
  *but never as a path that gives us authority on their Safe.*
- **CF Worker relay paying xDAI gas.** Still useful. Still strictly
  bounded to gas sponsorship. Does not author transactions; only relays
  passkey-signed ones.

### What we will build instead, if we ever pursue recovery UX

Phase 4 as documented above is dead. The replacement Phase 4 is
**purely user-driven onchain owner management**:

- **"Add this device" flow**: user enrolls a second passkey on a new
  device, hands the resulting signer address to their existing wallet
  (via QR code or pasted hex), and the existing device's passkey signs
  a `safe.addOwnerWithThreshold` tx onchain.
- **"Add guardian" flow**: similar but for any onchain address (a
  hardware wallet, a trusted person's wallet, a cold paper EOA).
- **Threshold UI**: user can raise threshold from 1 to N as they add
  signers, increasing security.
- **"Remove device" flow**: signed by remaining owners, swaps out a
  lost device's signer for a new one.

These are all signed by the user's existing passkey(s). Our server's
only role is to optionally relay gas. Even that is replaceable if the
user ever has xDAI directly.

## Surviving purpose of the phone binding feature

The phone binding feature shipped in this session (`POST
/api/wallets/:credentialId/bind-phone`, admin "Self-custody wallets"
page showing `has_phone` flag) is **kept**, but explicitly **not** for
recovery. Its purposes under this ADR are:

1. **Anti-bot / sybil resistance over time.** A wallet that has
   periodically re-verified the same phone for 6+ months presents a
   much stronger trust signal than a wallet that minted yesterday from
   a freshly-purchased prepaid SIM. The value isn't the binding itself
   — it's the *historical* binding pattern.
2. **SMS notifications about wallet activity** (planned). Tx
   confirmations, suspicious-access alerts, re-verification reminders.
   The user opts in by binding a phone.
3. **Customer support identification.** When a user calls help desk,
   they can prove their identity via OTP and we can find their
   wallet in the registry.

### Privacy-by-design via two-system separation

`mpt.domovina.ai` (this Worker) **never stores raw phone numbers.** It
only stores `HMAC(PHONE_PEPPER, e164_phone)` plus the `verification_id`
that came from `otp.domovina.ai`. The raw phone lives exclusively in
`otp.domovina.ai`'s DO SQLite audit log.

To send an SMS notification (when implemented), the lookup chain is:

```
1. mpt.domovina.ai picks a wallet (e.g. for tx confirmation cron)
2. mpt.domovina.ai → SELECT verification_id FROM otp_consumed
                     WHERE credential_id = ?
                     ORDER BY consumed_at DESC LIMIT 1
3. mpt.domovina.ai → GET otp.domovina.ai/api/verifications/:id
                     ← verified_phone (in plain E.164)
4. mpt.domovina.ai → POST sms-api.domovina.ai/messages
                     send outbound SMS via the Android gateway
```

The link table `otp_consumed.credential_id` was added in migration
`0009_otp_history_link.sql` specifically to enable this traversal
without ever materializing the phone number in our DB.

**Threat model:**

- If `mpt.domovina.ai`'s D1 leaks → attacker has hashes + verification
  IDs but no phone numbers and no wallet authority.
- If `otp.domovina.ai`'s DO leaks → attacker has phone numbers but no
  wallet linkage and no wallet authority.
- Attacker needs BOTH systems' admin access to correlate phone↔wallet.
  Each system can be compromised independently without leaking the
  other half.
- Neither leak gives the attacker any ability to move user funds, per
  the hard rules in this ADR.

### Future Phase 5: onchain phone attestation (under discussion)

A separate proposal under consideration would have the user's wallet
write a passkey-signed `attest(verificationHash)` tx to a stateless
`PhoneAttestation` contract on Gnosis after each OTP confirmation. The
purpose is to make the long-term phone-binding history a public,
verifiable, immutable signal — useful for sybil resistance and trust
scoring by third parties — without giving our backend any new power.

Critically, that proposal is still 100% self-custody-compatible: the
user's passkey signs the attestation tx. The contract is stateless
beyond per-wallet timestamps. Our server's only role is gas relay.

Decision on Phase 5 is open; whatever shape it takes, it must continue
to honor the hard rules in this ADR.

## References

- `wallet/README.md` — wallet PWA architecture overview
- Memory: `[[reference-wallet-domovina]]`, `[[reference-safe-passkey-gnosis]]`,
  `[[reference-otp-domovina]]`
- Privy / Magic.link / ZeroDev — examples of the *rejected* approach
- Coinbase Smart Wallet, Daimo, Patch — examples closer to our P2P
  ideal (varying degrees)
