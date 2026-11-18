// Admin v2 — uređivanje tenanta: primatelji (projekti + whitelist), rail i
// status, ključevi i računi, novi tenant. Stranice samo prikazuju; svaka
// akcija zove postojeću /admin/api/tenants/* rutu (iste provjere, isti audit).
// Forme: <form data-api="/admin/api/…" data-method="PUT"> (JS u ui.tsx).

import type { FC } from 'hono/jsx';

import type { TenantDetailData } from './pages';
import { Empty, fmtDate, fmtEur, Mono, Pill, short } from './ui';

export type TenantTab = 'overview' | 'recipients' | 'rail' | 'keys';

const enc = encodeURIComponent;

export const TenantNav: FC<{ id: string; tab: TenantTab; sandbox: boolean }> = ({ id, tab, sandbox }) => {
  const base = `/admin/v2/tenants/${enc(id)}`;
  const tabs: Array<[TenantTab, string, string]> = [
    ['overview', 'Pregled', base],
    ['recipients', 'Primatelji', `${base}/recipients`],
    ...(sandbox ? [] : [['rail', 'Rail i status', `${base}/rail`] as [TenantTab, string, string]]),
    ['keys', 'Ključevi i računi', `${base}/keys`],
  ];
  return (
    <nav class="subnav" aria-label="Tenant">
      {tabs.map(([k, l, href]) => <a class={tab === k ? 'on' : ''} href={href}>{l}</a>)}
    </nav>
  );
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'muted'> = { active: 'ok', onboarding: 'warn', suspended: 'muted' };
const STATUS_LABEL: Record<string, string> = { active: 'Aktivan', onboarding: 'Onboarding', suspended: 'Suspendiran' };

export const TenantHead: FC<{ id: string; d: TenantDetailData; tab: TenantTab }> = ({ id, d, tab }) => {
  const name = d.tenant?.name ?? id;
  const st = d.tenant?.status ?? '';
  return (
    <>
      <a href="/admin/v2/tenants" class="small">← Tenanti</a>
      <div class="row" style="align-items:center">
        <div style="display:flex;gap:14px;align-items:center">
          <span class="ava">{name.slice(0, 1).toUpperCase()}</span>
          <div class="two">
            <h1 style="font-size:24px">{name}</h1>
            <span class="dim small"><Mono>{id}</Mono> · {d.tenant ? <Pill tone={STATUS_TONE[st] ?? 'muted'}>{STATUS_LABEL[st] ?? st}</Pill> : 'bez tenant reda'}</span>
          </div>
        </div>
      </div>
      <TenantNav id={id} tab={tab} sandbox={Boolean(d.tenant?.sandbox)} />
    </>
  );
};

// ---------------------------------------------------------------------------
// Primatelji: projekti (direct) i payout whitelist (forward)
// ---------------------------------------------------------------------------

export type AddressRow = { address: string; label: string | null; source: string; created_at: number; created_by: string | null; revoked_at: number | null; revoked_by: string | null };

export const RecipientsPage: FC<{ id: string; d: TenantDetailData; addresses: AddressRow[]; showRevoked: boolean }> = ({ id, d, addresses, showRevoked }) => {
  const base = `/admin/api/tenants/${enc(id)}`;
  const direct = d.rail?.mode === 'direct';
  const campaigns = showRevoked ? d.campaigns : d.campaigns.filter((c) => !c.revoked_at);
  const addrs = showRevoked ? addresses : addresses.filter((a) => !a.revoked_at);
  const walletRegistry = (d.allowSources ?? '').includes('wallet_registry');
  return (
    <>
      <TenantHead id={id} d={d} tab="recipients" />
      <div class="callout info" role="note">
        <span>{d.tenant?.sandbox
          ? <><strong>Sandbox tenant (ADR 0024):</strong> nema raila ni novca; whitelist i projekti ovdje služe samo za probu integracije.</>
          : direct
          ? <><strong>Direct tenant:</strong> intent smije ići samo na aktivni projektni Safe. Whitelist se za intente ne gleda.</>
          : <><strong>Forward tenant:</strong> forward ide samo na adresu s whiteliste{walletRegistry ? ' ili na DOMOVINA wallet (wallet_registry)' : ''}. Provjera se ponavlja u trenutku forwarda.</>}
        </span>
      </div>
      <div class="chips">
        <a class={showRevoked ? 'chip' : 'chip on'} href="?">Aktivni</a>
        <a class={showRevoked ? 'chip on' : 'chip'} href="?all=1">Uključi opozvane</a>
      </div>

      <section class="card">
        <div class="card-h"><h2>Projekti ({d.campaigns.filter((c) => !c.revoked_at).length})</h2>
          {d.rail && !d.tenant?.sandbox ? <a class="small" href={`/admin/tenants/${enc(id)}/setup`}>Novi projekt sa Safeom i Monerium vezom (setup) →</a> : null}
        </div>
        {campaigns.length ? <div class="tbl"><table>
          <thead><tr><th>Projekt</th><th>Safe</th><th>Dodan</th><th>Status</th><th class="r"></th></tr></thead>
          <tbody>{campaigns.map((c) => (
            <tr>
              <td><span class="two"><strong>{c.label ?? c.campaign_id}</strong><Mono>{c.campaign_id}</Mono></span></td>
              <td><Mono title={c.safe_address}>{short(c.safe_address, 8, 6)}</Mono></td>
              <td class="dim">{fmtDate(c.created_at)}</td>
              <td>{c.revoked_at ? <Pill tone="muted">opozvan {fmtDate(c.revoked_at)}</Pill> : <Pill tone="ok">aktivan</Pill>}</td>
              <td class="r">{c.revoked_at ? null : <button class="btn danger" data-post={`${base}/campaigns/${enc(c.campaign_id)}`} data-method="DELETE"
                data-confirm="Potvrdi opoziv" data-done="Projekt opozvan.">Opozovi</button>}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>Nema projekata.</Empty>}
        <form class="card-b form" data-api={`${base}/campaigns`} data-done="Projekt dodan." style="border-top:1px solid var(--line)">
          <h2>Dodaj postojeći Safe kao projekt</h2>
          <div class="cols" style="gap:12px">
            <label style="flex:1 1 160px">ID projekta<input name="campaign_id" required pattern="^[A-Za-z0-9_-]{6,64}$" placeholder="npr. maksimir-2026" /></label>
            <label style="flex:2 1 280px">Safe adresa<input name="safe_address" class="mono" required pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" /></label>
            <label style="flex:1 1 160px">Naziv<input name="label" placeholder="neobavezno" /></label>
          </div>
          <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit" data-confirm="Potvrdi dodavanje">Dodaj projekt</button></div>
        </form>
      </section>

      <section class="card">
        <div class="card-h"><h2>Payout whitelist ({addresses.filter((a) => !a.revoked_at).length})</h2></div>
        {addrs.length ? <div class="tbl"><table>
          <thead><tr><th>Adresa</th><th>Naziv</th><th>Dodao</th><th>Status</th><th class="r"></th></tr></thead>
          <tbody>{addrs.map((a) => (
            <tr>
              <td><Mono title={a.address}>{short(a.address, 10, 8)}</Mono></td>
              <td>{a.label ?? <span class="dim">—</span>}</td>
              <td class="dim small">{a.created_by ?? a.source} · {fmtDate(a.created_at)}</td>
              <td>{a.revoked_at ? <Pill tone="muted">opozvana</Pill> : <Pill tone="ok">aktivna</Pill>}</td>
              <td class="r">{a.revoked_at ? null : <button class="btn danger" data-post={`${base}/addresses/${enc(a.address)}`} data-method="DELETE"
                data-confirm="Potvrdi opoziv" data-done="Adresa opozvana.">Opozovi</button>}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>Whitelist je prazna.</Empty>}
        <form class="card-b form" data-api={`${base}/addresses`} data-done="Adresa dodana." style="border-top:1px solid var(--line)">
          <h2>Dodaj adresu</h2>
          <div class="cols" style="gap:12px">
            <label style="flex:2 1 280px">Adresa<input name="address" class="mono" required pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" /></label>
            <label style="flex:1 1 160px">Naziv<input name="label" placeholder="neobavezno" /></label>
          </div>
          <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit" data-confirm="Potvrdi dodavanje">Dodaj na whitelist</button></div>
        </form>
      </section>

      <section class="card">
        <form class="card-b form" data-check={`${base}/check/`}>
          <h2>Bi li ova adresa sad prošla?</h2>
          <div class="cols" style="gap:12px;align-items:flex-end">
            <label style="flex:2 1 280px">Adresa<input name="address" class="mono" required pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" /></label>
            <button class="btn" type="submit">Provjeri</button>
          </div>
          <div data-out class="small" aria-live="polite" />
        </form>
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Rail i status
// ---------------------------------------------------------------------------

export const RailPage: FC<{ id: string; d: TenantDetailData }> = ({ id, d }) => {
  const base = `/admin/api/tenants/${enc(id)}`;
  const r = d.rail;
  const st = d.tenant?.status ?? '';
  const locked = st === 'active';
  const verified = Boolean(r?.verified_at);
  return (
    <>
      <TenantHead id={id} d={d} tab="rail" />
      <section class="card">
        <div class="card-h"><h2>Status</h2><span class="dim small">{verified ? `verify ${fmtDate(r!.verified_at)}` : 'rail nije verificiran'}</span></div>
        <div class="card-b" style="display:flex;flex-direction:column;gap:12px">
          <span class="dim small">Rail se mijenja samo dok tenant nije aktivan: suspendiraj → promijeni → pokreni provjeru → nastavi. Aktivacija i nastavak traže uspješnu provjeru.</span>
          <div class="acts" style="justify-content:flex-start">
            {st === 'onboarding' ? <button class="btn primary" data-post={`${base}/activate`} data-confirm="Potvrdi aktivaciju" data-done="Tenant aktiviran." disabled={!verified}>Aktiviraj</button> : null}
            {st === 'active' ? <button class="btn danger" data-post={`${base}/suspend`} data-confirm="Potvrdi suspenziju (intenti se odbijaju)" data-done="Tenant suspendiran.">Suspendiraj</button> : null}
            {st === 'suspended' ? <button class="btn primary" data-post={`${base}/resume`} data-confirm="Potvrdi nastavak" data-done="Tenant ponovno aktivan." disabled={!verified}>Nastavi (resume)</button> : null}
            {r ? <button class="btn" data-post={`${base}/rail/verify`} data-render="verify">Pokreni provjeru</button> : null}
            {r ? <button class="btn" data-post={`${base}/rail/rewrap`} data-confirm="Potvrdi re-enkripciju" data-done="Tajne re-enkriptirane pod trenutačnim KEK-om.">Re-enkriptiraj tajne (KEK)</button> : null}
          </div>
          <div id="verifyOut" />
        </div>
      </section>

      <section class="card">
        <div class="card-h"><h2>Monerium rail</h2>{r ? <span class="dim small">ažuriran {fmtDate((r as { updated_at?: number }).updated_at ?? null)}</span> : null}</div>
        {locked ? <div class="card-b" style="padding-bottom:0"><div class="callout warn" role="note"><span><strong>Tenant je aktivan.</strong> Polja su zaključana; promjena pod živim tenantom bi uplate u letu spojila s drugom konfiguracijom. Suspendiraj ga gore.</span></div></div> : null}
        <form class="card-b form" data-api={`${base}/rail`} data-method="PUT" data-done="Rail spremljen. Pokreni provjeru.">
          <fieldset disabled={locked} style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:14px;min-width:0">
            <div class="cols" style="gap:12px">
              <label style="flex:1 1 160px">Monerium okruženje<select name="monerium_env">
                {['production', 'sandbox'].map((v) => <option value={v} selected={(r?.monerium_env ?? 'production') === v}>{v}</option>)}
              </select></label>
              <label style="flex:1 1 160px">Lanac<select name="chain">
                {['gnosis', 'chiado'].map((v) => <option value={v} selected={(r?.chain ?? 'gnosis') === v}>{v}</option>)}
              </select></label>
              <label style="flex:1 1 160px">Način<select name="mode">
                {[['forward', 'forward (ProjectRouter)'], ['direct', 'direct (mint na projekt)']].map(([v, l]) => <option value={v} selected={(r?.mode ?? 'forward') === v}>{l}</option>)}
              </select></label>
            </div>
            <div class="cols" style="gap:12px">
              <label style="flex:1 1 220px">Client ID<input name="client_id" class="mono" required value={r?.client_id ?? ''} /></label>
              <label style="flex:1 1 220px">Client secret<input name="client_secret" type="password" autocomplete="off" placeholder={r?.client_secret_enc ? 'spremljen — prazno = zadrži' : 'obavezno'} required={!r} /></label>
            </div>
            <label>Monerium profil ID<input name="profile_id" class="mono" required value={r?.profile_id ?? ''} /></label>
            <label>Prihvatni Safe<input name="receiving_safe" class="mono" required pattern="^0x[0-9a-fA-F]{40}$" value={r?.receiving_safe ?? ''} /></label>
            <div class="cols" style="gap:12px">
              <label style="flex:2 1 280px">Roles modifier<input name="roles_modifier" class="mono" pattern="^0x[0-9a-fA-F]{40}$" value={r?.roles_modifier ?? ''} placeholder="forward: Zodiac Roles" /></label>
              <label style="flex:1 1 200px">Role key<input name="role_key" class="mono" value={r?.role_key ?? ''} placeholder="0x… (bytes32)" /></label>
            </div>
            <div class="cols" style="gap:12px">
              <label style="flex:2 1 280px">EURe ugovor<input name="eure_contract" class="mono" pattern="^0x[0-9a-fA-F]{40}$" value={r?.eure_contract ?? ''} placeholder="obavezno na chiado" /></label>
              <label style="flex:2 1 280px">RPC URL<input name="rpc_url" value={r?.rpc_url ?? ''} placeholder="https://… (neobavezno)" /></label>
            </div>
            <div class="cols" style="gap:12px">
              <label style="flex:2 1 280px">Outbound webhook (merchant)<input name="outbound_webhook_url" value={r?.outbound_webhook_url ?? ''} placeholder="https://…" /></label>
              <label style="flex:1 1 200px">Outbound tajna<input name="outbound_webhook_secret" type="password" autocomplete="off" placeholder={r?.outbound_webhook_secret_enc ? 'spremljena — prazno = zadrži' : 'obavezno uz URL'} /></label>
            </div>
            <label>Kapica po forwardu (centi)<input name="max_forward_cents" inputmode="numeric" pattern="^[0-9]*$" value={r?.max_forward_cents == null ? '' : String(r.max_forward_cents)} placeholder="prazno = bez kapice" />
              {r?.max_forward_cents ? <span class="dim small">{fmtEur(r.max_forward_cents)}</span> : null}</label>
            <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit" data-confirm="Potvrdi spremanje raila">Spremi rail</button></div>
          </fieldset>
        </form>
      </section>

      {r ? (
        <section class="card">
          <div class="card-h"><h2>Router i webhook</h2></div>
          <div class="check"><span class="two" style="flex:1"><strong>Router EOA</strong><Mono>{r.router_address ?? 'nije generiran'}</Mono>
            <span class="dim small">Rotacija znači novi batch 007 na tenantovu Safeu. U direct modu router ne treba.</span></span>
            {r.router_key_enc
              ? <button class="btn danger" data-post={`${base}/rail/router-key?rotate=1`} data-confirm="Potvrdi rotaciju ključa" data-done="Novi router ključ generiran." disabled={locked}>Rotiraj ključ</button>
              : <button class="btn" data-post={`${base}/rail/router-key`} data-confirm="Potvrdi generiranje" data-done="Router ključ generiran." disabled={locked}>Generiraj ključ</button>}
          </div>
          <div class="check"><span class="two" style="flex:1"><strong>Monerium webhook</strong><Mono>{r.webhook_subscription_id ? `pretplata ${r.webhook_subscription_id}` : 'nije registriran'}</Mono>
            <span class="dim small">Registrira pretplatu na Moneriumu i gasi prethodnu.</span></span>
            <button class="btn" data-post={`${base}/rail/webhook`} data-confirm="Potvrdi registraciju" data-done="Webhook registriran." disabled={locked}>{r.webhook_subscription_id ? 'Ponovno registriraj' : 'Registriraj'}</button>
          </div>
          {!d.tenant?.sandbox ? <div class="check"><span class="two" style="flex:1"><strong>On-chain setup</strong><span class="dim small">Plan, simulacija i potpis vlasnika Safea (ADR 0027).</span></span><a class="btn" href={`/admin/tenants/${enc(id)}/setup`}>Otvori setup</a></div> : null}
        </section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------
// Ključevi i računi
// ---------------------------------------------------------------------------

export const KeysPage: FC<{ id: string; d: TenantDetailData }> = ({ id, d }) => {
  const base = `/admin/api/tenants/${enc(id)}`;
  const sbx = Boolean(d.tenant?.sandbox);
  return (
    <>
      <TenantHead id={id} d={d} tab="keys" />
      <section class="card">
        <div class="card-h"><h2>API ključevi</h2><span class="dim small">{sbx ? 'sandbox tenant dobiva samo test ključeve' : ''}</span></div>
        {d.keys.length ? <div class="tbl"><table>
          <thead><tr><th>Ključ</th><th>Vrsta</th><th>Izdan</th><th>Status</th><th class="r"></th></tr></thead>
          <tbody>{d.keys.map((k) => (
            <tr>
              <td><span class="two"><strong>{k.label ?? (k.kind === 'secret' ? 'Tajni ključ' : 'Javni ključ')}</strong><Mono>{k.key_hash.slice(0, 12)}…</Mono></span></td>
              <td><Pill tone={k.kind === 'secret' ? 'warn' : 'info'}>{k.kind}</Pill></td>
              <td class="dim">{fmtDate(k.created_at)}</td>
              <td>{k.revoked_at ? <Pill tone="muted">opozvan {fmtDate(k.revoked_at)}</Pill> : <Pill tone="ok">aktivan</Pill>}</td>
              <td class="r">{k.revoked_at ? null : <button class="btn danger" data-post={`${base}/keys/${k.key_hash.slice(0, 12)}`} data-method="DELETE"
                data-confirm="Potvrdi opoziv (integracija prestaje raditi)" data-done="Ključ opozvan.">Opozovi</button>}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>Nema ključeva.</Empty>}
        <form class="card-b form" data-api={`${base}/keys`} data-show="key" style="border-top:1px solid var(--line)">
          <h2>Izdaj ključ</h2>
          <div class="cols" style="gap:12px">
            <label style="flex:1 1 160px">Vrsta<select name="kind"><option value="public">javni (pk_)</option><option value="secret">tajni (sk_)</option></select></label>
            <label style="flex:2 1 240px">Naziv<input name="label" placeholder="npr. Shopify produkcija" /></label>
          </div>
          <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit" data-confirm="Potvrdi izdavanje">Izdaj ključ</button></div>
          <div data-out hidden class="callout warn" role="status" />
        </form>
      </section>

      <section class="card">
        <div class="card-h"><h2>Računi kod drugih providera (ADR 0032)</h2></div>
        {d.accounts.length ? <div class="tbl"><table>
          <thead><tr><th>Račun</th><th>Provider</th><th>IBAN / ID</th><th>Status</th><th class="r"></th></tr></thead>
          <tbody>{d.accounts.map((a) => (
            <tr>
              <td><strong>{a.label ?? a.provider}</strong></td>
              <td><span class="two"><span>{a.provider}</span><Mono>{a.mode} · {a.environment}</Mono></span></td>
              <td><Mono>{a.iban ?? a.external_account_id ?? '—'}</Mono></td>
              <td>{a.active ? <Pill tone="ok">aktivan</Pill> : <Pill tone="muted">neaktivan</Pill>}</td>
              <td class="r">{a.active ? <button class="btn danger" data-post={`${base}/receiving-accounts/${a.id}/deactivate`} data-confirm="Potvrdi deaktivaciju" data-done="Račun deaktiviran.">Deaktiviraj</button> : null}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>Nema računa kod drugih providera.</Empty>}
        <form class="card-b form" data-api={`${base}/receiving-accounts`} data-done="Swan račun dodan." style="border-top:1px solid var(--line)">
          <h2>Dodaj Swan račun</h2>
          <input type="hidden" name="provider" value="swan" />
          <div class="cols" style="gap:12px">
            <label style="flex:1 1 140px">Okruženje<select name="environment">
              {sbx ? <option value="sandbox">sandbox</option> : <><option value="live">live</option><option value="sandbox">sandbox</option></>}
            </select></label>
            <label style="flex:2 1 240px">Swan account ID<input name="external_account_id" class="mono" required /></label>
          </div>
          <div class="cols" style="gap:12px">
            <label style="flex:1 1 200px">Client ID<input name="client_id" class="mono" required /></label>
            <label style="flex:1 1 200px">Client secret<input name="client_secret" type="password" autocomplete="off" required /></label>
            <label style="flex:1 1 200px">Webhook tajna<input name="webhook_secret" type="password" autocomplete="off" placeholder="neobavezno" /></label>
          </div>
          <div class="cols" style="gap:12px">
            <label style="flex:2 1 240px">IBAN<input name="iban" class="mono" placeholder="prikazuje se uplatitelju" /></label>
            <label style="flex:1 1 160px">Naziv<input name="label" placeholder="neobavezno" /></label>
          </div>
          <span class="dim small">Webhook na Swanu: <Mono>/api/swan/webhook/t/{id}</Mono></span>
          <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit" data-confirm="Potvrdi dodavanje">Dodaj račun</button></div>
        </form>
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Novi tenant
// ---------------------------------------------------------------------------

export const NewTenantPage: FC = () => (
  <>
    <a href="/admin/v2/tenants" class="small">← Tenanti</a>
    <div class="row"><h1>Novi tenant</h1></div>
    <p class="dim" style="margin:0">Tenant nastaje u statusu <strong>onboarding</strong>. Zatim: rail (Monerium profil, Safe), provjera, aktivacija.
      Svaki tenant traži vlastiti Monerium KYB. Sandbox tenanti (<Mono>sbx-</Mono>) nastaju samoposlužno, ne ovdje.</p>
    <section class="card" style="max-width:640px">
      <form class="card-b form" data-api="/admin/api/tenants" data-redirect="/admin/v2/tenants/{tenant_id}/rail">
        <label>ID<input name="id" class="mono" required pattern="^[a-z0-9][a-z0-9\-]{1,62}$" placeholder="npr. zupa-maksimir" autocomplete="off" />
          <span class="dim small">mala slova, brojke i crtica; ne može se promijeniti</span></label>
        <label>Naziv<input name="name" required placeholder="npr. Župa sv. Antuna" /></label>
        <label>Primatelj na uplatnici<input name="beneficiary_name" placeholder="prazno = naziv" /></label>
        <div class="cols" style="gap:12px">
          <label style="flex:2 1 260px">IBAN (tenantov Monerium IBAN)<input name="iban" class="mono" required /></label>
          <label style="flex:1 1 140px">BIC<input name="bic" class="mono" placeholder="neobavezno" /></label>
        </div>
        <div class="acts" style="justify-content:flex-start"><button class="btn primary" type="submit">Kreiraj tenanta</button></div>
      </form>
    </section>
  </>
);
