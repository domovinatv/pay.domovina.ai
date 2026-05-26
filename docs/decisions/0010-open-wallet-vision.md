# ADR 0010 — Open-Wallet vision: wallet-wasp eksperiment kao seed za open-source WASP wallet template

**Status:** Accepted (vision-level commitment; concrete deliverables incubate inside wallet-wasp experiment).
**Date:** 2026-05-26
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits from:**
- ADR 0001 (self-custody — never compromised even when "open")
- ADR 0007 (brand-as-data — prerequisite for genericization)
- ADR 0008 (multi-passkey Safe — peer-linking pattern is reusable)
- ADR 0009 (iframe SDK — third-party embedding is reusable)

## Context

[wasp-lang/open-saas](https://github.com/wasp-lang/open-saas) je oficijelni
WASP-blessed open-source SaaS starter template — built on top of WASP, ships
sa auth + Stripe payments + admin dashboard + AI integration + blog +
landing page. Domain: [opensaas.sh](https://opensaas.sh). License: MIT.
Funkcionira istovremeno kao:
- **Template** (`git clone` + replace branding → instant SaaS),
- **Showcase** (demonstrira WASP capabilities na realnom use-case-u),
- **Community magnet** (PR-ovi, issues, blog posts oko jednog šabona).

Pay.domovina.ai ekosistem je već **strukturno najbliža analogija u Web3 prostoru**:
- ADR 0007 — white-label (brand-as-data) — analog tenant-i u SaaS-u
- ADR 0008 — multi-passkey Safe — analog organizacijskih korisnika
- ADR 0009 — iframe SDK — analog SaaS widget-a za 3rd-party embedding
- Phase 5 (ADR 0003–0006) — onchain attestation, sybil-resistance, zk privacy
- Production-validirani full stack (ADR-jevi su backfill-ovi shipped feature-a)

Trenutni wallet-wasp eksperiment (`experiments/wallet-wasp/`, dokumentiran
u `docs/plans/wallet-wasp-experiment.md`) rewrite-a ovaj stack u WASP. Vizija
ovog ADR-a: **taj rewrite nije samo single-use showcase, već potencijalni seed
za open-wallet — analog open-saas-u u Web3 prostoru.**

Ako se WASP-rewrite incubation pokaže tehnički uspješnim, sljedeća iteracija je
**genericizacija** (skidanje DOMOVINA-specific hard-codeova) i potencijalna
selidba pod novi identitet — `domovinatv/open-wallet` ili, idealno,
`wasp-lang/open-wallet` (sa WASP blessing-om kao oficijelni template).

## Decision

### Decision 1 — Vision commitment

Wallet-wasp eksperiment se tretira kao **seed za open-wallet**, ne kao
single-use rewrite. Sve arhitektonske odluke u eksperimentu se vagaju protiv
budućeg generic-template use-case-a (any team building passkey-Safe self-
custody wallet), ne samo protiv domovina.ai use-case-a.

Ne čekamo da WASP tim "blessing-a" naziv — incubation se odvija pod
`domovinatv/wallet-wasp`, naziv "open-wallet" se rezervira za fazu kad je
genericizacija dovršena.

### Decision 2 — Naming convention follows open-saas

Buduća transition path:

| Faza | Repo | Domain (ako se ostvari) | License |
|---|---|---|---|
| Incubation (sad) | `domovinatv/wallet-wasp` | n/a | MIT |
| Generic preview | `domovinatv/open-wallet` (rename) | `open-wallet.dev` ili sl. (TBD — `openwallet.sh` zauzet) | MIT |
| WASP-blessed (ideal) | `wasp-lang/open-wallet` (transfer) | upstream odlučuje | MIT (preserved) |

`openwallet.sh` je zauzet od non-affiliated entity — to **nije blocker**, samo
preferiramo različitu domenu. Konvencija je open-saas → open-wallet (repo
naming, MIT license, public-template karakter), ne identifier match.

### Decision 3 — Architectural constraints od Faze 1 nadalje

Sve od Faze 1 wallet-wasp eksperimenta se gradi pod ovim "future-template"
constraint-ima, čak i kad je MVP scope čisto domovina.ai:

**3a. Brand-as-data, ne hard-code.** Naslov, boje, wordmark, supported chains,
RPC endpoints, supported tokens, recipient defaults — sve dolazi iz env
varijabli ili `brand.config.ts` fajla. Nikad `DOMOVINA` u src/ codu.

**3b. Generic naming.** Route-i: `/wallet`, `/send`, `/receive`, ne
`/domovina-wallet`. Prisma modeli: `User`, `Passkey`, `Wallet`,
`PaymentIntent`, ne `DomovinaPasskey`. Imenovani su po funkciji, ne brand-u.

**3c. Configurable chain.** Default Gnosis, ali ne hard-coded. Chain ID i
EURe contract address dolaze iz `brand.config.ts`. Treba biti trivijalno
swap-ati na drugi EVM chain ili stablecoin.

**3d. Pluggable attestation providers.** Phone (ADR 0003), Croatian eID
(ADR 0005), zkProof (ADR 0006) su naša specijalna implementacija — open-wallet
template treba **interface** za attestation providers, gdje smo mi jedan od
mnogih implementacija. Implementacijska detalja stoje, ali izlažu se preko
generic SBT/attestation API-ja.

**3e. Optional features su opt-in.** Iframe SDK (ADR 0009) i multi-passkey
peer linking (ADR 0008) su konfigurabilne. open-wallet user može krenuti s
minimalnim setupom (passkey + Safe + Send + Receive) i progressively enable
napredne feature-e.

### Decision 4 — Incubation period i kriteriji za rename

Wallet-wasp ostaje pod `domovinatv/wallet-wasp` dok se ne ispune sva tri
kriterija:

1. **Tehnički uspjeh**: MVP (5 features, viz plan doc) radi end-to-end na
   live Gnosis mainnetu, paritet s referentnim wallet-om.
2. **Brand-as-data audit**: grep `domovina` / `DOMOVINA` u src/ vraća
   prazno (osim u brand config fajlu i copyright header-ima).
3. **WASP team feedback**: Matija ili Martin Šošić su pregledali eksperiment
   i odbijaju ILI prihvaćaju upstream-uvojnu (community contribution scope).

Tek tada otvaramo `domovinatv/open-wallet` (ili rename `wallet-wasp` →
`open-wallet`) i ažuriramo memory + dokumentaciju.

### Decision 5 — Promotion path

Kad incubation isporuči, ovo je promotion path-ovi (od najmanjeg do
najvećeg ambicija):

1. **Blog post + repo share** (minimum): "Rewriting a production passkey-Safe
   wallet in WASP" — članak na domovina.ai/blog i wasp.sh/blog (cross-post),
   tweet od @WaspLang-a, repo u WASP-ovom "Built with WASP" showcase listu.
2. **WASP community template** (medium): wallet-wasp postaje preporučen
   template u `wasp new -t wallet-passkey` (kad WASP doda multi-template
   support). Ostaje pod domovinatv/.
3. **Oficijelni open-wallet** (maximum): WASP tim transferira repo pod
   wasp-lang/ org, paralelno s open-saas. To traži zajedničku odluku s
   Matijom i Martinom Šošićem — ne unilateral.

Tier 1 je guaranteed deliverable; Tier 2/3 su aspirational i ovise o WASP
team-ovoj evaluaciji + community traction-u.

## Consequences

### Pozitivne

- Arhitektonska disciplina od dana 1: brand-as-data, generic naming, plugin
  patterns — sve to su default-i koje bismo ionako trebali, ali često ih
  zaobiđemo pod time pressure-om. Vision daje "nećemo to napraviti" izgovor
  za dobre prakse.
- Maximizira showcase value Matiji/Martinu — nije "evo, prepisali smo svoj
  app", nego "evo, gradimo open-wallet koji bi mogao biti vaš sljedeći
  open-saas".
- Community contribution path postaje organski (passkey skill za plugin,
  WASP core PR za custom auth method, primjeri za drugu generaciju
  open-wallet korisnika).
- Privlači domovina.ai ekosistem development partnere (drugi krajnji
  korisnici otvorenog template-a → potencijalno doprinose nazad u branch
  domovina.ai-a).

### Negativne

- **Naming risk**: ime "open-wallet" nije zaštićeno; netko drugi može
  registrirati `wasp-lang/open-wallet` prije nas. Mitigation: pravovremeno
  komuniciranje s Matijom/Martinom, eventualno preliminary commit na
  WASP Discord da je name reserved.
- **Genericizacija troši čas**: brand-as-data za Phase 5 attestation
  providere je netrivialan; možda traži interface design koji bismo inače
  preskočili.
- **Domain dilemma**: `openwallet.sh` zauzet; možda nikad nećemo imati
  domain match s open-saas-om (`opensaas.sh` ↔ ?). Brand identity
  trpi blagi mismatch.
- **Phase 5 ADR-ovi (0003–0006) su jako Croatian-specific** (Certilia,
  eID, OIB hash). Genericizacija ovih za open-wallet vjerojatno znači
  "Croatian eID" je samo jedna od mnogih nation-specific provider-a koje
  template demonstrira, ne core. To je puno više rada od MVP-a.

### Neutralne

- Phase 5 (ADR 0003–0006) implementacija i dalje ide pod domovina.ai
  (ima OIB+eID dependencies); open-wallet template samo izlaže interface,
  ne implementaciju.
- Production wallet.domovina.ai ostaje untouched (kao i u wallet-wasp
  plan doc-u eksplicitno rečeno) — ovaj ADR ne mijenja produkcijski put.

## Open questions

- [ ] Koja domena za open-wallet ako se rename desi? `open-wallet.dev`,
      `openwallet.app`, `openwalletkit.com`? Treba provjeriti dostupnosti.
- [ ] Treba li paralelni `wasp-lang/claude-plugins` fork (za passkey skill)
      ići istovremeno s wallet-wasp incubation-om, ili nakon MVP-a?
- [ ] Phase 5 ADR-ovi (0003–0006) — implementiramo li ih u domovina.ai-specific
      varijanti unutar wallet-wasp eksperimenta (i ostavljamo izvan open-wallet
      template-a), ili dizajniramo attestation interface od dana 1 (više rada
      sada, manje refactor kasnije)? Vjerojatno: drugo, jer Decision 3d ovo
      diktira.
- [ ] Kako mjeriti "WASP team approval" za rename → open-wallet? Sastanak
      s Matijom i Martinom Šošićem, ili LinkedIn DM s konkretnim demo URL-om?

## References

- [wasp-lang/open-saas](https://github.com/wasp-lang/open-saas) — analog koji slijedimo
- [opensaas.sh](https://opensaas.sh) — domain konvencija
- `docs/plans/wallet-wasp-experiment.md` — tactical plan unutar kojeg ova vizija živi
- ADR 0001, 0007, 0008, 0009 — naslijeđene konvencije koje open-wallet preuzima
- Phase 5 ADR-ovi (0003–0006) — feature-i koji se genericiziraju kroz attestation interface
