# Monerium outreach email (draft)

> Pošiljatelj: Matija Stepanić, ITalk d.o.o. · Primatelj: Monerium partnerships
> (partners forma na monerium.com/partners + eventualno postojeći kontakt s KYB onboardinga).
> Status: DRAFT v1, 2026-06-11 — pregledaj, prilagodi volumene/detalje i pošalji.
> Kontekst i pregovaračka pozicija: [INTERNO-monerium-tos-analiza.md](INTERNO-monerium-tos-analiza.md).

---

**Subject:** Partnership inquiry — per-user onboarding & dedicated IBANs for a self-custody wallet (existing business customer)

Dear Monerium team,

I am Matija Stepanić, founder of **ITalk d.o.o.** (Croatia), an existing Monerium business
customer (KYB completed; we hold a company IBAN and use the API under the Private plan).

We have built **DOMOVINA Wallet** — a fully self-custodial wallet on Gnosis Chain. Each user
owns a Safe smart account controlled exclusively by their own passkey (WebAuthn signer,
ERC-1271) and an optional recovery EOA; we never hold keys and never have access to user
funds. EURe is the wallet's native currency, and we are currently building a Gnosis Pay card
integration on top of the same Safes. The product targets Croatian users (donations,
community payments, everyday spending).

**What we have today.** As an MVP we used our own business account as the on-ramp: SEPA
payments arrive on our company IBAN with a structured reference, and our backend forwards the
corresponding EURe on-chain to the end user's Safe. This was the fastest way to validate the
product, but we understand from your Business Terms (§16) that operating this pattern at
scale requires either your explicit approval or a formal distributor arrangement — and
frankly, it is also not the architecture we want long-term.

**What we want to build.** We would like to move to the model your platform is clearly
designed for: **each end user onboards as a Monerium customer through our app, passes your
KYC, gets their own profile and their own personal IBAN, and EURe is minted directly to
their own self-custody Safe** — with ITalk fully outside the flow of funds, acting purely as
the software interface. Ideally the user could also log in at monerium.app and see the
Safe addresses created in our wallet linked to their profile.

Questions we would appreciate your guidance on:

1. **Which integration plan fits best** — OAuth or Whitelabel (with KYC Sharing via Sumsub)?
   We want both a *dedicated per-user IBAN* and, if possible, the user's ability to access
   their account at monerium.app. Your docs list OAuth with a "shared" IBAN and Whitelabel
   with "dedicated" — what combination achieves both?
2. **Safe + passkey support**: our Safes are owned by a WebAuthn (P-256) signer and verified
   via EIP-1271. We saw address linking supports Safe EIP-1271 signatures — any caveats for
   counterfactual (not-yet-deployed) Safes or passkey-based owners?
3. **Partnership process**: what does the application/review look like for our profile, and
   what volumes/requirements do you expect at our stage?
4. **Transitional period**: until per-user onboarding ships, we would like your written
   guidance (or approval under §16(9)) for continuing the current reference-based forwarding
   at low volume — or your advice to pause it.
5. **Public documentation**: we maintain a public compliance document describing our
   non-custodial architecture and our providers' regulated roles. Per your API Terms (§4) we
   would like your written permission for the parts describing the Monerium integration.
6. **Gnosis Pay interplay**: our card users may also receive a Monerium IBAN through Gnosis
   Pay's integration. How should we think about one-user-one-profile across a direct
   ITalk↔Monerium partnership and the Gnosis Pay wrapper, so users don't hit the
   single-account constraint?

We are a small, fast-moving team; the wallet, relayer and Gnosis Pay onboarding are already
built, so we can integrate quickly against sandbox. A 30-minute call would be ideal.

Thank you, and congratulations on the platform — "you handle the product experience,
Monerium handles the regulation" is exactly the division of labour we want.

Best regards,
Matija Stepanić
ITalk d.o.o., Croatia
stepanic.matija@gmail.com · wallet.domovina.ai / pay.domovina.ai

---

## Napomene prije slanja (HR, interno)

- Točku "What we have today" smo namjerno napisali transparentno ali bez samooptuživanja —
  prikazuje MVP fazu + proaktivni prelazak na ispravan model. Ako želiš mekše, izbaci
  referencu na §16 i samo traži "guidance on the right setup".
- Provjeri prije slanja: točan volumen raila (mjesečno EUR / broj transakcija) ako pitaju.
- Sandbox postoji (docs.monerium.com/sandbox) — implementaciju počinjemo tamo bez čekanja
  odgovora; vidi docs/prompts/monerium-implementation-prompt.md.
