// Admin v2 — zajednički UI: layout (sidebar + top bar), statusi, formati.
// Server-rendered hono/jsx; JS samo za tipku „/”, dvostupanjske akcije i
// prekidač okruženja. Prijedlog dizajna: claude.ai/artifact/J2k6b16iXWbecMKWJ2NQwK

import type { Child, FC } from 'hono/jsx';
import { raw } from 'hono/html';

import type { Mode, Scope } from './scope';
import type { PayStatus } from './data';

// ---------------------------------------------------------------------------
// Formati — jedan format datuma i iznosa za cijeli admin
// ---------------------------------------------------------------------------

const TZ = 'Europe/Zagreb';
const dtFmt = new Intl.DateTimeFormat('hr-HR', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dtSecFmt = new Intl.DateTimeFormat('hr-HR', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const eurFmt = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (unix: number | null | undefined) => (unix ? dtFmt.format(new Date(unix * 1000)) : '—');
export const fmtDateSec = (unix: number | null | undefined) => (unix ? dtSecFmt.format(new Date(unix * 1000)) : '—');
export const fmtIso = (iso: string | null | undefined) => (iso ? fmtDateSec(Math.floor(Date.parse(iso) / 1000)) : '—');
export const fmtEur = (cents: number | null | undefined) => (cents == null ? '—' : `${eurFmt.format(cents / 100)} €`);
export const fmtAmountStr = (amount: string | null | undefined) => (amount == null ? '—' : fmtEur(Math.round(Number(amount) * 100)));
export const short = (s: string | null | undefined, head = 6, tail = 4) =>
  !s ? '—' : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

/// 1 tenant, 2–4 tenanta, 5+ tenanata (11–14 uvijek „tenanata”).
export function tenantCount(n: number): string {
  const d = n % 10, h = n % 100;
  const w = d === 1 && h !== 11 ? 'tenant' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'tenanta' : 'tenanata';
  return `${n} ${w}`;
}

export function ago(unix: number | null | undefined): string {
  if (!unix) return '—';
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return 'upravo';
  if (s < 3600) return `prije ${Math.floor(s / 60)} min`;
  if (s < 86400) return `prije ${Math.floor(s / 3600)} h`;
  return `prije ${Math.floor(s / 86400)} d`;
}

export function explorerTx(chain: string | null | undefined, tx: string): string {
  return chain === 'chiado' ? `https://gnosis-chiado.blockscout.com/tx/${tx}` : `https://gnosisscan.io/tx/${tx}`;
}
export function explorerAddr(chain: string | null | undefined, a: string): string {
  return chain === 'chiado' ? `https://gnosis-chiado.blockscout.com/address/${a}` : `https://gnosisscan.io/address/${a}`;
}

// ---------------------------------------------------------------------------
// Statusi
// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

export const PAY_LABEL: Record<PayStatus, string> = {
  paid: 'Plaćeno',
  processing: 'U obradi',
  stuck: 'Zapelo',
  pending: 'Na čekanju',
  expired: 'Istekao',
};
export const PAY_TONE: Record<PayStatus, Tone> = {
  paid: 'ok',
  processing: 'info',
  stuck: 'warn',
  pending: 'info',
  expired: 'muted',
};

export const FWD_LABEL: Record<string, [string, Tone]> = {
  pending: ['U pripremi', 'info'],
  submitted: ['Poslano', 'info'],
  confirmed: ['Potvrđeno', 'ok'],
  failed: ['Neuspjelo', 'bad'],
  blocked: ['Blokirano', 'warn'],
  resolved_offrail: ['Riješeno ručno', 'muted'],
};

export const Pill: FC<{ tone: Tone; children?: Child }> = ({ tone, children }) => <span class={`pill ${tone}`}>{children}</span>;

export const PayPill: FC<{ status: PayStatus }> = ({ status }) => <Pill tone={PAY_TONE[status]}>{PAY_LABEL[status]}</Pill>;

export const FwdPill: FC<{ status: string }> = ({ status }) => {
  const [l, t] = FWD_LABEL[status] ?? [status, 'muted' as Tone];
  return <Pill tone={t}>{l}</Pill>;
};

export const Mono: FC<{ children?: Child; title?: string }> = ({ children, title }) => <span class="mono" title={title}>{children}</span>;

export const Empty: FC<{ children?: Child }> = ({ children }) => <div class="empty">{children}</div>;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type NavKey = 'home' | 'payments' | 'payouts' | 'tenants' | 'webhooks' | 'inbox' | 'outbox' | 'audit' | 'search';

interface LayoutProps {
  title: string;
  nav: NavKey;
  scope: Scope;
  email: string | null;
  path: string;
  children?: Child;
  q?: string;
}

const NavLink: FC<{ href: string; active: boolean; children?: Child; ext?: boolean }> = ({ href, active, children, ext }) => (
  <a href={href} class={active ? 'nav active' : 'nav'} aria-current={active ? 'page' : undefined}>
    {children}
    {ext ? <span class="ext" title="otvara v1">v1</span> : null}
  </a>
);

export const Layout: FC<LayoutProps> = ({ title, nav, scope, email, path, children, q }) => {
  const sbx = scope.mode === 'sandbox';
  const prodCount = scope.all.filter((t) => !t.sandbox).length;
  const sbxCount = scope.all.length - prodCount;
  const modeLink = (m: Mode) => `/admin/v2/mode/${m}?next=${encodeURIComponent(path)}`;
  return (
    <html lang="hr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <meta name="theme-color" content="#002F6C" />
        <title>{`${title} — MPT Admin`}</title>
        <style>{raw(CSS)}</style>
      </head>
      <body class={sbx ? 'sandbox' : ''}>
        <div class="app">
          <aside class="side">
            <a class="acct" href="/admin/v2">
              <span class="logo">M</span>
              <span class="acct-txt">
                <strong>MPT Admin</strong>
                <span class="dim">{`${sbx ? 'Sandbox' : 'Produkcija'} · ${tenantCount(scope.tenants.length)}`}</span>
              </span>
            </a>
            <nav aria-label="Glavna navigacija" class="navgroup">
              <NavLink href="/admin/v2" active={nav === 'home'}>Pregled</NavLink>
              <NavLink href="/admin/v2/payments" active={nav === 'payments'}>Uplate</NavLink>
              <NavLink href="/admin/v2/payouts" active={nav === 'payouts'}>Isplate (forwardi)</NavLink>
              <NavLink href="/admin/v2/tenants" active={nav === 'tenants'}>Tenanti</NavLink>
            </nav>
            <div class="navgroup">
              <span class="navhead">Developeri</span>
              <NavLink href="/admin/v2/developers?tab=events" active={nav === 'webhooks'}>Webhookovi</NavLink>
              <NavLink href="/admin/v2/developers?tab=inbox" active={nav === 'inbox'}>Priljevi (inbox)</NavLink>
              <NavLink href="/admin/v2/developers?tab=outbox" active={nav === 'outbox'}>Odlazne isporuke</NavLink>
              <NavLink href="/admin/v2/developers?tab=audit" active={nav === 'audit'}>Audit log</NavLink>
            </div>
            <div class="navgroup">
              <span class="navhead">Wallet (domovina.ai)</span>
              <NavLink href="/admin/wallets" active={false} ext>Walleti</NavLink>
              <NavLink href="/admin/sybil" active={false} ext>Sybil signali</NavLink>
            </div>
            <div class="navgroup foot">
              <NavLink href="/admin/passkeys" active={false} ext>Passkeyi</NavLink>
              <NavLink href="/admin/whitelist" active={false} ext>Alert kanal</NavLink>
              <a class="nav" href="/admin/">← Stari admin (v1)</a>
              <form method="post" action="/admin/logout" class="logout">
                <span class="dim small">{email ?? ''}</span>
                <button type="submit" class="link">Odjava</button>
              </form>
            </div>
          </aside>
          <div class="content">
            <header class="top">
              <form class="search" method="get" action="/admin/v2/search" role="search">
                <label for="q" class="sr">Pretraga</label>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
                <input id="q" name="q" type="search" value={q ?? ''} placeholder="Traži SID, kratku ref., 0x adresu, tx, IBAN, order id…" autocomplete="off" />
                <kbd>/</kbd>
              </form>
              <div class="seg" role="group" aria-label="Okruženje">
                <a href={modeLink('production')} class={sbx ? '' : 'on'} aria-pressed={sbx ? 'false' : 'true'}>Produkcija <span class="cnt">{prodCount}</span></a>
                <a href={modeLink('sandbox')} class={sbx ? 'on sbx' : ''} aria-pressed={sbx ? 'true' : 'false'}>Sandbox <span class="cnt">{sbxCount}</span></a>
              </div>
              <a class="btn primary" href="/admin/v2/payments/new">+ Novi intent</a>
            </header>
            {sbx ? (
              <div class="sbxbar"><strong>Sandbox podaci</strong> — samo sandbox/chiado i <span class="mono">sbx-</span> tenanti. Ništa ovdje nije pravi novac.</div>
            ) : null}
            <main class="main">{children}</main>
          </div>
        </div>
        <script>{raw(JS)}</script>
      </body>
    </html>
  );
};

// ---------------------------------------------------------------------------
// Stil
// ---------------------------------------------------------------------------

const CSS = `
:root{--bg:#fff;--side:#F7F8FA;--line:#E3E8EE;--line2:#F0F2F5;--text:#1A1F36;--dim:#5B6478;--navy:#002F6C;--navy-bg:#E6ECF5;--link:#1D4ED8;
--ok:#0B6B35;--ok-bg:#D7F7E3;--info:#1E40AF;--info-bg:#E0EBFF;--warn:#8A4B00;--warn-bg:#FFEBD3;--bad:#A1161B;--bad-bg:#FDE2E2;--muted:#4A5466;--muted-bg:#EEF0F3;--sbx:#B45309}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace;font-size:12.5px}
.dim{color:var(--dim)}.small{font-size:12px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.num{font-variant-numeric:tabular-nums}
.app{display:flex;flex-wrap:wrap;min-height:100vh}
.side{flex:1 1 232px;max-width:248px;background:var(--side);border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:18px}
.acct{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--text)}
.acct:hover{text-decoration:none;border-color:#C4CBD6}
.logo{width:28px;height:28px;border-radius:6px;background:var(--navy);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
body.sandbox .logo{background:var(--sbx)}
.acct-txt{display:flex;flex-direction:column;min-width:0}.acct-txt .dim{font-size:12px}
.navgroup{display:flex;flex-direction:column;gap:2px}
.navhead{font-size:11.5px;font-weight:600;color:var(--dim);padding:0 10px 4px;text-transform:uppercase;letter-spacing:.04em}
.nav{padding:7px 10px;border-radius:6px;color:var(--text);display:flex;justify-content:space-between;align-items:center}
.nav:hover{background:#EDF0F4;text-decoration:none}
.nav.active{background:var(--navy-bg);color:var(--navy);font-weight:600}
.ext{font-size:10.5px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.foot{margin-top:auto;border-top:1px solid var(--line);padding-top:12px}
.logout{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;gap:8px}
button.link{background:none;border:0;color:var(--link);font:inherit;cursor:pointer;padding:0}
.content{flex:999 1 560px;min-width:0;display:flex;flex-direction:column}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 32px;border-bottom:1px solid var(--line)}
.search{flex:1 1 320px;display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:0 12px;min-height:40px;color:var(--dim)}
.search:focus-within{border-color:var(--navy);box-shadow:0 0 0 3px var(--navy-bg)}
.search input{border:0;outline:0;flex:1;font:inherit;color:var(--text);background:transparent;min-width:0}
kbd{font:11px ui-monospace,monospace;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg a{padding:0 14px;min-height:40px;display:flex;align-items:center;gap:6px;color:var(--dim);background:#fff}
.seg a:hover{text-decoration:none;background:var(--side)}
.seg a.on{background:var(--navy);color:#fff;font-weight:600}.seg a.on.sbx{background:var(--sbx)}
.seg .cnt{font-size:11px;opacity:.75}
.sbxbar{background:#FFF4E5;color:#7A3E00;font-size:13px;padding:8px 32px;border-bottom:1px solid #F5D9B0}
.main{padding:28px 32px 56px;display:flex;flex-direction:column;gap:24px;max-width:1240px;width:100%}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.01em}
h2{margin:0;font-size:15px;font-weight:600}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.cols{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
.card{border:1px solid var(--line);border-radius:10px;background:#fff;min-width:0}
.card-h{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}
.card-b{padding:16px 20px}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;color:var(--text);border-radius:8px;padding:0 14px;min-height:36px;font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.btn:hover{text-decoration:none;border-color:#C4CBD6}
.acts{display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
input.reason{border:1px solid var(--line);border-radius:8px;padding:0 10px;min-height:36px;font:inherit;min-width:0}
input.reason:focus{outline:0;border-color:var(--navy);box-shadow:0 0 0 3px var(--navy-bg)}
.btn.primary{background:var(--navy);border-color:var(--navy);color:#fff;font-weight:600;min-height:40px}
.btn.danger{color:var(--bad)}.btn[data-armed]{background:var(--bad);border-color:var(--bad);color:#fff}
.btn:disabled{opacity:.55;cursor:default}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 8px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.info{background:var(--info-bg);color:var(--info)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.muted{background:var(--muted-bg);color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));border:1px solid var(--line);border-radius:10px;overflow:hidden}
.kpi{padding:18px 20px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
.kpi:last-child{border-right:0}.kpi .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.kpi .l{font-size:13px;color:var(--dim)}.kpi .s{font-size:12px;color:var(--dim)}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 12px;font-size:13px;color:var(--text)}
.chip:hover{text-decoration:none;border-color:#C4CBD6}.chip.on{border-color:var(--navy);background:var(--navy-bg);color:var(--navy);font-weight:500}
.tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tab{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;color:var(--text);background:#fff}
.tab:hover{text-decoration:none;border-color:#C4CBD6}.tab.on{border:2px solid var(--navy);padding:9px 13px}
.tab .l{font-size:13px;color:var(--dim)}.tab .c{font-size:20px;font-weight:600}
.subnav{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto}
.subnav a{padding:10px 12px;color:var(--dim);font-weight:500;border-bottom:2px solid transparent;white-space:nowrap}
.subnav a:hover{text-decoration:none;color:var(--text)}.subnav a.on{color:var(--navy);font-weight:600;border-bottom-color:var(--navy)}
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;font-weight:500;color:var(--dim);padding:10px 12px;background:#FAFBFC;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--line2);vertical-align:top}
tr:last-child td{border-bottom:0}
th:first-child,td:first-child{padding-left:20px}th:last-child,td:last-child{padding-right:20px}
tr.click{cursor:pointer}tr.click:hover td{background:#FAFBFC}
td.r,th.r{text-align:right}
.amt{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text)}
.two{display:flex;flex-direction:column;gap:2px;min-width:0}.two .mono{color:var(--dim)}
.pager{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-top:1px solid var(--line);font-size:13px;color:var(--dim)}
.empty{padding:28px 20px;color:var(--dim);text-align:center}
.attn a{display:flex;gap:12px;padding:13px 20px;border-bottom:1px solid var(--line2);color:var(--text);align-items:flex-start}
.attn a:hover{background:#FAFBFC;text-decoration:none}.attn a:last-child{border-bottom:0}
.dot{width:8px;height:8px;border-radius:999px;margin-top:6px;flex:none}.dot.warn{background:#D97706}.dot.error{background:#DC2626}.dot.ok{background:#16A34A}
.attn .cta{font-size:13px;color:var(--link);white-space:nowrap}
.chart{display:flex;align-items:flex-end;gap:4px;height:180px;border-bottom:1px solid var(--line)}
.bar{flex:1;display:flex;align-items:flex-end;height:100%}.bar span{display:block;width:100%;background:var(--navy);border-radius:3px 3px 0 0;min-height:2px}
.bar span.zero{background:var(--line)}
.bar span.stack{display:flex;flex-direction:column-reverse;overflow:hidden;background:none!important}.bar span.stack i{display:block;width:100%;flex-basis:0;min-height:1px}
.ch-monerium{background:var(--navy)}.ch-swan{background:#0E9F6E}.ch-sim{background:var(--sbx)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px;font-size:13px}.legend a{color:var(--text);display:inline-flex;align-items:center;gap:6px}.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
body.sandbox .bar span{background:var(--sbx)}
.axis{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin-top:6px}
dl.kv{margin:0;display:grid;grid-template-columns:minmax(110px,.8fr) minmax(0,1.6fr);gap:9px 14px;font-size:13px}
dl.kv dt{color:var(--dim)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.callout{display:flex;gap:12px;padding:14px 16px;border-radius:10px;border:1px solid}
.callout.warn{background:#FFF4E5;border-color:#F5D9B0;color:#7A3E00}.callout.bad{background:#FEF2F2;border-color:#F9CACA;color:#7F1D1D}.callout.info{background:#EFF5FF;border-color:#CADBFB;color:#1E3A8A}
.tl{display:flex;flex-direction:column}
.step{display:flex;gap:14px}
.rail{display:flex;flex-direction:column;align-items:center;width:16px;flex:none}
.rail .d{width:14px;height:14px;border-radius:999px;margin-top:3px;flex:none}
.rail .ln{width:2px;flex:1;background:var(--line);margin-top:4px}
.step.ok .d{background:#16A34A;box-shadow:0 0 0 3px var(--ok-bg)}.step.ok .ln{background:#B7E4C7}
.step.warn .d{background:#D97706;box-shadow:0 0 0 3px var(--warn-bg)}
.step.bad .d{background:#DC2626;box-shadow:0 0 0 3px var(--bad-bg)}
.step.wait .d{border:2px solid #C4CBD6;background:#fff}
.step:last-child .ln{display:none}
.step .b{display:flex;flex-direction:column;gap:3px;padding-bottom:20px;flex:1;min-width:0}
.step .h{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.step .t{font-weight:600}
.step .s{font-size:13px;color:var(--dim)}.step .ref{font-size:12px;overflow-wrap:anywhere}
details.rel{border-bottom:1px solid var(--line2)}details.rel:last-child{border-bottom:0}
details.rel summary{padding:12px 20px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;list-style:none}
details.rel summary::-webkit-details-marker{display:none}
details.rel .in{padding:0 20px 14px}
pre{margin:0;background:var(--side);border:1px solid var(--line);border-radius:8px;padding:12px;font:12px/1.55 ui-monospace,monospace;overflow:auto;max-height:420px}
.check{display:flex;gap:12px;padding:11px 20px;border-bottom:1px solid var(--line2);align-items:flex-start}
.check:last-child{border-bottom:0}
.ck{width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:none}
.ck.ok{background:var(--ok-bg);color:var(--ok)}.ck.no{background:var(--bad-bg);color:var(--bad)}.ck.todo{border:2px dashed #C4CBD6;color:var(--dim)}
.progress{height:6px;border-radius:999px;background:var(--muted-bg);overflow:hidden}.progress span{display:block;height:100%;background:#16A34A}
.ava{width:44px;height:44px;border-radius:10px;background:var(--navy);color:#fff;font-weight:700;font-size:18px;display:flex;align-items:center;justify-content:center;flex:none}
body.sandbox .ava{background:var(--sbx)}
.form{display:flex;flex-direction:column;gap:14px}.form label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500}
.form input,.form select{border:1px solid var(--line);border-radius:8px;padding:0 10px;min-height:38px;font:inherit;font-weight:400;background:#fff;color:var(--text);min-width:0}
.form input:focus,.form select:focus{outline:0;border-color:var(--navy);box-shadow:0 0 0 3px var(--navy-bg)}
[hidden]{display:none!important}
.toast{position:fixed;right:20px;bottom:20px;background:var(--text);color:#fff;padding:12px 16px;border-radius:10px;font-size:13px;max-width:420px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
@media (max-width:720px){.top,.main{padding-left:16px;padding-right:16px}.sbxbar{padding:8px 16px}.kpi{border-right:0;border-bottom:1px solid var(--line)}
.side{flex:1 1 100%;max-width:none;flex-direction:row;align-items:center;gap:4px;padding:8px 16px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.side .acct{padding:4px;border:0;background:none}.side .acct-txt,.navhead,.foot,.ext{display:none}
.navgroup{flex-direction:row;gap:2px}.nav{white-space:nowrap;padding:6px 10px}}
`;

// ---------------------------------------------------------------------------
// Klijentski JS (inline; CSP nonce dodaje auth middleware)
// ---------------------------------------------------------------------------

const JS = `
(function(){
  // "/" fokusira pretragu (osim kad se već tipka u polje).
  document.addEventListener('keydown', function(e){
    if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault(); var q = document.getElementById('q'); if (q) { q.focus(); q.select(); }
  });
  // Klikabilni retci (CSP ne pušta inline onclick).
  document.addEventListener('click', function(e){
    if (e.target.closest('a,button,input,summary,label')) return;
    var tr = e.target.closest('tr[data-href]'); if (tr) window.location.href = tr.dataset.href;
  });
  // Promjena <select data-autosubmit> odmah pošalje svoju GET formu.
  document.addEventListener('change', function(e){
    var s = e.target.closest && e.target.closest('select[data-autosubmit]'); if (s && s.form) s.form.submit();
    var p = e.target.closest && e.target.closest('select[data-provider]'); if (p) syncProvider(p.form);
  });
  function syncProvider(f){
    var p = f.querySelector('[data-provider]'); if (!p) return;
    var fiat = !!p.selectedOptions[0] && p.selectedOptions[0].dataset.fiat === '1';
    var w = f.querySelector('[data-target-wrap]'), h = f.querySelector('[data-fiat-hint]'), i = f.elements.target_address;
    if (w) w.hidden = fiat; if (h) h.hidden = !fiat; if (i) i.required = !fiat;
  }
  // Novi intent: POST /admin/api/intents (isti put kao v1 modal), pa na detalj uplate.
  var INTENT_ERR = {
    target_not_whitelisted: 'Adresa nije među odobrenim primateljima tenanta (whitelist ili projekt).',
    target_not_campaign: 'Direct tenant: odredište mora biti jedan od njegovih projektnih Safeova.',
    receiving_account_without_iban: 'Tenantov Swan račun nema upisan IBAN.',
    invalid_target_address: 'Odredište nije ispravna 0x adresa.',
    invalid_amount_eur: 'Iznos nije ispravan.',
    amount_out_of_range: 'Iznos je izvan dopuštenog raspona.',
    too_many_open_intents: 'Previše otvorenih intenta na to odredište.',
    tenant_rail_not_configured: 'Tenant nema postavljen rail (Monerium webhook).',
    tenant_rail_disabled: 'Multi-tenant rail je isključen.',
    tenant_suspended: 'Tenant je suspendiran.'
  };
  document.addEventListener('submit', function(e){
    var f = e.target; if (!f.matches || !f.matches('form[data-intent-form]')) return;
    e.preventDefault();
    var err = document.getElementById('intentErr'); if (err) { err.hidden = true; err.textContent = ''; }
    var btn = f.querySelector('button[type=submit]'); var label = btn.textContent; btn.disabled = true; btn.textContent = 'Kreiram…';
    var el = f.elements, prov = el.provider ? el.provider.value : '';
    var fiat = el.provider && el.provider.selectedOptions && el.provider.selectedOptions[0] ? el.provider.selectedOptions[0].dataset.fiat === '1' : false;
    var body = {
      tenant_id: el.tenant_id.value,
      provider: prov || undefined,
      target_address: fiat ? undefined : el.target_address.value.trim(),
      amount_eur: el.amount_eur.value.trim().replace(',', '.'),
      label: el.label.value.trim() || undefined,
      expires_in_seconds: Number(el.expires_in_seconds.value) || 900
    };
    fetch('/admin/api/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function(res){
        if (res.ok && res.j.sid) { location.href = '/admin/v2/payments/' + encodeURIComponent(res.j.sid); return; }
        btn.disabled = false; btn.textContent = label;
        var code = res.j.error || ('HTTP ' + res.status);
        if (err) { err.textContent = (INTENT_ERR[code] || 'Greška') + ' (' + code + ')'; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
      })
      .catch(function(x){ btn.disabled = false; btn.textContent = label; if (err) { err.textContent = 'Mreža: ' + x.message; err.hidden = false; } });
  });
  // Ljudski tekst za česte kodove /admin/api/tenants/* (kod ostaje u zagradi).
  var API_ERR = {
    suspend_first: 'Prvo suspendiraj tenanta.',
    rail_not_verified: 'Rail nije verificiran — pokreni provjeru.',
    tenant_exists: 'Tenant s tim ID-om već postoji.',
    reserved_tenant_id: 'Prefiks sbx- je rezerviran za sandbox.',
    invalid_tenant_id: 'ID: mala slova, brojke i crtica.',
    invalid_iban: 'IBAN nije ispravan.',
    profile_in_use: 'Taj Monerium profil već koristi drugi tenant.',
    campaign_owned_by_other_tenant: 'Taj projekt pripada drugom tenantu.',
    not_found_or_already_revoked: 'Već je opozvano.',
    router_exists: 'Router ključ već postoji.',
    sandbox_tenant_has_no_rail: 'Sandbox tenant nema rail.',
    account_already_registered: 'Taj račun je već upisan.'
  };
  function errText(res){ var c = res.j.error || res.j.result || ''; return (API_ERR[c] ? API_ERR[c] + ' ' : 'Greška ' + res.status + ': ') + '(' + c + ')' + (res.j.detail ? ' ' + res.j.detail : ''); }
  function arm(b){
    if (!b || !b.dataset.confirm || b.hasAttribute('data-armed')) return false;
    b.dataset.label = b.textContent; b.setAttribute('data-armed',''); b.textContent = b.dataset.confirm;
    setTimeout(function(){ if (b.hasAttribute('data-armed')) { b.removeAttribute('data-armed'); b.textContent = b.dataset.label; } }, 4000);
    return true;
  }
  // <form data-api="/admin/api/…" data-method="PUT">: polja kao JSON. Gumb s
  // data-confirm traži drugi klik. data-redirect="/…/{tenant_id}" ide na
  // stranicu iz odgovora, data-show="key" prikaže vrijednost jednom (ne reload).
  document.addEventListener('submit', function(e){
    var f = e.target; if (!f.matches || !f.matches('form[data-api]')) return;
    e.preventDefault();
    var sb = e.submitter || f.querySelector('button[type=submit]');
    if (arm(sb)) return;
    var o = {}; new FormData(f).forEach(function(v, k){ o[k] = typeof v === 'string' ? v.trim() : v; });
    var label = (sb && (sb.dataset.label || sb.textContent)) || ''; if (sb) { sb.removeAttribute('data-armed'); sb.disabled = true; sb.textContent = '…'; }
    fetch(f.dataset.api, { method: f.dataset.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function(res){
        if (sb) { sb.disabled = false; sb.textContent = label; }
        if (!res.ok) { toast(errText(res)); return; }
        if (f.dataset.show) {
          var out = f.querySelector('[data-out]'); if (!out) return;
          out.textContent = ''; var st = document.createElement('strong'); st.textContent = 'Spremi odmah — više se ne može pročitati: ';
          var code = document.createElement('code'); code.className = 'mono'; code.style.userSelect = 'all'; code.textContent = String(res.j[f.dataset.show] || '');
          out.appendChild(st); out.appendChild(code); out.hidden = false; f.reset(); return;
        }
        if (f.dataset.redirect) { location.href = f.dataset.redirect.replace(/\\{(\\w+)\\}/g, function(_, k){ return encodeURIComponent(res.j[k] || ''); }); return; }
        toast(f.dataset.done || 'Spremljeno.'); setTimeout(function(){ location.reload(); }, 1000);
      })
      .catch(function(x){ if (sb) { sb.disabled = false; sb.textContent = label; } toast('Mreža: ' + x.message); });
  });
  // <form data-check="/admin/api/tenants/x/check/">: GET + adresa, rezultat u [data-out].
  document.addEventListener('submit', function(e){
    var f = e.target; if (!f.matches || !f.matches('form[data-check]')) return;
    e.preventDefault();
    var out = f.querySelector('[data-out]'); var a = f.elements.address.value.trim();
    fetch(f.dataset.check + encodeURIComponent(a), { headers: { accept: 'application/json' } })
      .then(function(r){ return r.json(); })
      .then(function(j){ if (!out) return; out.textContent = j.error ? ('Greška: ' + j.error) : (j.allowed ? '✓ Prolazi (izvor: ' + j.source + ')' : '✕ Ne prolazi — nije na whitelisti ni u drugom izvoru.'); out.style.color = j.allowed ? 'var(--ok)' : 'var(--bad)'; })
      .catch(function(x){ if (out) out.textContent = 'Mreža: ' + x.message; });
  });
  function toast(msg){ var d=document.createElement('div'); d.className='toast'; d.textContent=msg; document.body.appendChild(d); setTimeout(function(){d.remove();}, 6000); }
  // Akcije: <button data-post="/admin/api/..." data-confirm="Tekst">. Prvi klik
  // naoruža gumb (bez blokirajućih confirm() dijaloga), drugi u 4 s izvrši.
  document.addEventListener('click', function(e){
    var b = e.target.closest('button[data-post]'); if (!b) return;
    e.preventDefault();
    // data-reason="<id inputa>": pisani razlog (min. 10 znakova) → force + reason (SR-02, OF-02).
    var body = b.dataset.body || '{}';
    if (b.dataset.reason) {
      var inp = document.getElementById(b.dataset.reason); var why = inp ? inp.value.trim() : '';
      if (why.length < 10) { toast('Upiši razlog (najmanje 10 znakova).'); if (inp) inp.focus(); return; }
      var o = JSON.parse(body); o.force = true; o.reason = why; body = JSON.stringify(o);
    }
    if (b.dataset.confirm && !b.hasAttribute('data-armed')) {
      b.dataset.label = b.textContent; b.setAttribute('data-armed',''); b.textContent = b.dataset.confirm;
      setTimeout(function(){ if (b.hasAttribute('data-armed')) { b.removeAttribute('data-armed'); b.textContent = b.dataset.label; } }, 4000);
      return;
    }
    b.removeAttribute('data-armed'); b.disabled = true; var label = b.dataset.label || b.textContent; b.textContent = '…';
    fetch(b.dataset.post, { method: b.dataset.method || 'POST', headers: { 'content-type': 'application/json' }, body: body })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function(res){
        b.disabled = false; b.textContent = label;
        if (!res.ok) { toast(errText(res)); return; }
        if (b.dataset.render === 'verify' && res.j.checks) {
          var box = document.getElementById('verifyOut');
          if (box) { box.innerHTML = ''; res.j.checks.forEach(function(c){ var row=document.createElement('div'); row.className='check';
            var ck=document.createElement('span'); ck.className='ck ' + (c.ok?'ok':'no'); ck.textContent = c.ok ? '✓' : '✕';
            var tx=document.createElement('span'); tx.className='two'; var k=document.createElement('strong'); k.textContent=c.key; var d=document.createElement('span'); d.className='mono dim'; d.textContent=c.detail;
            tx.appendChild(k); tx.appendChild(d); row.appendChild(ck); row.appendChild(tx); box.appendChild(row); }); }
          toast(res.j.ok ? 'Provjera prošla.' : 'Provjera našla probleme.'); return;
        }
        toast(b.dataset.done || 'Gotovo.'); setTimeout(function(){ location.reload(); }, 1200);
      })
      .catch(function(err){ b.disabled = false; b.textContent = label; toast('Mreža: ' + err.message); });
  });
})();
`;
