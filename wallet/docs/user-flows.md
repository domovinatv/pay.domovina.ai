# User flows — full path coverage

Combinatorially complete map of every path a user can take through DOMOVINA
Wallet: **happy paths** (green terminals) and **dead-end / sad paths** (red
terminals). Derived directly from the route table (`App.tsx`) and every screen's
state machine. If you add a `stage`/`phase` kind or a `<Route>`, update the
matching diagram here.

> Convention in the diagrams: 🟢 = success terminal · 🔴 = error/dead-end terminal ·
> 🟠 = user-cancel returns to a safe state · 🔷 = a Face ID (WebAuthn) ceremony.

---

## 0. Top-level route gate (`App.tsx`)

Three routes are **public** (no wallet needed); everything else is gated on
`store.safeAddress` — absent → `Landing`, present → the `AppShell` tab UI.

```mermaid
flowchart TD
    URL[Any URL] --> SW{path?}
    SW -->|/ui-preview| UIP[UiPreview — design gallery]
    SW -->|/embed| EMB[Embed — SDK iframe]
    SW -->|/recover| REC[Recover — fund recovery]
    SW -->|everything else| GATE{store.safeAddress set?}
    GATE -->|no| LAND[Landing — identity onboarding]
    GATE -->|yes| SHELL[AppShell tabs]
    SHELL --> HOME["/ (Wallet home)"]
    SHELL --> RCV["/receive"]
    SHELL --> SND["/send"]
    SHELL --> ACT["/activity"]
    SHELL --> SET["/settings"]
    SET --> PH["/settings/phone"]
    SET --> EXP["/settings/expand-access"]

    classDef public fill:#eef3fb,stroke:#1565c0;
    class UIP,EMB,REC public;
```

Public routes are deliberate: `/embed` runs under the wallet origin for third-party
dApps; `/recover` must work with **no** local wallet (it finds the controlling
passkey by P-256 pubkey recovery). Everything else needs an identity first.

---

## 1. Landing — identity onboarding (the core state machine)

This is where a passkey identity is created or re-opened. `stage` ∈
{welcome, welcome-known, confirm-create-many, confirm-archive, naming,
found-existing, unusable-passkey, creating, opening, created, error}. An
SDK-connect overlay (`?dw_connect=1`) rides on top and, on success, redirects back
to the host instead of entering the UI.

```mermaid
stateDiagram-v2
    [*] --> welcome: no known passkeys
    [*] --> welcome_known: ≥1 known passkey (localStorage)

    welcome --> naming: Kreiraj
    welcome --> opening: Već imam (cross-device picker)
    welcome_known --> opening_known: tap a known wallet
    welcome_known --> naming: Kreiraj (new)
    welcome_known --> opening: Već imam (other device)
    welcome_known --> confirm_archive: archive a wallet

    naming --> confirm_create_many: known ≥ 3
    confirm_create_many --> naming: potvrdi
    confirm_create_many --> welcome_known: odustani
    naming --> creating: 🔷 create()

    creating --> created: 🟢 deploy+attach OK
    creating --> found_existing: InvalidStateError (authenticator already holds a DOMOVINA passkey)
    creating --> error: 🔴 deploy/network fail

    found_existing --> opening: Otvori postojeći
    found_existing --> creating: Svejedno kreiraj novi
    found_existing --> welcome_known: Natrag

    opening --> [*]: 🟢 enter wallet (setAccount)
    opening --> unusable_passkey: passkey → no usable wallet
    opening --> error: 🔴 registry unavailable / cancel
    opening_known --> [*]: 🟢 enter wallet
    unusable_passkey --> creating: kreiraj novi
    unusable_passkey --> welcome_known: natrag

    created --> [*]: 🟢 Uđi u novčanik (after seed backup)
    confirm_archive --> welcome_known: archived / cancel
    error --> welcome: Pokušaj ponovno

    note right of created
      SDK-connect overlay: instead of entering the
      UI, redirects to host with dw_* identity params
    end note
```

**Happy paths:** `welcome → naming → creating → created → wallet` (brand-new),
`welcome_known → tap → wallet` (returning, same device), `welcome → opening →
wallet` (cross-device via OS picker).
**Dead-ends handled gracefully:** `found-existing` (no silent overwrite),
`unusable-passkey` (orphan passkey → guided create), `error` (retry), registry
blip distinguished from genuine 404 so a funded wallet is never told "create new".

---

## 2. Create-vs-open & the WebAuthn ceremony (where duplicates are born)

The most security-sensitive sub-flow. `confirmCreate()` goes **straight to
`navigator.credentials.create()`** — no get-first probe — passing
`excludeCredentials` = **locally-known** credential IDs only. See §8 for the
duplicate-passkey bug this enables.

```mermaid
flowchart TD
    K[Kreiraj] --> RC["runCreate(excludeIds = listKnownPasskeys())"]
    RC --> CREATE{"navigator.credentials.create()<br/>user.id = random(16) · user.name = 'domovina-wallet-v1'"}

    CREATE -->|held cred IS in excludeCredentials| ISE[InvalidStateError]
    ISE --> FE[found-existing — open or create-anyway]

    CREATE -->|"excludeCredentials empty OR held cred not listed"| NEW["🟠 NEW credential minted<br/>(fresh random user.id)"]
    NEW --> DUPQ{another DOMOVINA passkey<br/>already in iCloud/Google?}
    DUPQ -->|no| OK[🟢 first, legitimate passkey]
    DUPQ -->|"yes — but localStorage was empty/cleared/other-context"| DUP[🔴 DUPLICATE 'domovina-wallet-v1'<br/>2nd identity + 2nd Safe + 2nd seed]

    classDef bad fill:#fdeaea,stroke:#c62828;
    class DUP bad;
```

The InvalidStateError safety net **only fires on the same device with intact
localStorage**. Empty/cleared/cross-context `excludeCredentials` → no exclusion →
silent duplicate. Random `user.id` is deliberate (a stable one would **overwrite**
the existing passkey → orphan the funded Safe — strictly worse).

---

## 3. Send (`/send`)

Pre-flight guards burn neither a Face ID ceremony nor a free relay slot on a doomed
transfer. The relay then routes hot vs cold (see
[relayer-architecture.md](./relayer-architecture.md)).

```mermaid
flowchart TD
    S[Send screen] --> VAL{"valid? to ∈ isAddress · amount>0<br/>· not self-send · not over-balance · quota>0"}
    VAL -->|no| BLOCK["🟠 button disabled<br/>inline error: adresa / iznos / stanje / limit"]
    VAL -->|yes| HEAL[heal stub pubKey if needed]
    HEAL --> SIGN[🔷 signWithPasskey Face ID]
    SIGN -->|cancel / pending race| ERR1[🔴 toast: slanje neuspješno]
    SIGN -->|assertion| RELAY[POST /api/relay]
    RELAY -->|429 rate / global cap| RL[🔴 dnevni limit / mreža]
    RELAY -->|403 turnstile| TS[🔴 turnstile]
    RELAY -->|500 / revert| ERR2[🔴 submit failed]
    RELAY -->|ok txHash| DONE[🟢 Poslano ✓ + Gnosisscan link]
    DONE --> REFRESH[refresh balance + recents + quota]

    classDef bad fill:#fdeaea,stroke:#c62828;
    class RL,TS,ERR1,ERR2 bad;
```

Entry variants: direct tab, deep-link `?to=&amount=` (from /receive share), QR scan,
address-book / recents chip, paste. All converge on the same validation gate.

---

## 4. Receive (`/receive`)

Two tabs. P2P shows the Safe address + an EURe-on-Gnosis QR; SEPA mints a Monerium
payment intent (bank → EURe bridge).

```mermaid
flowchart TD
    R[Receive] --> TAB{tab}
    TAB -->|Drugi wallet p2p| P2P[show Safe address + EURe/Gnosis QR + amount]
    P2P --> SHARE[🟢 copy / share / deep-link to /send]
    TAB -->|Iz banke sepa| SEPA[enter amount → create PaymentIntent]
    SEPA -->|intent ok| IBAN[🟢 show IBAN + reference / EPC QR]
    SEPA -->|api error| SERR[🔴 greška — pokušaj ponovno]

    classDef bad fill:#fdeaea,stroke:#c62828;
    class SERR bad;
```

---

## 5. Recover (`/recover`) — public, no wallet needed

Finds the controlling passkey by **P-256 pubkey recovery** (2 candidates from a
WebAuthn assertion → match `predictSafe(signer, salt)` against the target Safe),
then deploys + withdraws via the relay cold path.

```mermaid
stateDiagram-v2
    [*] --> form
    form --> identifying: Pronađi passkey 🔷
    identifying --> identified: 🟢 a candidate derives to the Safe
    identifying --> error: 🔴 chosen passkey doesn't control this Safe / cancel
    identified --> withdrawing: Povuci (dest valid, balance>0) 🔷
    identified --> identified: edit destination
    withdrawing --> done: 🟢 deployed + withdrawn
    withdrawing --> error: 🔴 relay fail
    error --> form: Pokušaj ponovno
    done --> [*]
```

Inputs prefill from URL (`?safe=&campaign=&salt=&to=`) so a pinka campaign can
hand off a one-tap recovery link.

---

## 6. Embed + SDK (`/embed`, public iframe)

Cross-origin. `connect()` is a deterministic full-page redirect (handled in
Landing); `send()` runs in the iframe. Origin is verified against `event.origin`
(see [relayer-threat-model.md](./relayer-threat-model.md) §5).

```mermaid
sequenceDiagram
    participant Host as dApp (host page)
    participant SDK as sdk.js
    participant Wallet as wallet.domovina.ai
    participant IFrame as /embed

    Host->>SDK: Domovina.connect()
    alt cached identity
        SDK-->>Host: 🟢 { safe, signer, cred }
    else needs pick
        SDK->>Wallet: redirect ?dw_connect=1&dw_return=…
        Wallet->>Wallet: Landing pick/create 🔷
        Wallet-->>SDK: redirect back dw_* (CSRF dw_state checked)
        SDK-->>Host: 🟢 identity
    end
    Host->>SDK: Domovina.send({to, amount})
    SDK->>IFrame: postMessage send (parentOrigin=location.origin)
    IFrame->>IFrame: reject if cmd.parentOrigin ≠ event.origin 🔴
    IFrame->>IFrame: reject if record.safe ≠ connected safe 🔴
    IFrame->>IFrame: confirm card (verified origin) 🔷
    IFrame-->>Host: 🟢 { txHash }  /  🔴 { error }
```

Dead-ends: origin mismatch, not-connected, wallet-mismatch, user-cancel
("Korisnik je odustao"), relay failure — each posts a typed error back to the
verified origin.

---

## 7. Multi-passkey & multi-account

### 7a. ExpandAccess (`/settings/expand-access`) — "Dodaj passkey"

Adds a **second passkey as co-owner** of the SAME Safe (threshold stays 1). Two
Face ID prompts: create the new passkey, then sign `addOwnerWithThreshold` with the
existing one.

```mermaid
stateDiagram-v2
    [*] --> intro
    intro --> naming: Nastavi
    naming --> enrolling: Otvori Face ID 🔷 create new passkey
    enrolling --> error: 🔴 create fail
    enrolling --> signing: predict new signer
    signing --> error: 🔴 sign fail / cancel
    signing --> relaying: 🔷 sign addOwner with existing passkey
    relaying --> done: 🟢 new passkey is co-owner
    relaying --> error: 🔴 relay / rate-limit
    done --> [*]: Natrag na postavke
    error --> intro: Pokušaj ponovno
```

> ⚠️ `createPasskey(chosenName)` here is called with **no** `excludeCredentials` —
> see §8 hardening item 4.

### 7b. WalletSwitcher — "Novi račun" / switch / archive

A pure-local derivation: a new 1-of-2 `[signer, recoveryOwner]` Safe at the next
saltNonce under the SAME passkey. No Face ID, no tx, no gas until first send.

```mermaid
flowchart TD
    SWITCH[Računi sheet] --> LIST[list all accounts bootstrap + derived]
    LIST -->|tap| PICK[🟢 setActive → home re-renders]
    LIST -->|Novi račun| NAME[name it]
    NAME --> DERIVE["deriveAccount() — predict Safe, persist local"]
    DERIVE -->|ok| PICK
    DERIVE -->|no recoveryOwner legacy id| DERR[🔴 traži recovery model]
    LIST -->|archive derived| ARCH[🟠 soft-delete local, funds untouched]

    classDef bad fill:#fdeaea,stroke:#c62828;
    class DERR bad;
```

### 7c. BindPhone (`/settings/phone`) — OTP via otp.domovina.ai

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> sms_sent: pošalji SMS
    sms_sent --> verified: poll detects inbound SMS
    sms_sent --> expired: 🔴 timeout
    sms_sent --> error: 🔴 otp api fail
    verified --> binding: bind to wallet
    binding --> success: 🟢 phone bound
    binding --> error: 🔴 bind fail
    expired --> idle: ponovo
    error --> idle: ponovo
    success --> [*]
```

---

## 8. The duplicate-passkey bug — root cause & fix plan

> Observed: **two `domovina-wallet-v1` entries in Apple Passwords**. This section
> explains exactly how, and the plan to stop it.

### 8.1 Mechanism

Apple Passwords / iCloud Keychain (and Google PM) key a stored passkey by
**`(rpId, user.id)`**, *not* by `user.name`. `createPasskey()` sets:

- `user.name = 'domovina-wallet-v1'` — **fixed** (the version-pinned identity slug);
- `user.id = crypto.getRandomValues(16)` — **fresh random every call** (deliberate:
  a stable `user.id` would make `create()` **overwrite** the existing passkey →
  different keypair → **orphaned funded Safe**, strictly worse than a duplicate).

So two `create()` calls produce two different `user.id`s → two distinct passkeys
that **share the display name** `domovina-wallet-v1`. The only thing that *prevents*
a second create is `excludeCredentials` — but it is sourced **only from
`listKnownPasskeys()` (localStorage)**, and `create()` goes straight in with **no
get-first existence probe** (the probe was removed because a `get()` picker shows
"Use a saved passkey" with no create affordance, which trapped first-time users).

Therefore a duplicate is minted, silently, whenever `create()` runs while the
device's existing DOMOVINA passkey is **not** in `excludeCredentials`:

```mermaid
flowchart TD
    START[user taps Kreiraj a 2nd time] --> Q1{"localStorage has the 1st passkey's credentialId?"}
    Q1 -->|yes same device, intact storage| EXC[excludeCredentials includes it]
    EXC --> ISE[InvalidStateError → found-existing 🟢 no dup]
    Q1 -->|"no — cleared site data / PWA-vs-Safari / other browser / incognito / fresh device w/ iCloud sync"| EMPTY[excludeCredentials empty]
    EMPTY --> CRT["create() proceeds — iCloud still has passkey #1<br/>but RP can't see/exclude it"]
    CRT --> DUP["🔴 2nd 'domovina-wallet-v1' minted"]

    PATH2["found-existing reached via InvalidStateError<br/>sets NO credentialId"] --> ANY["'Svejedno kreiraj novi' → runCreate([])"]
    ANY --> CRT

    classDef bad fill:#fdeaea,stroke:#c62828;
    class DUP bad;
```

**Reproduction paths** (any one suffices):
1. Create wallet → clear site data (or open the installed PWA vs Safari tab — they
   have separate `localStorage`) → tap Kreiraj again → silent duplicate.
2. Same iCloud on a second device (localStorage empty there) → Kreiraj → duplicate.
3. `found-existing` (from a same-device InvalidStateError) carries **no**
   `credentialId`, so its **"Svejedno kreiraj novi"** calls `runCreate([])` → no
   excludes → duplicate.

Why it matters beyond clutter: each duplicate is a **separate identity → separate
Safe → separate recovery seed**. Funds can land in the wrong one; the first Safe's
one-time seed may already be gone (cf. Postmortem 0001).

### 8.2 Fix plan (phased, ranked)

```mermaid
flowchart LR
    P1[Phase 1<br/>get-first probe<br/>dismiss→create] --> P2[Phase 2<br/>conditional-mediation<br/>autofill discovery]
    P2 --> P3[Phase 3<br/>duplicate detect<br/>+ cleanup UX]
    P3 --> P4[Phase 4<br/>ExpandAccess<br/>excludeCredentials]
    classDef now fill:#e6f7e6,stroke:#2e7d32;
    class P1 now;
```

**Phase 1 — reinstate a get-first probe with graceful fallthrough (high value, low risk).**
Before `create()`, run `navigator.credentials.get({ rpId, mediation:'optional' })`
across `[RP_ID, LEGACY_RP_ID]`. This surfaces passkeys from iCloud/Google
**regardless of localStorage**.
- returns a credential → route to `found-existing(credentialId)` → **open it** (no dup);
- user dismisses / none exist (`NotAllowedError`/null) → **proceed to `create()`**.
The historical trap was treating dismiss as a dead-end; here dismiss → create, so a
true first-timer just dismisses one picker. This closes reproduction paths 1 & 2 and
gives path 3 a real `credentialId` to exclude.

**Phase 2 — conditional-mediation (autofill) discovery on the welcome screen (removes Phase-1 friction).**
Gate on `PublicKeyCredential.isConditionalMediationAvailable()`. Render a hidden
`autocomplete="webauthn"` field and start a conditional `get()`; returning users see
their synced passkey passively (no modal) while "Kreiraj" stays instant for
first-timers. Falls back to Phase 1 where conditional UI is unsupported (older iOS).

**Phase 3 — duplicate detection + remediation UX.**
When `welcome-known` (or Settings → Računi) holds ≥2 identities — especially ones
sharing `keychainName === 'domovina-wallet-v1'` — surface a banner with each
wallet's EURe balance and a "je li ovo greška?" cleanup affordance: archive the
empty/stale one locally **and** instruct the user to delete it in Apple Passwords
(the RP cannot delete an OS-stored passkey). Prevents a funded-but-forgotten Safe.

**Phase 4 — harden the other create site.**
`ExpandAccess.runExpand()` calls `createPasskey(chosenName)` with **no**
`excludeCredentials`. Pass `listKnownPasskeys()` IDs so it can't re-mint the same
authenticator as a "new" co-owner on the same device.

### 8.3 Irreducible limits (set expectations)

- A user can always choose **"Svejedno kreiraj novi"** — intentional duplicates stay
  possible (by design; sometimes wanted).
- The RP **cannot enumerate or delete** passkeys held by a third-party provider
  (1Password/LastPass) or in another OS account — cross-provider dups can't be fully
  prevented, only detected after the fact.
- Stable `user.id` is **not** an option — it trades a duplicate for an overwrite that
  orphans a funded Safe.

The plan eliminates **accidental/silent** duplicates (the reported case) without
reintroducing the create-trap or the overwrite footgun.

---

## 9. Coverage matrix (every route × terminal)

| Route | Happy terminal(s) | Dead-end / sad terminal(s) | Face ID |
|---|---|---|---|
| Landing | enter wallet · created · SDK redirect-back | error · unusable-passkey · found-existing(→dup risk §8) | create / open |
| `/` Wallet | balance + activity render | none (balance "—" if undeployed) | — |
| `/send` | Poslano ✓ | invalid input · rate-limit(429) · turnstile(403) · revert/500 · cancel | sign |
| `/receive` | address/QR · IBAN+ref | SEPA intent api error | — |
| `/recover` | deployed + withdrawn | wrong passkey · empty Safe · relay fail | identify + withdraw |
| `/embed` | { txHash } | origin mismatch · not-connected · wallet-mismatch · cancel · relay fail | confirm sign |
| `/settings/expand-access` | co-owner added | create/sign/relay/rate-limit fail | create + sign |
| `/settings/phone` | phone bound | expired · otp/bind fail | — |
| WalletSwitcher | switch / new account | legacy-no-recoveryOwner | — |
| `/settings` | theme/info · sign-out | — | — |

Every `stage`/`phase` enum value across the codebase appears in a diagram above; the
matrix is the checklist when adding a new route or terminal state.
