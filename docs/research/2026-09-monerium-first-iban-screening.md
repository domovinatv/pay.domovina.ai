# Monerium: prva uplata s novog IBAN-a čeka ručni pregled

Analiza 2026-09-28, povod: intent `faeysbwt2e7q` (8h 11m od SEPA Instant uplate do minta).

## Zaključak

Monerium svaki issue order ocjenjuje i rezultat piše u `raw_json.meta.evaluation`:

| Uplatitelj | `evaluation` | n | placedAt → processedAt |
|---|---|---|---|
| IBAN koji je već plaćao | `success: true`, `reason: "total transfer within volume limits"` | 44 | medijan 9 s, p95 26 s, max 39 s |
| Prva uplata s novog IBAN-a | `success: false`, `reason: "counterpart is not screened"` | 5 | 1m 23s – 8h 11m |

Korelacija je 5/5 i 44/44. Iznimka: prva uplata s vlastitog IBAN-a vlasnika profila prošla je odmah (ime = vlasnik profila).

Kašnjenje nije na SEPA strani: `order.created` (state=pending) stiže u istoj sekundi kad i uplata.
Između `order.created` i `order.updated (processed)` nema nijednog webhooka, pa ni signala da je order u pregledu.

## Zadržani orderi (UTC)

| Order | Dan | placed | processed | trajanje |
|---|---|---|---|---|
| 950c2736-569a-11f1-9fa8-56752f5b038e | sub 2026-05-23 | 11:28:55 | 12:50:53 | 1h 21m |
| 2aa85583-65d1-11f1-b96b-de5d144a3fe8 | čet 2026-06-11 | 20:07:26 | 20:10:17 | 2m 51s |
| 7c6067c9-699a-11f1-8889-f23667dd4437 | uto 2026-06-16 | 15:46:06 | 15:47:29 | 1m 23s |
| 3a041082-8697-11f1-b5cb-b250ab918d8c | čet 2026-07-23 | 13:05:49 | 13:25:18 | 19m 28s |
| 4a0ec30d-b996-11f1-ba11-6a913df2d74b | sub 2026-09-26 | 10:37:36 | 18:49:25 | 8h 11m |

Intent `2abjke6unj5u` (order 1) je istekao prije minta jer je tada TTL bio 15 min; novac je ipak proslijeđen.
Današnji intenti imaju TTL 24 h.

## Kako ponoviti

`wrangler d1 execute pay_domovina --remote` treba `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"`
jer inače OAuth refresh pukne s ETIMEDOUT (IPv6). Upit: `SELECT raw_json FROM monerium_orders`, pa `meta.evaluation`, `meta.placedAt`, `meta.processedAt`.

## Status

Upit poslan Monerium supportu (cc partners@) 2026-09-28: što točno provjerava screening, SLA i vikendi,
opseg screeninga (IBAN/ime/globalno), volume limiti, pre-screening API, webhook za stanje „u pregledu",
te real-time odluka za male iznose po uzoru na kartične mreže.

Na našoj strani je moguće: checkout može za novog uplatitelja najaviti „prva uplata može potrajati"
jer order s `evaluation.success=false` to jasno označava.

## Odluka o smjeru (2026-09-28)

- **Merchant-direct model:** svaki merchant prolazi vlastiti Monerium KYC/KYB i prima novac izravno.
  Mi smo samo tehnološki partner koji preko webhookova javlja stanje uplate, kao Stripe.
  Time otpada MPT hold-and-forward i rizik iz Monerium BToS §16.
- **UX kao kartica:** uspjeh se prikazuje na `order.created` (Monerium zaprimio SEPA, ~1 s),
  a mint je namira koja stiže kasnije. Kartična analogija je autorizacija pa namira.
  Pravilo „forward tek na `processed`” ostaje nepromijenjeno. Mijenja se samo prikaz i obavijesti.
- **Otvoreno pitanje za Monerium:** pamti li se screening po profilu primatelja ili globalno.
  Ako se pamti po profilu, svaki novi merchant kreće od nule.

## Otvorene stavke

- Mail Moneriumu je **poslan 2026-09-28** kao odgovor u threadu „Your Partnership Inquiry is in Review” (partners@, cc support@, 9 pitanja; Matija ga je ručno doradio prije slanja). Odgovor se čeka.
- `domovina.ai` pinka panel: prompt za instant uspjeh je u
  `docs/prompts/2026-09-28-pinka-instant-received-ux.md`. Sadrži i dva buga:
  `waitForPaid` odustaje nakon 5 min i zamrzne panel, a `rejected_reason` se čita s krivog mjesta.
- ~~Checkout čeka `settled`~~ i ~~webhook dorade~~: **deployano 2026-09-28** (`0dc28bf`, `c3ff2a1`).
  Status po nalazima je u [2026-09-webhook-events-review.md](../reviews/2026-09-webhook-events-review.md#status-implementacije-2026-09-28-deployano).
- 3,04 EUR iz testiranja 2026-05-21 nikad nisu proslijeđena (1 failed forward + 2 ordera bez forwarda).
  Nije provjereno nalaze li se još u MPT Safeu.

## Vezani dokumenti

- [Pregled webhookova i eventa](../reviews/2026-09-webhook-events-review.md)
- [Fable5 review, backend](../reviews/2026-07-fable5/backend-worker.md) (BW-01..04, BW-14)

## Pitanja poslana Moneriumu (sažetak)

Najvažnije je prvo: znači li `order.created` sa `state=pending` da su sredstva zaprimljena i što još može
dovesti do odbijanja. O tome ovisi smije li checkout prikazivati uspjeh na `received`.
Ostala pitanja: što provjera točno radi, vrijedi li po profilu ili globalno, SLA i vikendi, volume limiti,
`evaluation` već na `order.created`, pre-screening API, odluka u realnom vremenu za male iznose,
te webhookovi za partnerove merchante.

Kad odgovor stigne, na temelju njega odlučiti:
- ako `order.created` NIJE pouzdan signal, vratiti uspjeh na `minted`/`settled` (`isReceived` u page.ts i payment_status.dart);
- ako screening vrijedi po profilu, merchant-direct model treba pre-screening prije plaćanja;
- ako Monerium ponudi flag na `order.created`, zamijeniti vlastito predviđanje `review_expected` njihovim signalom.
