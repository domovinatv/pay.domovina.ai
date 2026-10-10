# Rotacija `TENANT_SECRETS_KEK` (MT-06)

Tajne tenanata (`tenant_rail.*_enc`: Monerium client secret, refresh token,
router ključ, webhook i outbound secret) su AES-256-GCM pod KEK-om iz Worker
secreta. Rotacija ne traži ponovni onboarding ni nove tajne kod tenanta.

1. Novi ključ: `openssl rand -base64 32`.
2. Stari ključ prebaci u `TENANT_SECRETS_KEK_PREV`, novi u `TENANT_SECRETS_KEK`:
   ```bash
   cd backend
   npx wrangler secret put TENANT_SECRETS_KEK_PREV   # STARI ključ
   npx wrangler secret put TENANT_SECRETS_KEK        # NOVI ključ
   ```
   Od tog trenutka čitanje probava novi pa stari ključ (GCM autentikacija
   kaže koji je pravi); svaki novi upis ide pod novi ključ. Railovi rade cijelo
   vrijeme.
3. Za svakog tenanta s railom (u `/admin` konzoli preglednika, sesija):
   ```js
   for (const id of ['zupa-a', 'crosulja-staging']) {
     console.log(id, await (await fetch(`/admin/api/tenants/${id}/rail/rewrap`, { method: 'POST' })).json());
   }
   ```
   Svaki poziv ponovno šifrira sve `*_enc` stupce tenanta novim ključem i
   upisuje audit `rail.rewrap`.
4. Provjera: `/admin/tenants` → Verify za svakog tenanta prolazi.
5. `npx wrangler secret delete TENANT_SECRETS_KEK_PREV`. Nakon toga stari
   ključ više ništa ne otvara.

Ako je stari ključ procurio, rotacija KEK-a ne mijenja same tajne — uz nju
rotirati i ono što je bilo pod njim (router ključ: novi EOA + batch 007;
Monerium client secret kod tenanta; webhook secret: ponovna registracija, koja
sada gasi staru pretplatu).
