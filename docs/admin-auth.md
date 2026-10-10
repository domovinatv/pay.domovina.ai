# Admin prijava — Cloudflare Access (OTP) + passkey

`https://mpt.domovina.ai/admin`. Zamjenjuje Basic Auth (2026-10-08). Model i kod
preneseni su iz `bank-push-gateway` (`worker/src/admin/{access,session,passkey}.ts`,
`docs/admin.md` tamo) i treba ih držati u skladu.

## Dva puta ulaska, jedna sesija

```mermaid
flowchart LR
  L[/admin/login/] -->|Prijava passkeyem| P[/admin/passkey/login/verify/]
  L -->|Prijava preko Accessa| S[/admin/sso/]
  S -->|Cloudflare Access: OTP na e-mail<br/>samo e-mailovi iz politike| S
  P --> Sess[(admin_sessions)]
  S -->|JWT potpis + issuer + AUD ok<br/>i e-mail u ADMIN_EMAILS| Sess
  Sess --> A[/admin/*]
```

- **Cloudflare Access** štiti samo `/admin/sso`. IdP je One-time PIN na e-mail.
  Nema vanjskih identity providera (Google, GitHub…) ni lozinki.
- **Passkey** se upisuje nakon prvog ulaska preko Accessa (Passkeyi → Dodaj
  passkey). Discoverable ključ, `userVerification: required`.
- Access je ujedno **oporavak** ako se izgube svi passkeyi. Nema break-glass
  tokena ni lozinke.

## Sigurnost

| Mjera | Gdje |
|---|---|
| Sesija: 32 nasumična bajta u kolačiću `__Host-mpt_admin` (HttpOnly, Secure, SameSite=Lax, 12 h); u D1 samo sha-256 | `src/admin/auth/session.ts` |
| Pri svakom zahtjevu provjera da je e-mail još u `ADMIN_EMAILS` | `getSession` |
| CSRF: svaki POST/PUT/PATCH/DELETE mora imati `Origin` jednak originu admina | `src/admin/auth/mount.ts` |
| WebAuthn izazov jednokratan, 5 min, vezan uz svrhu i e-mail | `consumeChallenge` |
| `rpID` = hostname; admin radi samo na `ADMIN_HOST`, drugi host preusmjerava (GET) ili odbija (421) | `mount.ts` |
| CSP: `script-src 'self' 'nonce-…'`, svaki inline `<script>` starih ekrana dobiva nonce po odgovoru; inline handleri (`onclick=`) su blokirani i uklonjeni iz ekrana | `mount.ts`, `views.ts` |
| `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store`, `Referrer-Policy: same-origin` | `mount.ts` |
| Otvoreno preusmjeravanje: `next` samo `/admin…` | `safeNext` |
| Access JWT: RS256, issuer `https://<team>.cloudflareaccess.com`, AUD | `src/admin/auth/access.ts` |
| `/admin/api/*` bez sesije → 401 (ne redirect); Basic Auth zaglavlje više ništa ne otvara | `mount.ts` |
| Audit actor (`tenant_audit_log.actor`, offrail) = e-mail sesije, nikad zaglavlje zahtjeva | `actorOf` u `mount.ts` |
| Dodavanje passkeya: prijava mlađa od 10 min, najviše 5 po e-mailu, Telegram alarm 🔑 | `passkeyRegisterRefusal` u `mount.ts` |
| Monerium admin i HPB connect pod sesijom: `/admin/api/monerium/*`, `/admin/api/hpb/*` (audit `monerium.*`/`hpb.*`); Monerium pretplata samo na naše webhook URL-ove | `src/admin/opsRoutes.ts` |

## Konfiguracija

`backend/wrangler.toml` → `[vars]` (nisu tajne):

| Varijabla | Vrijednost |
|---|---|
| `ADMIN_EMAILS` | e-mailovi koji smiju u admin |
| `ADMIN_HOST` | `mpt.domovina.ai` |
| `ACCESS_TEAM_DOMAIN` | `domovina.cloudflareaccess.com` (isti tim kao bank-push-gateway) |
| `ACCESS_AUD` | AUD Access aplikacije „MPT admin (sso)" |

Access aplikacija (Zero Trust → Access → Applications, self-hosted):
„MPT admin (sso)", destinacija `mpt.domovina.ai/admin/sso`, politika „MPT
admini" (include: isti e-mailovi), IdP One-time PIN, sesija 24 h.

**Oduzimanje pristupa:** makni e-mail iz `ADMIN_EMAILS` (djeluje odmah, i na
postojeće sesije) i iz Access politike.

`MONERIUM_ADMIN_USER` / `MONERIUM_ADMIN_PASS` više se ne čitaju. Nakon deploya
ih obriši: `wrangler secret delete MONERIUM_ADMIN_USER` (i `_PASS`).

## Ops pozivi admin API-ja

`curl -u` više ne radi. Admin API zove se iz preglednika s prijavljenom
sesijom, npr. u konzoli na `https://mpt.domovina.ai/admin`:

```js
await fetch('/admin/api/alert-test', { method: 'POST' }).then((r) => r.json())
```

## Lokalno

```bash
npx wrangler d1 migrations apply pay_domovina --local
npx wrangler dev --port 8798 --local-upstream localhost
```

`--local-upstream localhost` (bez porta) je nužan iz dva razloga. Bez njega
wrangler predstavlja zahtjev kao produkcijsku rutu, pa ga admin preusmjeri na
`ADMIN_HOST`. S portom wrangler prepiše `Origin` u `http://localhost`, a URL
zadrži port, pa CSRF provjera odbije svaki POST.

Access lokalno ne radi. Za lokalnu sesiju upiši je ručno u lokalni D1
(`admin_sessions`, `token_hash` = sha-256 tokena) i postavi kolačić
`__Host-mpt_admin=<token>`. Passkey radi na `http://localhost`.

## Stari bearer URL-ovi (AD-02) — ukloniti nakon jednog ciklusa

`/api/monerium/admin/*` i `/api/hpb/admin/*` s `ADMIN_TOKEN` još rade (isti
kod, audit s actorom `admin-token`, webhook URL zaključan na naše hostove).
Nakon što curl skripte prijeđu na `/admin/api/…` (kolačić sesije iz
preglednika): obrisati mount u `src/index.ts` i rotirati `ADMIN_TOKEN`.
