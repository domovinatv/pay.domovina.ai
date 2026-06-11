# Faza 0 — empirijski nalazi i odluka Plan A/B

> Datum: 2026-06-11 · Alat: `scripts/gp-spike.mjs` (Node + viem + curl transport) ·
> Svi testovi izvedeni isključivo s **throwaway** EOA-ima i throwaway Safe-om
> (gas za deploy sponzorirao naš relayer kao external sender — nikad owner).

## ✅ ODLUKA: **Plan A — DOMOVINA Safe kao GP identitet (ERC-1271)**

Sve što je testabilno prije pravog KYC-a prošlo je sa smart-account identitetom:

| Test | Rezultat |
|---|---|
| SIWE login s EOA → JWT | ✅ 200, JWT `{signerAddress, chainId:100, partnerId:null}`, ttl do 24 h |
| **SIWE login s deployanim Safe-om (ERC-1271)** | ✅ **200** — GP verificira na **Gnosis chainu** (SafeMessage domena chainId 100, Safe postoji samo na Gnosisu) |
| Signup sa Safe identitetom | ✅ 201 — Safe adresa postaje `signInWallets[0]` i uredno se vodi u `GET /eoa-accounts` (ime endpointa je legacy, prima smart accounte) |
| Drugi signup istom adresom | ✅ 409 `"Wallet address already associated with another account"` — nepovratnost potvrđena |
| ToS list + accept sa Safe JWT-om | ✅ 200 |
| `GET /kyc/integration?lang=hr` sa Safe JWT-om | ✅ 200 → `{type: SUMSUB_WEB, url: https://in.sumsub.com/websdk/p/…}` |
| `POST /safe/deploy` sa Safe JWT-om | ⚠️ 422 `"User is not KYC approved"` — **identično kao s EOA JWT-om**; dokumentirani `403 Missing signer address` se NE pojavljuje prije KYC gatea |

**Obrazloženje odluke**: ERC-1271 login, signup, ToS i KYC initiation — cijeli onboarding do
KYC-a — rade sa Safe-om kao identitetom bez ijednog posebnog parametra (`smartWalletAddress`
treba tek za EIP-712 signing endpointe). Naš passkey→ERC-1271 put je onchain već
produkcijski validiran (Send rail), pa Plan A ne uvodi nijedan novi kriptografski mehanizam.

**Rezidualni rizik (prihvaćen)**: ponašanje `POST /safe/deploy` NAKON KYC approved sa
smart-account signerom nije testabilno bez pravog KYC-a (Sumsub traži prave dokumente).
Ako Faza 4 e2e udari u `403 Missing signer address`, fallback je Plan B (interop EOA signer)
bez ikakvih izmjena u UI arhitekturi — pitanje je već na listi za GP call (TODO-MATIJA #2).
Postmortem-0001 pravilo ostaje: ≥2 Delay-ownera prije punjenja > 50 €.

## Nalazi koji odstupaju od dokumentacije (docs vs. stvarnost)

1. **WAF blokira Node/undici TLS fingerprint** — identičan request: `fetch` → 403
   `WAFForbidden`, `curl` → prolazi. Spike skripta zato shellta u curl. Za browser (Faza 1)
   nevažno; za buduće server-side pozive (webhook handshake i sl.) važno znati.
2. **WAF blokira SVAKI loopback URL u bodyju** (`http(s)://localhost[:port]`, `127.0.0.1` —
   svejedno; `http://example.com` prolazi). Posljedica: dokumentirani "localhost je
   auto-whitelistan" SIWE flow je **neupotrebljiv** — SIWE poruka s `URI: http://localhost:5173`
   pada na WAF-u prije app layera, neovisno o klijentu. ⚠️ Vrlo vjerojatno pogađa i browser
   dev s localhosta (pravilo inspicira body). **Workaround za dev**: SIWE poruka s domenom
   GP-ove helper aplikacije `gnosispay-api-siwe-demo.vercel.app` (linkana iz njihovih docs
   upravo za API eksploraciju) — whitelistana je i prolazi. Nakon partner registracije
   koristiti vlastitu whitelistanu staging domenu.
3. **`wallet.domovina.ai` → 403 `"SIWE domain not allowed"`** — app-level whitelist potvrđen;
   blokira Fazu 4, ne Faze 0–2 (TODO-MATIJA #1).
4. **Signup radi BEZ email OTP-a** — spec kaže "optional during transition period"; trenutno
   201 bez `otp` polja. Faza 1 UI svejedno gradi OTP korak (tranzicija može završiti).
5. **5 ToS tipova, ne 4** — uz dokumentirane `general-tos`, `card-monavate-tos`,
   `cashback-tos`, `privacy-policy` postoji i **`monavate-privacy-policy`**.
6. **`general-tos` se auto-prihvaća pri signupu** (`acceptedAt` = timestamp signupa) —
   UI mora prikazati checkbox SVEJEDNO (compliance), ali POST za njega vraća 422
   "You have already accepted these terms".
7. **CORS uredno reflektira `http://localhost:5173`** s `allow-credentials: true` — browser
   dev s localhosta radi na CORS razini; jedina prepreka je WAF body pravilo iz točke 2.
8. **JWT od signupa ima exp = 1 h** (SIWE challenge JWT ima zatraženi ttl, do 24 h) — lazy
   re-auth na 401 obavezan, kako je i planirano.
9. `GET /safe/config` prije deploya vraća `{hasNoApprovals: true, accountStatus: null}` —
   `accountStatus` je `null`, ne enum vrijednost; state machine treba null-guard.

## Artefakti

- Spike skripta: `scripts/gp-spike.mjs` (komande: `gen`, `auth`, `signup`, `signup-dup`,
  `deploy-safe`, `auth1271`, `gp-safe-deploy`, `get`/`post` passthrough, `mailtm`, `log`)
- Lokalni state + potpuni log svih odgovora: `scripts/.gp-spike-state.json` (gitignored)
- Throwaway Safe (1271 test): `0x44874254Eed09a9Dbac4DdF7A02738C69EfB54B6`
  (owner throwaway EOA B + dummy P-256 signer; deploy tx
  `0x4d3c7b5375be2d8db8cebc43213b9efa7f2bf2fe6b41078051b6bdfa1106e4b4`)
- Throwaway GP useri: 2 (EOA identitet + Safe identitet), oba `kycStatus: notStarted`,
  disposable mail.tm emailovi

## Tehnika ERC-1271 potpisa (za Fazu 1 implementaciju)

```
dataHash  = EIP-191 hashMessage(siweMessageString)
potpis    = EIP-712 nad Safe domenom {chainId:100, verifyingContract: safe}
            tipa SafeMessage{ message: bytes } gdje je message = abi.encode(dataHash)
→ za passkey Safe: ista ceremonija kao Send, samo nad SafeMessage hashom
  (encodeWebAuthnSignature blob kao contract-signature, v=0 grana checkSignatures)
→ lokalna provjera prije slanja: publicClient.verifyMessage({address: safe, message, signature})
```

GP-u se šalje standardni `{message, signature}` — bez `smartWalletAddress` polja na
`/auth/challenge` (to polje treba tek na EIP-712 signing endpointima).
