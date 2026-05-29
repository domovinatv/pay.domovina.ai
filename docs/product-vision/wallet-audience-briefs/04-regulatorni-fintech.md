# Audience Brief 04 — Regulatorni / Fintech

> **Format za / Format for:** policy, fintech, grant reviewers, e-money /
> eID stakeholders. Compliance posture + civic vision. **Derived from** the
> [SSOT](../wallet-blog-sourcebook.md) and ADRs 0001/0004/0005/0006.

| | |
|---|---|
| **Jezik / Language** | HR + EN usporedno / side by side |
| **Kanali / Channels** | LinkedIn, fintech/policy blog, grant prijave, partner deks |
| **Ton / Tone** | Mjeren, precizan o usklađenosti, jasan o tome što je vizija vs. isporučeno. Measured, precise on compliance, explicit about vision vs. shipped. |
| **Naglasak / Lean into** | MiCA/EMT pozicija, Monerium bridge, hrvatski eID (Certilia, eIDAS High), sybil-otpornost, GDPR (hash-only, no plaintext PII). |

## Pitch
**HR.** MiCA-svjestan self-custody novčanik za EURe (Monerium EMT), s
putom prema sybil-otpornom, GDPR-usklađenom onchain identitetu vezanom uz
provjerenog hrvatskog građanina kroz eID — bez otkrivanja identiteta.

**EN.** A MiCA-aware self-custody wallet for EURe (Monerium EMT), with a
path to sybil-resistant, GDPR-compliant on-chain identity tied to a
verified Croatian citizen via eID — without revealing identity.

## Ključne poruke / Key messages
1. **EMT, ne yield / EMT, not yield** — EURe je e-money token; MiCA
   blokira yield-to-holders. Mi to poštujemo. / MiCA blocks yield-to-
   holders; we honor it.
2. **GDPR by design** — telefon se čuva **samo kao hash** (PHONE_PEPPER);
   nikad sirovi OIB/broj na disku. / phone stored as **hash only**; never
   raw national ID on disk.
3. **eIDAS High preko Certilije / via Certilia** — Croatian eID (mIN) kao
   identitetski primitiv (ADR 0005).
4. **No cloud-held keys** — verifier mesh dizajniran tako da nijedan cloud
   ne drži ključ za potpisivanje (ADR 0004).

## Blogovi / Posts (iz backloga)
- **B8** — "Self-custody i MiCA: EURe kao EMT" (HR+EN) → `hero`, `receive-sepa`
- **B9** — "Onchain glasanje vezano uz hrvatskog građanina — anonimno"
  (HR+EN) → `phone-wizard` · **vizijski / visionary**

## Reference / References
- [ADR 0001](../../decisions/0001-no-server-side-recovery.md) — self-custody invariant
- [ADR 0005](../../decisions/0005-phase-5d-croatian-eid-attestation.md) — Croatian eID
- [ADR 0006](../../decisions/0006-phase-5e-zkproof-anonymous-attestation.md) — zkProof anonymity
- [ADR INDEX](../../decisions/INDEX.md) — full roadmap + status

## CTA
"Kontakt za partnerstvo / regulatorni razgovor: stepanic.matija@gmail.com
(ITalk d.o.o.)."

## Caveati / Guardrails (obavezno / binding)
- **Phase 5 (eID, SBT, glasanje, zkProof) je PLANIRANO/ISTRAŽIVANJE — 0
  koda za verifier mesh.** Uvijek futur. / roadmap/research, future tense
  always.
- Anonimnost (zkProof, ADR 0006) je 12–24mo + audit budžet. Ne tvrdi
  "anonimno danas". / not "anonymous today".
- Ne tvrdi pravni status/licencu koju nemaš; opiši *poziciju* prema MiCA,
  ne *odobrenje*. / describe MiCA *posture*, not approval you don't hold.
