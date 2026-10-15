# Postmortem 0002 — Admin auth bypass via percent-encoded path (`/%61dmin/`)

**Date of incident:** 2026-10-14, 22:25–23:29 UTC (00:25–01:29 CEST, 15.10.).
**Detected:** 2026-10-15 morning, as ~25 odd jobs in the pipeline.domovina.ai admin.
**Fixed:** 2026-10-15 ~10:50 CEST — `main` `0e7ceeb` (pay), `96fef04` (pipeline), deployed to both.
**Severity:** Full unauthenticated admin access to `mpt.domovina.ai` and `pipeline.domovina.ai`.
No funds moved.
**Author:** Matija Stepanic + Claude.

> **This branch (`chore/opensaas-sandbox-tenant`) does NOT contain the fix.**
> `backend/src/admin/auth/mount.ts` here is still vulnerable. Merge/rebase onto `main`
> (≥ `0e7ceeb`) **before any `wrangler deploy` from this checkout** — deploying this
> branch as-is re-opens the hole on production `mpt.domovina.ai`.

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

## Lessons

1. **One parser for authorization and routing.** Never authorize on `new URL(req.url).pathname`
   when the router uses its own (decoding) path. In Hono: `c.req.path`.
2. **Deny by default.** "Auth only if path looks like admin" fails open; "auth everything
   except an exact allowlist" (bank-push-gateway) fails closed.
3. **Copied security code copies its bugs.** The same `mount.ts` lives in pay, pipeline and
   this branch; a fix must be applied to every copy (`grep -rn "isAdminPath(new URL"`).
4. Public repo + a public mention = someone reads the auth code within a day.

## Open

- [ ] Merge `main` into `chore/opensaas-sandbox-tenant` (brings `0e7ceeb`).
- [ ] Decide whether the read data (orders, wallets, HPB authorizations) requires notifying
      ITalk / affected users.
- [ ] Optional: alert on `admin:unknown` in `tenant_audit_log` and on `admin_encoded_path_rejected`.
