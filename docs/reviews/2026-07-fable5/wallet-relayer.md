# Wallet Relayer (CF Pages Functions) — nalazi (WR-*)

Podsustav: `wallet/functions/` — **ovdje se troši pravi gas i šalju pravi
TX-ovi.** Verificirano čitanjem `relay.ts`, `_lib/{safe,limits,relayer,turnstile,
http}.ts`, `bootstrap-deploy.ts` (djelomično), `relay/status.ts`.

---

## WR-01 [MONEY-BUG] Relayer EOA nonce race na paralelnim `/api/relay`

**file:** `wallet/functions/api/relay.ts:241` (`sendHotPath` →
`wallet.sendTransaction` bez noncea)

**Failure scenarij (verificiran):** Dva istovremena `/api/relay` zahtjeva
(različiti korisnici, ali isti relayer EOA) izvrše se u dva CF isolatea
istovremeno. Oba pozivaju `wallet.sendTransaction({to: safe, data: exec})` bez
eksplicitnog noncea → viem svakom dohvati `eth_getTransactionCount('pending')`.
Ako oba dobiju isti pending nonce, drugi tx zamijeni prvi (isti nonce) → prvi
korisnikov transfer tiho nestane iako je klijent već prikazao "Poslano ✓"
(relay je vratio `{ok:true, txHash}` za tx koji je kasnije replace-an). Isti
root kao BW-02 na backend forward EOA.

**Fix:** Serijalizirati nonce po relayer EOA — nonce manager (viem
`nonceManager`) ILI per-EOA lock preko KV/DO oko broadcasta. Za CF, Durable
Object koji drži nonce counter je robusno rješenje.

**Acceptance:** Load test: N istovremenih `/api/relay` s različitih signera →
svih N txova lande s uzastopnim nonceovima, nijedan replace-an.

---

## WR-02 [RISK / MONEY-latent] Cold-path FALLBACK bez CREATE2 guarda

**file:** `wallet/functions/api/relay.ts:362` (`sendColdPath(signerNow, safeNow)`
u hot-failed grani)

**Failure scenarij (verificiran):** Primarna cold grana (`!safeDeployedPre`,
linija 283) izvršava CREATE2 consistency guard (`predictedSafe !== safeAddress`
→ 400, linija 291). ALI fallback grana — kad je `safeDeployedPre=true` (getCode
rekao deployed), hot path padne, pa re-check pokaže `safeNow=false` — ide na
`sendColdPath(signerNow, false)` (linija 362) **bez tog guarda**. Ako
`safeAddress` ne odgovara `predict(coldOwners, saltNonce)` (npr. RPC nekonzistencija
+ bootstrap wallet čija adresa deriva iz ephemeral EOA, ne iz signera), MultiSend
deploya Safe na `predict(coldOwners)` = adresa X, a `execTransaction` gađa
`safeAddress` = adresa Y (bez koda) → EVM status=1, tiho, EURe stranded (memory:
evm-call-to-empty-address). Okidač je rijedak (RPC deployed→undeployed flip), ali
posljedica je stranding.

**Fix:** Izvući guard u helper i pozvati ga i na fallback grani prije
`sendColdPath` kad `skipSafe=false`. Ako `predictedSafe !== safeAddress` →
odbiti (400) umjesto deploya.

**Acceptance:** Test: hot-failed + `safeNow=false` + mismatch adresa → 400
"does not match", nema broadcasta. Match → deploy prolazi.

---

## WR-03 [RISK] Non-atomni KV gas capovi — "hard ceiling" je mek pod concurrencyjem

**file:** `wallet/functions/_lib/limits.ts:122` (`bumpAbuse`), `:99`
(`readAbuseState`)

**Failure scenarij (verificiran):** `readAbuseState` čita `globalUsed`/`ipUsed`,
`capExceeded` provjeri, `bumpAbuse` upiše `current+1`. Sve read-then-write na KV
(nema atomskog inkrementa, eventually consistent). Burst od M istovremenih
zahtjeva svi pročitaju isti `globalUsed` < limit → svi prođu → globalni gas cap
prekoračen faktorom concurrencyja. Modul komentar (linija 9-16) priznaje ovu
slabost ZA per-signer cap, ali `capExceeded` global granu naziva "hard ceiling"
dok ima istu slabost — stvarni drain backstop je mekši nego dokumentirano.

**Ublaženo:** Turnstile (kad je `TURNSTILE_SECRET` postavljen) je human-attestation
sloj iznad; ali fail-open je default (WR-06).

**Fix:** Za istinski hard global cap treba atomski counter (Durable Object).
Minimalno: uskladiti dokumentaciju/naziv i sniziti globalni limit s obzirom na
mogući overshoot, ili dodati DO za global counter.

**Acceptance:** Load test: burst > globalDaily istovremenih → potrošeni gas ≤
globalDaily + mali ε (ne × concurrency). Ili eksplicitno dokumentirati overshoot
faktor.

---

## WR-04 [BUG-low] `readCount` ne coerca garbage u 0 kako tvrdi

**file:** `wallet/functions/_lib/limits.ts:32`

**Failure scenarij:** `Math.max(0, Number(kv.get(key) ?? 0))`. Za `null` →
`Number(0)=0` OK. Ali za ne-numerički string → `Number("x")=NaN`, a
`Math.max(0, NaN) = NaN` (ne 0). Doc-komentar kaže "coercing missing/garbage to
0" — implementacija to NE postiže. Ako bi garbage ikad bio upisan, `NaN >= limit`
je `false` (cap fails OPEN) i `NaN+1=NaN` se upiše (trajno truje counter do TTL).
**Nereachable normalnim putem** (`bumpCount` uvijek piše numerički string), pa
low severity — ali doc/impl mismatch koji bi pri budućoj promjeni zapisa postao
opasan.

**Fix:** `const n = Number(...); return Number.isFinite(n) ? Math.max(0, n) : 0;`

**Acceptance:** `readCount` na ključu s vrijednošću `"garbage"` → 0.

---

## WR-05 [RISK] Rate-limit/Turnstile izvan try/catch → HTML 1101 umjesto JSON

**file:** `wallet/functions/api/relay.ts:168` (readCount/readAbuseState/
verifyTurnstile prije `try` na `:197`)

**Failure scenarij (verificiran):** `readCount`, `readAbuseState`,
`verifyTurnstile` (linije 168-195) su IZVAN glavnog `try/catch` (koji počinje na
197). KV/Turnstile infra hiccup → neuhvaćena iznimka → CF vrati generički HTML
error 1101, a klijent očekuje JSON `{ok:false,error}` → parse fail, korisnik
vidi opaki crash umjesto poruke.

**Fix:** Obuhvatiti pre-flight provjere istim try/catch (ili vlastitim) koji
vraća JSON 500.

**Acceptance:** Mock KV throw → odgovor je JSON `{ok:false}`, ne HTML.

---

## WR-06 [RISK] Turnstile tiho isključen ako je secret krivo imenovan/nedostaje

**file:** `wallet/functions/_lib/turnstile.ts:29`

**Failure scenarij (verificiran, by-design):** `verifyTurnstile` je no-op (vrati
`{ok:true}`) kad `TURNSTILE_SECRET` nije postavljen — fail-open. Ako se u nekom
okruženju ime tajne pogriješi ili se zaboravi provisionirati, human-attestation
je tiho isključen bez ijednog signala; relayer gas je izložen samo mekim KV
capovima (WR-03).

**Fix:** Environment-gated assert: u produkciji, ako `TURNSTILE_ENFORCE=true` a
secret nedostaje → fail-closed ILI barem startup/health log "Turnstile OFF".
Observability signal (log/metric) na svaki no-op verify.

**Acceptance:** Prod deploy bez secreta uz `TURNSTILE_ENFORCE=true` → health
check crveno / vidljiv alarm.

---

## WR-07 [RISK] Jedan hardkodirani RPC bez fallbacka (relayer)

**file:** `wallet/functions/_lib/relayer.ts:45`

Isti cross-cutting problem kao XD-02. `getCode` (pre-flight deploy check —
kritičan za stranding zaštitu) i broadcast vise o jednom besplatnom endpointu.
Vidi **cross-cutting.md → XD-02**.

---

## WR-08 [TEST-GAP] Nula testova na cijeloj gas-spending površini

**file:** `wallet/functions/_lib/safe.ts:220` (i cijeli `functions/`)

Nijedan test ne pokriva: CREATE2 predikciju (`predictSafeProxyAddress`),
`buildSafeInitializer`, `packMultiSend`, hot/cold path odluku u `relay.ts`,
CREATE2 guard, limits atomicnost. Vidi **refactor-plan.md → F3 test paket** i
XD-01 (parity test).
