# Monerium inbox u prodi — mjerenje (S1, 2026-11-20)

Pitanje: zapisuju li se Monerium uplate nakon deploya #155 (18. 11.) u `credit_events` i veže li se
booked događaj na `intent_settlements` (preduvjet za S4, odluka 3).

Sve naredbe iz `backend/`, samo čitanje:
`npx wrangler d1 execute pay_domovina --remote --json --command "<SQL>"`.

## 1. Monerium događaji u inboxu

```sql
SELECT id, provider_ref, finality, matched_sid, match_note, created_at
  FROM credit_events WHERE provider='monerium' ORDER BY id DESC LIMIT 10
```

| id | provider_ref | finality | matched_sid | created_at (UTC) |
| --- | --- | --- | --- | --- |
| 6 | `89dcc6e8-…:booked` | booked | `sq6x4g29kx8e` | 2026-11-19 10:18:23 |
| 5 | `89dcc6e8-…:notified` | notified | `sq6x4g29kx8e` | 2026-11-19 10:18:18 |

Ukupno u `credit_events`: 6 redova (4 Swan booked, ovaj Monerium par). `match_note` NULL na oba.

## 2. Je li booked događaj vezan

```sql
SELECT s.*, i.paid_at, i.monerium_order_id, i.tenant_id
  FROM intent_settlements s JOIN payment_intents i ON i.sid = s.sid WHERE s.sid = 'sq6x4g29kx8e'
```

`provider=monerium`, `settlement_ref = monerium_order_id = 89dcc6e8-e402-11f1-bfcd-b67188e7eb1c`,
`credit_event_id = 6` (booked), tenant `crosulja-staging`, `paid_at = created_at = 1795083503`.
**Vezan.** Notified (5) prethodi booked za 5 s, a namira je u istoj sekundi kao booked.

```sql
SELECT provider, COUNT(*) n, SUM(credit_event_id IS NULL) no_ce FROM intent_settlements GROUP BY provider
```

| provider | n | bez credit_event_id |
| --- | --- | --- |
| monerium | 157 | 156 |
| sandbox | 57 | 57 |
| swan | 4 | 0 |

156 Monerium redova bez događaja = backfill iz 0036 (namire prije inboxa), očekivano. Sandbox uplate ne
idu kroz inbox (`sim_` order, bez webhooka), pa nikad nemaju događaj.

## 3. Usklađenost `monerium_order_id` ⇔ `intent_settlements`

```sql
SELECT COUNT(*) FROM payment_intents i
 WHERE (i.monerium_order_id IS NOT NULL) <> EXISTS(SELECT 1 FROM intent_settlements s WHERE s.sid = i.sid)
```

**0** (prije deploya S1). Ponoviti nakon deploya (vidi `handoffs/README.md`, red S1).

## Napomene

- Upit 2 iz `S1.md` (`i.paid_at > '2026-11-18T14:30'`) uvijek vraća prazno: `paid_at` je epoch
  (INTEGER), a u SQLiteu je svaki INTEGER manji od TEXT-a. Ispravno: `i.paid_at > 1795012200`
  (2026-11-18 14:30 UTC).
- Uzorak je **jedna** Monerium uplata (crosulja-staging). Dovoljno da je put dokazan, premalo za
  statistiku. Sandbox Monerium uplata nije rađena jer prava postoji (uvjet iz `S1.md`). Prije S4
  ponoviti upit 1 i 2. Svaka nova Monerium uplata mora imati par notified/booked i vezan
  `credit_event_id`.
