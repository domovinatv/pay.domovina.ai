// Admin v2 — globalne stranice koje nisu po tenantu ni po okruženju:
// DOMOVINA walleti (wallet_registry) i sybil signali, te Postavke (alert
// kanal, admin passkeyi). Samo prikaz; akcije zovu postojeće rute
// (/admin/api/alert-test, /admin/passkey/register/*, /admin/passkeys/:id/delete).

import type { FC } from 'hono/jsx';

import { Empty, explorerAddr, fmtDate, Mono, Pill, short } from './ui';

const enc = encodeURIComponent;
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export type WalletTab = 'wallets' | 'sybil';

const WalletNav: FC<{ tab: WalletTab }> = ({ tab }) => (
  <nav class="subnav" aria-label="Walleti">
    <a class={tab === 'wallets' ? 'on' : ''} href="/admin/v2/wallets">Walleti</a>
    <a class={tab === 'sybil' ? 'on' : ''} href="/admin/v2/wallets/sybil">Sybil signali</a>
  </nav>
);

const GlobalNote: FC = () => (
  <div class="callout info" role="note">
    <span><strong>Globalno:</strong> wallet.domovina.ai registar nije po tenantu ni po okruženju; prekidač Produkcija/Sandbox ovdje ne filtrira.
      Telefon se nikad ne sprema sirov, samo hash (prikazan skraćeno).</span>
  </div>
);

export type WalletListRow = {
  credential_id: string; safe_address: string; signer_address: string; rp_id: string; recovery_owner: string | null;
  created_at: number; phones: Array<{ phone_hash: string; first_bound_at: number; latest_verified_at: number; verification_count: number }>;
};

export const WalletsPage: FC<{ rows: WalletListRow[]; total: number; withPhone: number; phoneOnly: boolean; offset: number; limit: number; shared: Set<string> }> = ({ rows, total, withPhone, phoneOnly, offset, limit, shared }) => {
  const qs = (o: number) => `?${phoneOnly ? 'phone=1&' : ''}offset=${o}`;
  return (
    <>
      <div class="row"><h1>Walleti</h1><span class="dim small">{total} ukupno · {withPhone} s telefonom</span></div>
      <WalletNav tab="wallets" />
      <GlobalNote />
      <div class="chips">
        <a class={phoneOnly ? 'chip' : 'chip on'} href="/admin/v2/wallets">Svi</a>
        <a class={phoneOnly ? 'chip on' : 'chip'} href="/admin/v2/wallets?phone=1">S telefonom</a>
      </div>
      <section class="card">
        {rows.length ? <div class="tbl"><table>
          <thead><tr><th>Safe</th><th>Signer</th><th>RP</th><th>Oporavak</th><th>Telefon</th><th>Kreiran</th></tr></thead>
          <tbody>{rows.map((w) => (
            <tr>
              <td><a href={explorerAddr('gnosis', w.safe_address)} target="_blank" rel="noopener"><Mono title={w.safe_address}>{short(w.safe_address, 8, 6)}</Mono></a></td>
              <td><Mono title={w.signer_address}>{short(w.signer_address, 6, 4)}</Mono></td>
              <td class="dim small">{w.rp_id}</td>
              <td>{w.recovery_owner ? <Pill tone="ok">seed / EOA</Pill> : <Pill tone="muted">samo passkey</Pill>}</td>
              <td>{w.phones.length ? w.phones.map((p) => (
                <div class="small">
                  <a href={`/admin/v2/wallets/sybil?phone=${p.phone_hash}`}><Mono title="hash telefona">{shortHash(p.phone_hash)}</Mono></a>
                  {' '}<span class="dim">×{p.verification_count} · {fmtDate(p.latest_verified_at)}</span>
                  {shared.has(p.phone_hash) ? <> <Pill tone="warn">dijeli ga više walleta</Pill></> : null}
                </div>
              )) : <span class="dim">—</span>}</td>
              <td class="dim">{fmtDate(w.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>{phoneOnly ? 'Nijedan wallet na ovoj stranici nema telefon.' : 'Nema walleta.'}</Empty>}
      </section>
      <div class="chips">
        {offset > 0 ? <a class="btn" href={qs(Math.max(0, offset - limit))}>← Novije</a> : null}
        {offset + limit < total ? <a class="btn" href={qs(offset + limit)}>Starije →</a> : null}
        {phoneOnly ? <span class="dim small">Filtar „s telefonom” radi po stranici od {limit} (kao v1).</span> : null}
      </div>
    </>
  );
};

export type SybilClusterRow = { phone_hash: string; wallet_count: number; first_bound_at: number; latest_verified_at: number };
export type SybilWalletRow = { credential_id: string; safe_address: string | null; first_bound_at: number; latest_verified_at: number; verification_count: number };

export const SybilPage: FC<{ clusters: SybilClusterRow[]; phone?: string; drill?: SybilWalletRow[] }> = ({ clusters, phone, drill }) => (
  <>
    <div class="row"><h1>Sybil signali</h1><span class="dim small">{clusters.length} telefona dijeli 2+ walleta</span></div>
    <WalletNav tab="sybil" />
    <div class="callout warn" role="note">
      <span>Telefon koji dijeli više walleta. Legitimno ali rijetko: isti vlasnik preselio na novi wallet. Klaster od 3+ walleta u kratkom
        vremenu je tipičan sybil signal. Telefon je <strong>verifikacija, ne oporavak</strong>.</span>
    </div>
    {phone && drill ? (
      <section class="card">
        <div class="card-h"><h2>Walleti s telefonom <Mono>{shortHash(phone)}</Mono></h2><a class="small" href="/admin/v2/wallets/sybil">Zatvori</a></div>
        {drill.length ? <div class="tbl"><table>
          <thead><tr><th>Safe</th><th>Credential</th><th>Prvo vezan</th><th>Zadnja verifikacija</th><th class="r">Verifikacija</th></tr></thead>
          <tbody>{drill.map((w) => (
            <tr>
              <td>{w.safe_address ? <a href={explorerAddr('gnosis', w.safe_address)} target="_blank" rel="noopener"><Mono title={w.safe_address}>{short(w.safe_address, 8, 6)}</Mono></a> : <span class="dim">nije u registru</span>}</td>
              <td><Mono title={w.credential_id}>{short(w.credential_id, 8, 6)}</Mono></td>
              <td class="dim">{fmtDate(w.first_bound_at)}</td>
              <td class="dim">{fmtDate(w.latest_verified_at)}</td>
              <td class="r">{w.verification_count}</td>
            </tr>
          ))}</tbody>
        </table></div> : <Empty>Nijedan wallet nema taj telefon.</Empty>}
      </section>
    ) : null}
    <section class="card">
      {clusters.length ? <div class="tbl"><table>
        <thead><tr><th>Telefon (hash)</th><th>Walleti</th><th>Prvo vezan</th><th>Zadnja verifikacija</th></tr></thead>
        <tbody>{clusters.map((c) => (
          <tr data-href={`/admin/v2/wallets/sybil?phone=${c.phone_hash}`} class={c.phone_hash === phone ? 'sel' : ''}>
            <td><Mono>{shortHash(c.phone_hash)}</Mono></td>
            <td><Pill tone={c.wallet_count >= 3 ? 'bad' : 'warn'}>{c.wallet_count}</Pill></td>
            <td class="dim">{fmtDate(c.first_bound_at)}</td>
            <td class="dim">{fmtDate(c.latest_verified_at)}</td>
          </tr>
        ))}</tbody>
      </table></div> : <Empty>Nema klastera: svaki telefon pripada jednom walletu.</Empty>}
    </section>
  </>
);

export type AdminPasskeyRow = { id: string; label: string; created_at: string; last_used_at: string | null };

export const SettingsPage: FC<{ email: string | null; passkeys: AdminPasskeyRow[] }> = ({ email, passkeys }) => (
  <>
    <div class="row"><h1>Postavke</h1></div>

    <section class="card">
      <div class="card-h"><h2>Alert kanal (Telegram)</h2></div>
      <div class="card-b">
        <p class="small">Alerti su fail-open: pukli kanal se sam ne javlja. Gumb šalje probnu poruku iz Workera (pravi secreti, pravi chat)
          i upisuje <Mono>alert.test</Mono> u audit log.</p>
        <div class="acts" style="justify-content:flex-start;align-items:center;gap:12px">
          <button class="btn primary" data-post="/admin/api/alert-test" data-render="alert">Pošalji probnu poruku</button>
          <span id="alertOut" class="small" aria-live="polite" />
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-h"><h2>Moji passkeyi{email ? <> · <span class="dim">{email}</span></> : null}</h2></div>
      {passkeys.length ? <div class="tbl"><table>
        <thead><tr><th>Oznaka</th><th>Upisan</th><th>Zadnja uporaba</th><th class="r"></th></tr></thead>
        <tbody>{passkeys.map((p) => (
          <tr>
            <td><strong>{p.label}</strong></td>
            <td class="dim">{fmtDate(Math.floor(Date.parse(p.created_at) / 1000))}</td>
            <td class="dim">{p.last_used_at ? fmtDate(Math.floor(Date.parse(p.last_used_at) / 1000)) : '—'}</td>
            <td class="r"><button class="btn danger" data-post={`/admin/passkeys/${enc(p.id)}/delete`} data-confirm="Potvrdi uklanjanje" data-done="Passkey uklonjen.">Ukloni</button></td>
          </tr>
        ))}</tbody>
      </table></div> : <Empty>Još nema passkeya. Dodaj prvi ispod.</Empty>}
      <form id="passkey-register" class="card-b form" style="border-top:1px solid var(--line)">
        <h2>Dodaj passkey</h2>
        <div class="cols" style="gap:12px;align-items:flex-end">
          <label style="flex:1 1 260px">Oznaka uređaja<input type="text" name="label" placeholder="npr. MacBook / Apple Passwords" maxlength={80} required /></label>
          <button class="btn primary" type="submit">Dodaj passkey</button>
        </div>
        <div id="msg" class="msg small" hidden />
        <p class="dim small">Upis traži prijavu iz zadnjih 10 minuta, najviše 5 passkeya po e-mailu. Passkey vrijedi samo za ovu domenu;
          Access (OTP na e-mail) ostaje drugi put ulaska i služi za oporavak.</p>
      </form>
    </section>
    <script src="/admin/static/passkey.js" />
  </>
);
