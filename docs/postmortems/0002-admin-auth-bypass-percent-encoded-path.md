# Postmortem 0002 — Admin auth bypass via percent-encoded path (`/%61dmin/`)

**Date of incident:** 2026-10-14, 22:25–23:29 UTC (00:25–01:29 CEST, 15.10.).
**Detected:** 2026-10-15 morning, as ~25 odd jobs in the pipeline.domovina.ai admin.
**Fixed:** 2026-10-15 ~10:50 CEST — `main` `0e7ceeb` (pay), `96fef04` (pipeline), deployed to both.
**Severity:** Full unauthenticated admin access to `mpt.domovina.ai` and `pipeline.domovina.ai`.
No funds moved.
**Author:** Matija Stepanic + Claude.

> **Any branch cut from `main` before `0e7ceeb` is still vulnerable.** Merge/rebase onto
> `main` before any `wrangler deploy` from it — deploying an old branch re-opens the hole
> on production `mpt.domovina.ai`. (`chore/opensaas-sandbox-tenant` got `main` merged on
> 2026-10-15.)

## What happened

An external client (IP `77.91.100.31`, UOWH LLC, Amsterdam, `curl/8.5.0`) found that any
admin route was reachable without a session by percent-encoding one letter of `admin`:

```
GET /admin/api/tenant-tags     -> 401
GET /%61dmin/api/tenant-tags   -> 200   (before the fix)
```

Timeline (UTC, from Workers Observability):

| Time | |
|---|---|
| 22:25 | First request: `GET pipeline.domovina.ai/` (route list). Probing `/api/*`, `/admin`, `/.env`. |
| 22:33 | First request to `mpt.domovina.ai/`. Probing public API, sandbox self-serve (`/api/sandbox/tenants`, intents, simulate — all by design). |
| 23:08 | Bypass works on pipeline (`/%61dmin/...`). |
| 23:13 | Bypass works on pay. Reads and writes below. |
| 23:29 | Last request. |

No `Referer` (curl). The attacker used exact internal route names
(`/admin/api/tenants/:id/rail/router-key`, `/rewrap`, `/verify`), i.e. read the public
source on GitHub. Pipeline's `docs/admin-auth.md` says the auth code comes from
`pay.domovina.ai` and names `mpt.domovina.ai` — the likely path from one to the other.
Self-labelled as a PoC (`artex-poc-4207`, `artex-noorigin`, addresses `0x2222…`, `0x3333…`).
The day before, the project had been mentioned in a Telegram group.

## Root cause

`mountAdminAuth` registers middleware on the **whole** app and decides "is this an admin
request?" from the **raw** URL:

```ts
const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');
if (!isAdminPath(new URL(c.req.url).pathname)) return next();   // skip auth
```

`new URL(...).pathname` keeps `%61dmin` encoded → not an admin path → session, CSRF and
host checks are all skipped. Hono's router matches on `getPath()`, which **decodes**
percent-encoding → `/admin/...` → the admin handler runs. Two parsers, two answers.

The CSRF (`Origin`) check had the same guard, so POSTs went through without `Origin`.

## Fix (`0e7ceeb`)

- All checks in `mount.ts` use `c.req.path` — the same path the router matches.
- New first middleware: if the decoded path is an admin path but differs from the raw
  pathname → `400 bad_path` + log `admin_encoded_path_rejected`.

Verified on prod: `/%61dmin/…`, `/adm%69n/…`, `/%61%64%6d%69%6e/…` → 400; `/admin/…` without
session → 401/302 as before.

`bank-push-gateway` (origin of this auth model) is **not** exploitable: its top-level
dispatch only hands raw `/admin…` to the admin app, and auth inside is deny-by-default
over exact `PUBLIC_PATHS`. Noted in its `docs/admin.md`.

## Impact on pay (production)

**Written by the attacker, tenant `italk` (the live one):**

| `tenant_audit_log` id | Action | Cleanup (2026-10-15) |
|---|---|---|
| 310 | `address.add` `0x2222222222222222222222222222222222222222` | revoked |
| 311 | `key.issue` public key | revoked |
| 312 | `key.issue` secret key, label `artex-poc-4207` | revoked |
| 313 | `address.add` `0x3333…3333`, label `artex-noorigin` | revoked |
| 314 | `rail.rewrap` on `crosulja-staging` (re-encrypt under current KEK, values unchanged) | none needed |
| 315 | `rail.verify` on `crosulja-staging` (read-only) | none needed |

Router-key generation was attempted on `italk` (400 `default_tenant_uses_env`) and
`crosulja-staging` (409 `router_exists`) — refused, no key rotated.

Every attacker row has `actor = 'admin:unknown'` — `actorOf()` falls back to that when there is
no session. **Any `admin:unknown` in `tenant_audit_log` is a signal to investigate.**

**Read by the attacker:** tenants + italk keys list (hashes), addresses, rail, campaigns,
`/admin/api/orders`, `wallets`, `forwards`, `events`, `intents`, `sybil`, `outbox`,
`tenant-tags`, `hpb/authorizations`, `tenants/audit` (`monerium/profiles` failed with 500).
Treat the contents of those endpoints as disclosed.

Also created by the same IP via the public self-serve sandbox (by design, left as-is):
`sbx-2d0ee09273`, `sbx-c52b4844cf`, `sbx-245fb0f0b8`.

## How close this came to money

The admin API redacts every rail secret (`redactRail` returns only `has_router_key`,
`has_client_secret`, …), key lists carry sha256 hashes, and HPB authorizations carry no
tokens, so no secret left through the reads. But the two writes the attacker *did* make
were the two halves of a payout redirect:

1. `0x2222…` added to `italk`'s payout whitelist (310);
2. a **secret** API key issued for `italk` (312).

One more call — an intent on `italk` with target `0x2222…` — and the next payment to that
sid (or, through the stray resolver, a reference-less payment of the same amount) would
have passed binding and whitelist, and the router would have forwarded it there. He did
not make that call: no intent was created with the key (`created_with_key = 0` for every
`italk` intent in the window), and `monerium_forwards` has no row for either address.

The root problem is not the auth bug but that the Worker held a key able to move EURe:
`ROUTER_PRIVATE_KEY`, member of an `EUReForwarder` role with no on-chain conditions.
Whitelist and resolver decide inside the Worker, so they protect against a wrong payer,
not against whoever controls the Worker. **[ADR 0025](../decisions/0025-mpt-router-umirovljen-svi-tenanti-direct.md)
retires the router**: every tenant in direct mode, role and Roles module removed from the
MPT Safe by a 2/3 transaction (`safe-tx/008`), router key deleted. After that a full
Cloudflare compromise can lie in notifications and read payment data, but cannot move EURe.

## Follow-up: the guard was too broad (#106, 2026-10-15)

`0e7ceeb` refused **any** admin path whose raw form differed from the decoded one. That
also refused legitimate encoding in later segments — revoking an API key by its shortened
id (`…/keys/abcd…` → `%E2%80%A6`) returned 400, and `main` CI stayed red
(`adminKeyRevoke.test.ts`) from the fix until #106. Branch protection then blocked every
other PR.

#106 refuses only when the decoded path is admin but the raw one is not — i.e. the `/admin`
prefix itself is encoded. Every check after it already uses the decoded `c.req.path`, so
encoded later segments cannot change the auth decision. A regression test now covers
`/%61dmin/`, `/%2561dmin/` and `/a%64min/` and was confirmed to fail with the guard removed
(the original fix shipped without one). Deployed 2026-10-15 as `781734bb`; production
check: `/%61dmin/api/forwards` → 400, `/admin/api/forwards` → 401.

## Lessons

1. **One parser for authorization and routing.** Never authorize on `new URL(req.url).pathname`
   when the router uses its own (decoding) path. In Hono: `c.req.path`.
2. **Deny by default.** "Auth only if path looks like admin" fails open; "auth everything
   except an exact allowlist" (bank-push-gateway) fails closed.
3. **Copied security code copies its bugs.** The same `mount.ts` lives in pay, pipeline and
   this branch; a fix must be applied to every copy (`grep -rn "isAdminPath(new URL"`).
4. Public repo + a public mention = someone reads the auth code within a day.

## Open

- [x] Merge `main` into `chore/opensaas-sandbox-tenant` (brings `0e7ceeb`).
- [x] bank-push-gateway hardened the same way (defence in depth, it was not exploitable).
- [ ] Decide whether the read data (orders, wallets, HPB authorizations) requires notifying
      ITalk / affected users.
- [ ] pipeline.domovina.ai has its own copy of `mount.ts` (`96fef04`): check whether it has
      the same over-broad guard and port #106 if so.
- [ ] Optional: alert on `admin:unknown` in `tenant_audit_log` and on `admin_encoded_path_rejected`.
- [x] ADR 0025: `italk` on direct (#108), `safe-tx/008` executed 2/3 (tx `0x4c32…64b0`,
      MPT Safe has no module left), `ROUTER_PRIVATE_KEY` and tenant router keys deleted (2026-10-15).
