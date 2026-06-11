# Faza 1 — zapis odstupanja i otvorenih točaka

> Datum: 2026-06-11 · Shipped: `wallet/src/lib/gnosispay.ts`, `wallet/src/state/gpStore.ts`,
> `wallet/src/routes/Kartica.tsx`, `backend/migrations/0012_gnosispay.sql`,
> `backend/src/gnosispay/` (deployano + migracija primijenjena na remote D1).

1. **Dev SIWE domena**: zbog WAF nalaza iz Faze 0 (loopback URL-ovi blokirani u bodyju)
   klijent na `localhost`/`127.0.0.1` gradi SIWE poruku s domenom GP-ove helper aplikacije
   (`gnosispay-api-siwe-demo.vercel.app`), na svim ostalim hostovima `window.location.host`.
   Produkcija proradi tek s partner whitelistom (TODO-MATIJA #1).
2. **`general-tos` auto-accept**: ToS korak svejedno renderira checkbox za sve neprihvaćene
   dokumente, a 422 "already accepted" se guta — UI compliance bez duplog POST-a.
3. **OTP signup**: UI prvo pokuša signup bez OTP-a (tranzicijski period); ako server zatraži
   kod, automatski šalje `signup/otp` i pokazuje polje. Kad GP ukine tranziciju, flow već radi.
4. **Sumsub iframe na iOS Safari PWA NIJE testiran s kamerom** (treba pravi uređaj) —
   fallback "Otvori provjeru u Safariju" je ugrađen; empirijski test ide uz Fazu 4 e2e.
5. **Mirror sync**: `POST /api/gp/sync` šalje se fire-and-forget nakon svakog uspješnog
   `refresh()`; `gp_signer` je immutable na serveru (COALESCE čuva prvi upis).
6. Default daily limit pri deployu namjerno NIJE poslan (GP default 350) — odluka 200 € čeka
   TODO-MATIJA #7; UI za promjenu limita dolazi u Fazi 2.
