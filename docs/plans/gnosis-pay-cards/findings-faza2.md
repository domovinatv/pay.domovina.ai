# Faza 2 — zapis odstupanja i otvorenih točaka

> Datum: 2026-06-11 · Shipped: prošireni `wallet/src/lib/gnosispay.ts` (kartice, balansi,
> ModuleTx, transakcije) + `wallet/src/components/GpCardScreen.tsx`. Build zelen; e2e test
> NIJE moguć bez KYC-approved accounta (Faza 4 / Matija).

1. **Feature flag `VITE_GP_ENABLED`**: ruta /kartica i home ulaz su skriveni bez flaga —
   produkcijski SIWE pada ("SIWE domain not allowed") dok wallet.domovina.ai nije na GP
   partner whitelistu (TODO-MATIJA #1). Lokalni dev: `VITE_GP_ENABLED=1 npm run dev`.
   Nakon whitelista: uključiti flag u build skripte (odluka po tenantu — TODO-MATIJA #7).
2. **EURe V1/V2 i dalje otvoreno**: `gnosispay/account-kit` example config
   (`examples/config/safe.ts`) citira **V1** (`0xcB444e90D8198415266c6a2724b7900fb12FC56E`)
   kao token Roles allowancea. Punjenje šalje isključivo V2 (jedino što wallet drži);
   do empirijske potvrde s pravim GP Safe-om vrijedi small-amounts gate. Pitanje je na GP
   call listi (TODO-MATIJA #2).
3. **ModuleTx potpis**: GP vraća puni EIP-712 paket `{domain, primaryType: ModuleTx, types,
   message: {data, salt}}`; potpisujemo `hashTypedData` → SafeMessage wrap → passkey 1271 +
   `smartWalletAddress`. NETESTIRANO end-to-end (treba KYC + deployan GP Safe) — prvi
   stvarni test odlučuje radi li GP-ov verifier 1271 i na signing endpointima (fallback:
   Plan B interop EOA potpisuje iste pakete ECDSA-om, UI ostaje isti).
4. **Drugi Delay-owner = recoveryOwner** (ADR 0013): bootstrap računi bez recovery ownera
   dobivaju uputu "Postavke → Proširi pristup" prije otključavanja većih punjenja.
5. **Punjenje koristi postojeći Send** (`/send?to=<gpSafe>&amount=…` prefill) — nula novih
   transakcijskih putova; GP Safe adresa se razrješava svježe pri SVAKOM punjenju
   (`/user` + `/safe/migration`, nikad keš).
6. **Kartične transakcije**: `results[]` su već thread-level eventi (Payment/Refund/Reversal
   po `threadId`) — nije trebalo ručno grupiranje; minor-units formatiranje po
   `billingCurrency.decimals`.
7. PAN/CVV prikaz NIJE u ovoj fazi (PSE čeka partner cert, Faza 3) — UI upućuje na
   app.gnosispay.com kao prijelazno rješenje, jasno komunicirano.

## Što blokira sljedeće korake

| Korak | Blokira |
|---|---|
| Faza 3 (webhooks, PSE, Apple Pay vodič) | TODO-MATIJA #1 (PartnerID/APP_ID) + #3 (PSE cert) |
| Faza 4 (produkcija, e2e) | TODO-MATIJA #1 (domain whitelist) + #4 (Matijin KYC) |
| EURe V1/V2 potvrda | GP call (TODO #2) ili prvi e2e GP Safe |
