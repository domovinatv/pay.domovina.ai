# wallet.domovina.ai

Self-custody EURe wallet na Gnosis Chainu. Passkey potpisivanje, nema seed
phrase-a. Top-up kroz postojeći `pay.domovina.ai` payment intent rail; send
kroz vlastiti relayer.

> **Status:** scaffold / WIP. Sve datoteke u `src/lib/` imaju TypeScript
> potpise i UI flow je spreman, ali ključni cryptographic / onchain dijelovi
> (P-256 pubkey ekstrakcija, Safe predict + tx hash, ERC-1271 signature blob)
> su stubovi koji bacaju `not implemented yet`. Vidi "Što treba implementirati".

## Stack

| Sloj | Izbor |
|---|---|
| Build | Vite 5 + React 18 + TypeScript |
| Styling | Tailwind 3 (brand: navy `#002F6C`, red `#FF0000`) |
| PWA | `vite-plugin-pwa` (autoUpdate, network-first za `/api/*`) |
| Web3 | `viem` + `@safe-global/protocol-kit` + `@safe-global/safe-passkey` |
| State | Zustand |
| QR | `qr-code-styling` |
| Hosting | Cloudflare Pages (build → `dist/`, Functions u `functions/`) |
| Relay | CF Worker (`functions/api/relay.ts`) s KV za rate limit |

## Arhitektura

```
[Korisnik]
   │ Open Wallet → WebAuthn create/get (FaceID + iOS Keychain)
   ▼
[wallet.domovina.ai PWA]
   │
   ├─ Receive flow:
   │    POST pay.domovina.ai/api/payment-intent { destination: 0xUserSafe }
   │    Postojeći Zodiac Roles routing na MPT Safeu prosljeđuje EURe.
   │    NIKAKVE backend izmjene nisu potrebne.
   │
   └─ Send flow:
        Safe.execTransaction payload → passkey signature
                                    → POST /api/relay
                                    → CF Worker submitta on-chain
                                    → relayer wallet plaća xDAI gas
                                    → 5 free tx/dan/passkey (KV brojač)
```

Vidi `docs/research/` u parent repou za detaljniju arhitekturu.

## Ključne konstante (Gnosis Chain 100)

Sve iz `safe-global/safe-modules-deployments` v0.2.1 — iste adrese kao na ostalim chainovima:

- `SafeWebAuthnSignerFactory` — `0x1d31F259eE307358a26dFb23EB365939E8641195`
- `SafeWebAuthnSharedSigner` — `0x94a4F6affBd8975951142c3999aEAB7ecee555c2`
- `DaimoP256Verifier` (fallback) — `0xc2b78104907F722DABAc4C69f826a522B2754De4`
- `EURe` — `0xcB444e90D8198415266c6a2724b7900fb12FC56E`

P-256 precompile na `0x100`: status na Gnosisu još nepotvrđen (vidi otvoreno
pitanje). Verifier param u factoryju kodira (precompile || fallback) tako da
radi u oba scenarija.

## Dev

```bash
cd wallet
npm install
cp .dev.vars.example .dev.vars   # popuni RELAYER_PRIVATE_KEY za relay tests
npm run dev                       # Vite na :5173

# CF Pages Functions lokalno (relay endpoint):
npx wrangler pages dev dist --kv RELAY_KV
```

## Deploy

```bash
npm run build
npm run deploy   # wrangler pages deploy dist --project-name=wallet-domovina
```

Potrebno prije prvog deploya:
- CF Pages projekt `wallet-domovina` kreiran u dashboardu
- Custom domain `wallet.domovina.ai` zakvačen
- KV namespace kreiran i ID upisan u `wrangler.toml`
- Secret `RELAYER_PRIVATE_KEY` postavljen kroz `wrangler pages secret put`
- Relayer xDAI account funded (~$10 xDAI pokriva ~15,000 tx)

## Što treba implementirati

Stubovi koji `throw new Error('not implemented yet')`:

1. **`src/lib/passkey.ts::extractP256Pubkey`** — parsirati COSE-encoded
   javni ključ iz `attestationObject` (CBOR), izvući (x, y) koordinate.
   Reference: `@safe-global/safe-passkey/src/utils/decoding.ts`.

2. **`src/lib/safe.ts::predictSignerAddress`** — viem `readContract`
   pozvati `SafeWebAuthnSignerFactory.getSigner(x, y, verifiers)`.
   ABI dostupan u `@safe-global/safe-modules-deployments`.

3. **`src/lib/safe.ts::predictSafeAddress`** — koristi
   `@safe-global/protocol-kit` `predictSafeAddress` s `{ owners:
   [signerAddress], threshold: 1, saltNonce: 0 }`.

4. **`src/lib/safe.ts::getSafeTxHash`** — EIP-712 Safe tx hash; ako Safe
   još nije deployan, koristi `nonce=0`.

5. **`src/lib/safe.ts::encodeWebAuthnSignature`** — extract `r, s` iz
   DER-enkodiranog P-256 potpisa, složi `SignatureData` struct za
   `SafeWebAuthnSignerSingleton`, prependaj Safe contract-sig header
   `(signer || offset || 0)`. Detalji u safe-passkey repou.

6. **`functions/api/relay.ts`** — stvarni submit kroz viem
   `walletClient` na Gnosis RPC; opcionalno batch deploy signer proxya
   i Safea kroz `MultiSendCallOnly` ako su counterfactual.

## TODO

- **Phase 3: backend pubkey registry** — kad user otvori `wallet.domovina.ai` na
  potpuno novom uređaju (npr. dobio iPhone, prvi put login), iCloud Keychain je
  sync-ao passkey, ali localStorage je prazan → "Otvori drugi pohranjeni
  passkey" baca jer nemamo `credentialId → pubkey` mapping lokalno. Fix:
  opt-in backend endpoint na `mpt.domovina.ai/api/wallets` koji čuva
  `{ credentialId: pubkey }` mapiranje. Pri create-u POST registry, pri pick-up
  unknown credentialId → GET lookup → derive Safe address. Privacy: server vidi
  samo mapping, ne i privatni ključ ni tx detalje. Marketinški: "Sign in across
  devices" toggle u Settings.

## Otvorena pitanja

- **`pay.domovina.ai` payment intent API spec** — trenutni stub
  pretpostavlja `POST /api/payment-intent` s `{ destination, amountEur }`
  i odgovor `{ id, epcQr, iban, bic, reference, amountEur, destination, state, createdAt }`.
  Treba potvrditi stvarnu shape-u i možda CORS politiku za
  `wallet.domovina.ai` origin.

- **SSE endpoint** — `GET /api/payment-intent/:id/stream` (Durable Object)
  je također pretpostavka — vidi `feedback_sse_workers_durable_objects.md`.

- **iOS WebAuthn UX** — testirati na stvarnom iPhoneu da li
  `residentKey: 'required'` daje očekivani Face ID + Keychain flow.

- **Recovery / multi-passkey** — v1 je 1/1 single passkey. v2 dodaje
  "Add another device" flow s WebAuthn hybrid transport + `addOwner` tx.

- **RIP-7212 na Gnosisu** — Daimo fallback je sigurnosna mreža (200k gas
  vs 3.5k). Treba potvrditi precompile statusno prije optimizacijskih
  odluka, ali nije blocker.
