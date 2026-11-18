// Admin v2 — stranice. Svaka prima već učitane podatke (routes.tsx) i vraća
// sadržaj za <Layout>; nema upita u renderu, pa se stranice testiraju bez baze.

import type { Child, FC } from 'hono/jsx';

import type { AttentionItem, Overview, ParkedForward, PaymentBundle, PaymentFilter, PaymentListRow, PayStatus, SearchHit } from './data';
import { PAY_STATUSES } from './data';
import type { Scope } from './scope';
import {
  ago, Empty, explorerAddr, explorerTx, fmtAmountStr, fmtDate, fmtDateSec, fmtEur, fmtIso, FwdPill, Mono,
  PAY_LABEL, PayPill, Pill, short,
} from './ui';

const tenantLabel = (scope: Scope, id: string | null) => {
  const t = scope.byId(id);
  return t?.name ?? t?.id ?? id ?? scope.defaultId;
};

const qs = (base: Record<string, string | number | undefined | null>, over: Record<string, string | number | undefined | null> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const channel = (r: { provider: string | null; settled_provider?: string | null; target_address: string }) => {
  const p = r.settled_provider ?? r.provider ?? 'monerium';
  if (p === 'swan') return 'Swan · fiat';
  if (p === 'sandbox') return 'Simulirano';
  return `Monerium → ${short(r.target_address, 6, 4)}`;
};

// ---------------------------------------------------------------------------
// Pregled
// ---------------------------------------------------------------------------

export const HomePage: FC<{ scope: Scope; ov: Overview; attention: AttentionItem[]; recent: PaymentListRow[] }> = ({ scope, ov, attention, recent }) => {
  const max = Math.max(1, ...ov.series.map((s) => s.cents));
  const delta = ov.prevVolumeCents > 0 ? Math.round(((ov.volumeCents - ov.prevVolumeCents) / ov.prevVolumeCents) * 100) : null;
  const ranges: Array<[number, string]> = [[1, 'Danas'], [7, '7 dana'], [30, '30 dana'], [90, '90 dana']];
  const first = ov.series[0]?.day ?? '';
  const mid = ov.series[Math.floor(ov.series.length / 2)]?.day ?? '';
  const last = ov.series[ov.series.length - 1]?.day ?? '';
  const d = (iso: string) => (iso ? `${Number(iso.slice(8, 10))}. ${Number(iso.slice(5, 7))}.` : '');
  return (
    <>
      <div class="row">
        <h1>Pregled</h1>
        <div class="chips" role="group" aria-label="Razdoblje">
          {ranges.map(([n, l]) => <a class={n === ov.days ? 'chip on' : 'chip'} href={`/admin/v2?days=${n}`}>{l}</a>)}
        </div>
      </div>
      <section class="kpis" aria-label="Ključne brojke">
        <div class="kpi"><span class="l">Bruto promet</span><span class="v">{fmtEur(ov.volumeCents)}</span>
          <span class="s">{delta === null ? 'nema usporedbe' : `${delta >= 0 ? '+' : ''}${delta} % vs. prethodno razdoblje`}</span></div>
        <div class="kpi"><span class="l">Plaćene uplate</span><span class="v">{ov.paid}</span><span class="s">od {ov.created} intenata u razdoblju</span></div>
        <div class="kpi"><span class="l">Na čekanju sada</span><span class="v">{ov.pendingNow}</span><span class="s">otvoreni, neistekli intenti</span></div>
        <div class="kpi"><span class="l">Traži akciju</span><span class="v">{attention.length}</span><span class="s">{attention.length ? 'vidi popis desno' : 'sve je u redu'}</span></div>
      </section>
      <div class="cols">
        <section class="card" style="flex:3 1 520px">
          <div class="card-h"><h2>Promet (plaćeno)</h2><span class="dim small">po danu · UTC · EUR</span></div>
          <div class="card-b">
            {ov.days === 1 ? (
              <div class="empty">Za jedan dan nema grafa — {ov.paid} uplata, {fmtEur(ov.volumeCents)}.</div>
            ) : (
              <>
                <div class="chart" role="img" aria-label={`Promet po danu, zadnjih ${ov.days} dana`}>
                  {ov.series.map((s) => (
                    <div class="bar" title={`${d(s.day)} · ${fmtEur(s.cents)} · ${s.count} uplata`}>
                      <span class={s.cents ? '' : 'zero'} style={`height:${s.cents ? Math.max(3, (s.cents / max) * 100) : 1}%`} />
                    </div>
                  ))}
                </div>
                <div class="axis"><span>{d(first)}</span><span>{d(mid)}</span><span>{d(last)}</span></div>
              </>
            )}
          </div>
        </section>
        <section class="card attn" style="flex:2 1 360px">
          <div class="card-h"><h2>Traži tvoju akciju</h2>{attention.length ? <Pill tone="bad">{attention.length}</Pill> : <Pill tone="ok">0</Pill>}</div>
          {attention.length ? attention.map((a) => (
            <a href={a.href}>
              <span class={`dot ${a.severity}`} />
              <span class="two" style="flex:1"><strong>{a.title}</strong><span class="dim small">{a.sub} · {ago(a.at)}</span></span>
              <span class="cta">{a.cta} →</span>
            </a>
          )) : <Empty>Sve je u redu. Nema zapelih forwarda, palih isporuka ni neuparenih priljeva.</Empty>}
        </section>
      </div>
      <section class="card">
        <div class="card-h"><h2>Zadnje uplate</h2><a href="/admin/v2/payments" class="small">Sve uplate →</a></div>
        <PaymentsTable scope={scope} rows={recent} compact />
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Uplate
// ---------------------------------------------------------------------------

const PaymentsTable: FC<{ scope: Scope; rows: PaymentListRow[]; compact?: boolean }> = ({ scope, rows, compact }) =>
  rows.length ? (
    <div class="tbl">
      <table>
        <thead><tr><th>Iznos</th><th>Status</th><th>Opis</th>{compact ? null : <th>Kanal</th>}<th>Tenant</th><th class="r">Stvoreno</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const href = `/admin/v2/payments/${encodeURIComponent(r.sid)}`;
            const received = r.amount_received_cents != null && r.amount_received_cents !== r.amount_cents;
            return (
              <tr class="click" data-href={href}>
                <td><a class="amt" href={href}>{fmtEur(r.amount_cents)}</a>{received ? <div class="dim small">primljeno {fmtEur(r.amount_received_cents)}</div> : null}</td>
                <td><PayPill status={r.v2_status} /></td>
                <td><span class="two"><span>{r.label ?? '—'}</span><Mono>{r.sid}{r.short_ref ? ` · ${r.short_ref}` : ''}</Mono></span></td>
                {compact ? null : <td class="small">{channel(r)}</td>}
                <td class="dim">{tenantLabel(scope, r.tenant_id)}</td>
                <td class="r dim" style="white-space:nowrap">{fmtDate(r.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : <Empty>Nema uplata za ovaj filter.</Empty>;

export const PaymentsPage: FC<{
  scope: Scope; f: PaymentFilter; items: PaymentListRow[]; total: number; counts: Record<PayStatus | 'all', number>;
}> = ({ scope, f, items, total, counts }) => {
  const base = { tenant: f.tenant, provider: f.provider, q: f.q, target: f.target, status: f.status };
  const limit = f.limit ?? 25;
  const offset = f.offset ?? 0;
  const tabs: Array<[PayStatus | undefined, string, number]> = [[undefined, 'Sve', counts.all], ...PAY_STATUSES.map((s) => [s, PAY_LABEL[s], counts[s]] as [PayStatus, string, number])];
  const providers: Array<[string | undefined, string]> = [[undefined, 'Svi kanali'], ['monerium', 'Monerium'], ['swan', 'Swan']];
  return (
    <>
      <div class="row"><h1>Uplate</h1><a class="btn" href={`/admin/v2/payments.csv${qs(base)}`}>Izvezi CSV</a></div>
      <div class="tabs" role="tablist" aria-label="Status">
        {tabs.map(([s, l, c]) => (
          <a role="tab" aria-selected={f.status === s ? 'true' : 'false'} class={f.status === s ? 'tab on' : 'tab'} href={`/admin/v2/payments${qs(base, { status: s, offset: undefined })}`}>
            <span class="l">{l}</span><span class="c">{c}</span>
          </a>
        ))}
      </div>
      <form class="chips" method="get" action="/admin/v2/payments">
        {f.status ? <input type="hidden" name="status" value={f.status} /> : null}
        <label class="sr" for="ftenant">Tenant</label>
        <select id="ftenant" name="tenant" class="chip">
          <option value="">Svi tenanti</option>
          {scope.tenants.map((t) => <option value={t.id} selected={f.tenant === t.id}>{t.name ? `${t.name} (${t.id})` : t.id}</option>)}
        </select>
        <label class="sr" for="fprov">Kanal</label>
        <select id="fprov" name="provider" class="chip">
          {providers.map(([v, l]) => <option value={v ?? ''} selected={f.provider === v}>{l}</option>)}
        </select>
        <label class="sr" for="fq">Opis ili SID</label>
        <input id="fq" name="q" class="chip" value={f.q ?? ''} placeholder="opis ili SID" />
        {f.target ? <input type="hidden" name="target" value={f.target} /> : null}
        <button class="btn" type="submit">Primijeni</button>
        {f.target ? <a class="chip on" href={`/admin/v2/payments${qs(base, { target: undefined })}`}>Odredište {short(f.target)} ×</a> : null}
        {(f.tenant || f.provider || f.q) ? <a class="small" href={`/admin/v2/payments${qs({ status: f.status })}`}>Očisti filtere</a> : null}
      </form>
      <section class="card">
        <PaymentsTable scope={scope} rows={items} />
        <div class="pager">
          <span>{total ? `${offset + 1}–${Math.min(offset + limit, total)} od ${total}` : '0 rezultata'}</span>
          <span class="chips">
            {offset > 0 ? <a class="btn" href={`/admin/v2/payments${qs(base, { offset: Math.max(0, offset - limit) })}`}>Prethodna</a> : <span class="btn" aria-disabled="true">Prethodna</span>}
            {offset + limit < total ? <a class="btn" href={`/admin/v2/payments${qs(base, { offset: offset + limit })}`}>Sljedeća</a> : <span class="btn" aria-disabled="true">Sljedeća</span>}
          </span>
        </div>
      </section>
      <p class="dim small" style="margin:0">Jedan red = jedan payment intent. Monerium order, webhook eventi, forward i isporuke vide se u detalju uplate.</p>
    </>
  );
};

// ---------------------------------------------------------------------------
// Detalj uplate
// ---------------------------------------------------------------------------

type StepTone = 'ok' | 'warn' | 'bad' | 'wait';
interface Step { tone: StepTone; title: string; sub: Child; ref?: Child; at?: string }

function buildSteps(b: PaymentBundle, chain: string | null): Step[] {
  const i = b.intent;
  const steps: Step[] = [];
  steps.push({
    tone: 'ok',
    title: 'Intent kreiran',
    sub: `${i.created_with_key ? 'tajnim ključem / adminom' : 'javnim ključem'} · istječe ${fmtDate(i.expires_at)}`,
    ref: <Mono>{i.sid}{i.short_ref ? ` · kratka ref. ${i.short_ref}` : ''}</Mono>,
    at: fmtDateSec(i.created_at),
  });
  const provider = b.settlement?.provider ?? i.provider ?? 'monerium';
  const credit = b.credits[b.credits.length - 1];
  if (b.order || credit || b.settlement) {
    const who = b.order?.counterpart_name ?? credit?.debtor_name ?? null;
    const iban = b.order?.counterpart_iban ?? credit?.debtor_account ?? null;
    const rejected = b.order?.state === 'rejected';
    steps.push({
      tone: rejected ? 'bad' : 'ok',
      title: rejected ? 'Uplata odbijena' : provider === 'swan' ? 'Uplata stigla na Swan račun' : provider === 'sandbox' ? 'Simulirana uplata' : 'SEPA uplata primljena (Monerium)',
      sub: [b.order ? `order ${b.order.state}` : credit ? `${credit.provider} · ${credit.finality}` : provider, who ? `uplatitelj ${who}` : null, iban].filter(Boolean).join(' · '),
      ref: b.order ? <a href={`/admin/orders/${encodeURIComponent(b.order.id)}`}><Mono>order {short(b.order.id, 10, 6)}</Mono></a> : credit ? <Mono>{credit.provider_ref}</Mono> : <Mono>{b.settlement?.settlement_ref}</Mono>,
      at: b.order ? fmtIso(b.order.processed_at ?? b.order.placed_at) : credit ? fmtDateSec(credit.occurred_at) : fmtDateSec(b.settlement?.created_at),
    });
  } else {
    steps.push({ tone: i.v2_status === 'expired' ? 'bad' : 'wait', title: i.v2_status === 'expired' ? 'Uplata nije stigla' : 'Čeka uplatu', sub: i.v2_status === 'expired' ? `intent istekao ${fmtDate(i.expires_at)}` : 'banka → Monerium/Swan još ništa nije javio (noge 1–3 su slijepe)' });
  }
  if (b.events.length) {
    const bad = b.events.filter((e) => !e.signature_ok).length;
    const lastEv = b.events[b.events.length - 1];
    steps.push({
      tone: bad === b.events.length ? 'bad' : 'ok',
      title: 'Webhook primljen',
      sub: `${b.events.map((e) => e.event_type).filter((v, k, a) => a.indexOf(v) === k).join(', ')} · ${b.events.length} ${b.events.length === 1 ? 'event' : 'eventa'}${bad ? ` · ${bad} s lošim potpisom` : ' · potpis OK'}`,
      ref: <span class="mono">{b.events.map((e) => <><a href={`/admin/v2/developers/events/${e.id}`}>#{e.id}</a>{' '}</>)}</span>,
      at: fmtDateSec(lastEv.received_at),
    });
  }
  const fwd = b.forwards[b.forwards.length - 1];
  if (fwd) {
    const tone: StepTone = fwd.status === 'confirmed' || fwd.status === 'resolved_offrail' ? 'ok' : fwd.status === 'blocked' ? 'warn' : fwd.status === 'failed' ? 'bad' : 'wait';
    steps.push({
      tone,
      title: fwd.status === 'confirmed' ? 'Proslijeđeno na odredište' : fwd.status === 'blocked' ? 'Forward blokiran' : fwd.status === 'failed' ? 'Forward neuspio' : fwd.status === 'resolved_offrail' ? 'Riješeno ručno (izvan raila)' : 'Forward u letu',
      sub: <>{fmtEur(fwd.amount_cents)} → <a href={explorerAddr(chain, fwd.target_address)} target="_blank" rel="noopener"><Mono>{short(fwd.target_address, 8, 6)}</Mono></a>{fwd.error ? ` · ${fwd.error}` : ''}{b.forwards.length > 1 ? ` · ${b.forwards.length} pokušaja` : ''}</>,
      ref: fwd.tx_hash ? <a href={explorerTx(chain, fwd.tx_hash)} target="_blank" rel="noopener"><Mono>tx {short(fwd.tx_hash, 10, 6)} ↗</Mono></a> : <Mono>forward #{fwd.id}</Mono>,
      at: fmtDateSec(fwd.updated_at),
    });
  } else if (i.state === 'paid' && provider !== 'swan' && provider !== 'sandbox') {
    steps.push({ tone: 'ok', title: 'Mint izravno na odredište', sub: 'direct mode — nema forwarda iz MPT Safea', ref: i.forward_tx_hash ? <a href={explorerTx(chain, i.forward_tx_hash)} target="_blank" rel="noopener"><Mono>tx {short(i.forward_tx_hash, 10, 6)} ↗</Mono></a> : undefined });
  }
  steps.push(i.state === 'paid'
    ? { tone: 'ok', title: 'Plaćeno', sub: `intent zatvoren${i.amount_received_cents != null ? ` · primljeno ${fmtEur(i.amount_received_cents)}` : ''}`, at: fmtDateSec(i.paid_at) }
    : { tone: 'wait', title: 'Plaćeno', sub: 'intent se zatvara tek kad je novac potvrđen na odredištu' });
  for (const o of b.outbox) {
    steps.push({
      tone: o.status === 'delivered' ? 'ok' : o.status === 'failed' ? 'bad' : 'wait',
      title: `Merchant obaviješten: ${o.type}`,
      sub: `${o.status}${o.last_status ? ` · HTTP ${o.last_status}` : ''} · ${o.attempts} ${o.attempts === 1 ? 'pokušaj' : 'pokušaja'}${o.last_error ? ` · ${o.last_error.slice(0, 80)}` : ''}`,
      ref: <Mono>{o.id}</Mono>,
      at: fmtDateSec(o.delivered_at ?? o.created_at),
    });
  }
  return steps;
}

export const PaymentDetailPage: FC<{ scope: Scope; b: PaymentBundle }> = ({ scope, b }) => {
  const i = b.intent;
  const t = scope.byId(i.tenant_id);
  const chain = t?.chain ?? 'gnosis';
  const steps = buildSteps(b, chain);
  const fwd = b.forwards[b.forwards.length - 1];
  const parked = fwd && (fwd.status === 'failed' || fwd.status === 'blocked');
  let meta: string | null = null;
  try { meta = i.metadata_json ? JSON.stringify(JSON.parse(i.metadata_json), null, 2) : null; } catch { meta = i.metadata_json; }
  return (
    <>
      <a href="/admin/v2/payments" class="small">← Uplate</a>
      <div class="row" style="align-items:flex-start;padding-bottom:20px;border-bottom:1px solid var(--line)">
        <div class="two" style="gap:8px">
          <span class="dim small">Uplata · {tenantLabel(scope, i.tenant_id)}{i.label ? ` · ${i.label}` : ''}</span>
          <span style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <span style="font-size:32px;font-weight:700" class="num">{fmtEur(i.amount_cents)}</span>
            <PayPill status={i.v2_status} />
          </span>
          <Mono>{i.sid}{i.short_ref ? ` · kratka ref. ${i.short_ref}` : ''}</Mono>
        </div>
        <div class="chips">
          {fwd?.status === 'failed' ? <button class="btn primary" data-post={`/admin/api/forwards/${fwd.id}/retry`} data-confirm="Potvrdi ponovni broadcast" data-done="Forward ponovno pokrenut.">Pokušaj ponovno</button> : null}
          {parked ? <a class="btn" href={`/admin/forwards?status=${fwd.status}`}>Preusmjeri / riješi ručno (v1)</a> : null}
          <a class="btn" href={`/admin/intents?sid=${encodeURIComponent(i.sid)}`}>Otvori u v1</a>
        </div>
      </div>
      {parked ? (
        <div class="callout warn" role="status">
          <strong>Novac je u MPT Safeu, ali nije proslijeđen.</strong>
          <span>{fwd.status === 'blocked' ? 'Odredište nije u odobrenom skupu tenanta (whitelist / projekti). Dodaj projekt ili preusmjeri na postojeći intent.' : `Broadcast nije uspio: ${fwd.error ?? 'nepoznata greška'}. „Pokušaj ponovno” ide istim putem kao webhook.`}</span>
        </div>
      ) : null}
      <div class="cols">
        <section style="flex:3 1 520px;min-width:0;display:flex;flex-direction:column;gap:12px">
          <h2 style="font-size:16px">Gdje je novac</h2>
          <div class="tl">
            {steps.map((s) => (
              <div class={`step ${s.tone}`}>
                <div class="rail"><span class="d" /><span class="ln" /></div>
                <div class="b">
                  <div class="h"><span class="t">{s.title}</span><span class="dim small">{s.at ?? ''}</span></div>
                  <span class="s">{s.sub}</span>
                  {s.ref ? <span class="ref">{s.ref}</span> : null}
                </div>
              </div>
            ))}
          </div>
          <h2 style="font-size:16px;margin-top:8px">Povezani zapisi</h2>
          <div class="card">
            {b.order ? (
              <details class="rel"><summary><span><strong>Monerium order</strong> <span class="dim">· {b.order.kind} · {b.order.state} · {fmtAmountStr(b.order.amount)}</span></span><Mono>{short(b.order.id, 10, 6)}</Mono></summary>
                <div class="in"><dl class="kv">
                  <dt>Uplatitelj</dt><dd>{b.order.counterpart_name ?? '—'} · <Mono>{b.order.counterpart_iban ?? '—'}</Mono></dd>
                  <dt>Memo</dt><dd><Mono>{b.order.memo ?? '—'}</Mono></dd>
                  <dt>Placed / processed</dt><dd>{fmtIso(b.order.placed_at)} · {fmtIso(b.order.processed_at)}</dd>
                </dl><p class="small"><a href={`/admin/orders/${encodeURIComponent(b.order.id)}`}>Sirovi JSON (v1) →</a></p></div>
              </details>
            ) : null}
            {b.events.map((e) => (
              <details class="rel"><summary><span><strong>Webhook event</strong> <span class="dim">· {e.event_type} · {e.signature_ok ? 'potpis OK' : 'potpis ✕'}</span></span><a href={`/admin/v2/developers/events/${e.id}`} class="mono">#{e.id}</a></summary>
                <div class="in dim small">{fmtDateSec(e.received_at)}{e.processing_note ? ` · ${e.processing_note}` : ''}</div>
              </details>
            ))}
            {b.forwards.map((f) => (
              <details class="rel"><summary><span><strong>Safe forward</strong> <span class="dim">· </span><FwdPill status={f.status} /></span><Mono>#{f.id}</Mono></summary>
                <div class="in"><dl class="kv">
                  <dt>Odredište</dt><dd><Mono>{f.target_address}</Mono></dd>
                  <dt>Iznos</dt><dd>{fmtEur(f.amount_cents)}</dd>
                  <dt>TX</dt><dd>{f.tx_hash ? <a href={explorerTx(chain, f.tx_hash)} target="_blank" rel="noopener"><Mono>{f.tx_hash}</Mono></a> : '—'}</dd>
                  <dt>Greška</dt><dd>{f.error ?? '—'}</dd>
                  <dt>Pokušaji</dt><dd>{f.attempts} · {f.memo_prefix ?? '—'} · ažurirano {fmtDateSec(f.updated_at)}</dd>
                </dl></div>
              </details>
            ))}
            {b.credits.map((c) => (
              <details class="rel"><summary><span><strong>Priljev (inbox)</strong> <span class="dim">· {c.provider} · {c.finality} · {fmtEur(c.amount_cents)}</span></span><Mono>#{c.id}</Mono></summary>
                <div class="in dim small">upareno: {c.matched_by ?? '—'}{c.match_note ? ` · ${c.match_note}` : ''}</div>
              </details>
            ))}
            {b.outbox.map((o) => (
              <details class="rel"><summary><span><strong>Odlazni webhook</strong> <span class="dim">· {o.type} · {o.status}</span></span><Mono>{o.id}</Mono></summary>
                <div class="in"><button class="btn" data-post={`/admin/api/outbox/${encodeURIComponent(o.id)}/resend`} data-confirm="Potvrdi slanje" data-done="Webhook poslan ponovno.">Pošalji ponovno</button></div>
              </details>
            ))}
            {!b.order && !b.events.length && !b.forwards.length && !b.credits.length && !b.outbox.length ? <Empty>Još nema povezanih zapisa.</Empty> : null}
          </div>
        </section>
        <aside style="flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:20px">
          <section class="card">
            <div class="card-h"><h2>Detalji</h2></div>
            <div class="card-b"><dl class="kv">
              <dt>Tenant</dt><dd><a href={`/admin/v2/tenants/${encodeURIComponent(t?.id ?? scope.defaultId)}`}>{tenantLabel(scope, i.tenant_id)}</a></dd>
              <dt>Okruženje</dt><dd>{t?.sandbox ? 'Sandbox' : 'Produkcija'} · {chain}</dd>
              <dt>Kanal</dt><dd>{channel(i)}</dd>
              <dt>Odredište</dt><dd><a href={explorerAddr(chain, i.target_address)} target="_blank" rel="noopener"><Mono>{short(i.target_address, 8, 6)}</Mono></a> · <a href={`/admin/v2/payments?target=${i.target_address}`}>sve uplate</a></dd>
              <dt>Traženo</dt><dd>{fmtEur(i.amount_cents)}</dd>
              <dt>Primljeno</dt><dd>{fmtEur(i.amount_received_cents)}</dd>
              <dt>Stvoreno</dt><dd>{fmtDateSec(i.created_at)}</dd>
              <dt>Istječe</dt><dd>{fmtDateSec(i.expires_at)}</dd>
              <dt>Plaćeno</dt><dd>{fmtDateSec(i.paid_at)}</dd>
              {i.return_url ? <><dt>Povratni URL</dt><dd><Mono>{i.return_url}</Mono></dd></> : null}
            </dl></div>
          </section>
          {meta ? <section class="card"><div class="card-h"><h2>Metadata</h2></div><div class="card-b"><pre>{meta}</pre></div></section> : null}
        </aside>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Isplate
// ---------------------------------------------------------------------------

export const PayoutsPage: FC<{ scope: Scope; status?: string; items: Array<ParkedForward & { tx_hash: string | null; created_at: number; memo_prefix: string | null }>; total: number; parked: ParkedForward[] }> = ({ scope, status, items, total, parked }) => {
  const statuses: Array<[string | undefined, string]> = [[undefined, 'Sve'], ['confirmed', 'Potvrđeno'], ['submitted', 'Poslano'], ['failed', 'Neuspjelo'], ['blocked', 'Blokirano'], ['resolved_offrail', 'Ručno']];
  const parkedIds = new Set(parked.map((p) => p.id));
  return (
    <>
      <div class="row"><h1>Isplate</h1><span class="dim small">EURe forward iz MPT Safea na odredište (ProjectRouter)</span></div>
      {parked.length ? <div class="callout warn"><strong>{parked.length} zapelo</strong><span>Zadnji forward za order je neuspio ili blokiran i nema novijeg. <a href={`/admin/v2/payouts?status=${parked[0].status}`}>Prikaži</a></span></div> : null}
      <div class="chips">{statuses.map(([s, l]) => <a class={status === s ? 'chip on' : 'chip'} href={`/admin/v2/payouts${qs({ status: s })}`}>{l}</a>)}</div>
      <section class="card">
        {items.length ? (
          <div class="tbl"><table>
            <thead><tr><th>Iznos</th><th>Status</th><th>Odredište</th><th>Uplata</th><th>Tenant</th><th>TX</th><th class="r">Ažurirano</th></tr></thead>
            <tbody>{items.map((f) => {
              const chain = scope.byId(f.tenant_id)?.chain;
              return (
                <tr class={f.sid ? 'click' : ''} data-href={f.sid ? `/admin/v2/payments/${encodeURIComponent(f.sid)}` : undefined}>
                  <td class="amt">{fmtEur(f.amount_cents)}</td>
                  <td><span class="two"><FwdPill status={f.status} />{parkedIds.has(f.id) ? <span class="small" style="color:var(--warn)">zapelo</span> : null}</span></td>
                  <td><span class="two"><Mono>{short(f.target_address, 8, 6)}</Mono>{f.error ? <span class="small dim">{f.error.slice(0, 80)}</span> : null}</span></td>
                  <td>{f.sid ? <a class="mono" href={`/admin/v2/payments/${encodeURIComponent(f.sid)}`}>{f.sid}</a> : <span class="dim small">bez reference · {short(f.order_id, 8, 4)}</span>}</td>
                  <td class="dim">{tenantLabel(scope, f.tenant_id)}</td>
                  <td>{f.tx_hash ? <a href={explorerTx(chain, f.tx_hash)} target="_blank" rel="noopener" class="mono">{short(f.tx_hash, 8, 4)} ↗</a> : '—'}</td>
                  <td class="r dim" style="white-space:nowrap">{fmtDate(f.updated_at)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <Empty>Nema isplata.</Empty>}
        <div class="pager"><span>{items.length} od {total}</span></div>
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Tenanti
// ---------------------------------------------------------------------------

export const TenantsPage: FC<{ scope: Scope; stats: Map<string, { vol: number; paid: number; last_intent: number | null }> }> = ({ scope, stats }) => (
  <>
    <div class="row"><h1>Tenanti</h1><a class="btn" href="/admin/tenants">+ Novi tenant (v1)</a></div>
    <section class="card">
      {scope.tenants.length ? (
        <div class="tbl"><table>
          <thead><tr><th>Tenant</th><th>Status</th><th>Rail</th><th class="r">Promet 30 d</th><th class="r">Uplate 30 d</th><th class="r">Zadnji intent</th></tr></thead>
          <tbody>{scope.tenants.map((t) => {
            const s = stats.get(t.id);
            const href = `/admin/v2/tenants/${encodeURIComponent(t.id)}`;
            return (
              <tr class="click" data-href={href}>
                <td><span class="two"><a href={href} style="color:var(--text);font-weight:600">{t.name ?? t.id}</a><Mono>{t.id}</Mono></span></td>
                <td>{t.status === 'active' ? <Pill tone="ok">Aktivan</Pill> : t.status === 'onboarding' ? <Pill tone="info">Onboarding</Pill> : t.status ? <Pill tone="muted">{t.status === 'suspended' ? 'Suspendiran' : t.status}</Pill> : <Pill tone="muted">bez tenant reda</Pill>}</td>
                <td class="small">{t.monerium_env ? `Monerium ${t.monerium_env} · ${t.chain ?? 'gnosis'}` : t.sandbox ? 'simulirano (ADR 0024)' : '—'}</td>
                <td class="r amt">{fmtEur(s?.vol ?? 0)}</td>
                <td class="r num">{s?.paid ?? 0}</td>
                <td class="r dim">{s?.last_intent ? ago(s.last_intent) : '—'}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty>Nema tenanata u ovom okruženju.</Empty>}
    </section>
  </>
);

export interface TenantDetailData {
  tenant: { id: string; name: string; status: string; iban: string; bic: string | null; beneficiary_name: string; sandbox: number; created_at: number } | null;
  rail: {
    monerium_env: string; chain: string; client_id: string; client_secret_enc: string | null; profile_id: string; receiving_safe: string;
    roles_modifier: string | null; role_key: string | null; router_address: string | null; router_key_enc: string | null;
    webhook_secret_enc: string | null; webhook_subscription_id: string | null; outbound_webhook_url: string | null;
    outbound_webhook_secret_enc: string | null; mode: string | null; verified_at: number | null; verify_report: string | null;
  } | null;
  sandboxRow: { outbound_webhook_url: string | null; expires_at: number | null } | null;
  campaigns: Array<{ campaign_id: string; safe_address: string; label: string | null; created_at: number; revoked_at: number | null }>;
  addressCount: number;
  accounts: Array<{ id: number; provider: string; mode: string; iban: string | null; environment: string; external_account_id: string | null; label: string | null; active: number; created_at: number }>;
  keys: Array<{ key_hash: string; kind: string; label: string | null; created_at: number; revoked_at: number | null }>;
}

export const TenantDetailPage: FC<{ scope: Scope; id: string; d: TenantDetailData; recent: PaymentListRow[]; stats?: { vol: number; paid: number }; audit: Array<{ id: number; at: number; action: string; actor: string; address: string | null }> }> = ({ scope, id, d, recent, stats, audit }) => {
  const { tenant, rail } = d;
  const name = tenant?.name ?? id;
  const isSbx = Boolean(tenant?.sandbox);
  const report: Array<{ key: string; ok: boolean; detail: string }> = (() => {
    try { return rail?.verify_report ? (JSON.parse(rail.verify_report) as Array<{ key: string; ok: boolean; detail: string }>) : []; } catch { return []; }
  })();
  const activeCampaigns = d.campaigns.filter((c) => !c.revoked_at);
  type Check = { ok: boolean | null; title: string; detail: string };
  const checks: Check[] = isSbx
    ? [
      { ok: true, title: 'Sandbox tenant (ADR 0024)', detail: 'bez Moneriuma; uplate se simuliraju kroz pravi settle put' },
      { ok: Boolean(d.sandboxRow?.outbound_webhook_url), title: 'Outbound webhook', detail: d.sandboxRow?.outbound_webhook_url ?? 'nije postavljen' },
      { ok: d.keys.some((k) => !k.revoked_at), title: 'API ključ', detail: `${d.keys.filter((k) => !k.revoked_at).length} aktivnih` },
    ]
    : [
      { ok: rail ? Boolean(rail.client_secret_enc) : false, title: 'Monerium profil i token', detail: rail ? `${rail.monerium_env} · profil ${short(rail.profile_id, 8, 6)}` : 'rail nije upisan' },
      { ok: rail ? Boolean(rail.receiving_safe) : false, title: 'Prihvatni Safe', detail: rail?.receiving_safe ?? '—' },
      { ok: rail?.mode === 'direct' ? true : rail ? Boolean(rail.roles_modifier && rail.role_key) : false, title: 'ProjectRouter rola', detail: rail?.mode === 'direct' ? 'direct mode — ne treba' : rail?.roles_modifier ?? '—' },
      { ok: rail?.mode === 'direct' ? true : rail ? Boolean(rail.router_key_enc) : false, title: 'Router EOA i ključ', detail: rail?.mode === 'direct' ? 'direct mode — ne treba' : rail?.router_address ?? 'ključ nije generiran' },
      { ok: rail ? Boolean(rail.webhook_secret_enc && rail.webhook_subscription_id) : false, title: 'Monerium webhook', detail: rail?.webhook_subscription_id ? `pretplata ${short(rail.webhook_subscription_id, 8, 4)}` : 'nije registriran' },
      { ok: activeCampaigns.length > 0 || d.addressCount > 0, title: 'Odobreni primatelji', detail: `${activeCampaigns.length} projekata · ${d.addressCount} payout adresa` },
      { ok: rail ? Boolean(rail.outbound_webhook_url) : false, title: 'Outbound webhook (merchant)', detail: rail?.outbound_webhook_url ?? 'nije postavljen' },
      { ok: rail?.verified_at ? report.every((c) => c.ok) : null, title: 'Verify', detail: rail?.verified_at ? `${report.filter((c) => c.ok).length}/${report.length} · ${fmtDate(rail.verified_at)}` : 'nikad pokrenut' },
    ];
  const done = checks.filter((c) => c.ok).length;
  return (
    <>
      <a href="/admin/v2/tenants" class="small">← Tenanti</a>
      <div class="row" style="align-items:flex-start">
        <div style="display:flex;gap:14px;align-items:center">
          <span class="ava">{name.slice(0, 1).toUpperCase()}</span>
          <div class="two">
            <h1 style="font-size:24px">{name}</h1>
            <span class="dim small"><Mono>{id}</Mono> · {tenant?.status === 'active' ? <strong style="color:var(--ok)">Aktivan</strong> : tenant?.status ?? 'bez tenant reda'} · {isSbx ? 'sandbox' : rail ? `${rail.monerium_env} · ${rail.chain} · ${rail.mode ?? 'forward'}` : '—'}</span>
          </div>
        </div>
        <div class="chips">
          {!isSbx && rail ? <a class="btn" href={`/admin/tenants/${encodeURIComponent(id)}/setup`}>On-chain setup</a> : null}
          <a class="btn" href="/admin/tenants">Uredi (v1)</a>
          {!isSbx && rail ? <button class="btn primary" data-post={`/admin/api/tenants/${encodeURIComponent(id)}/rail/verify`} data-render="verify">Pokreni provjeru</button> : null}
        </div>
      </div>
      <div class="cols">
        <section class="card" style="flex:2 1 460px">
          <div class="card-h" style="flex-direction:column;align-items:stretch;gap:10px">
            <div class="row"><h2>{isSbx ? 'Sandbox' : 'Postavljanje raila'}</h2><span class="dim small">{done} od {checks.length}</span></div>
            <div class="progress"><span style={`width:${Math.round((done / checks.length) * 100)}%`} /></div>
          </div>
          {checks.map((c) => (
            <div class="check">
              <span class={`ck ${c.ok ? 'ok' : c.ok === false ? 'no' : 'todo'}`}>{c.ok ? '✓' : c.ok === false ? '✕' : ''}</span>
              <span class="two" style="flex:1"><span style="font-weight:500">{c.title}</span><Mono>{c.detail}</Mono></span>
            </div>
          ))}
          <div id="verifyOut" />
        </section>
        <div style="flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:20px">
          <section class="card"><div class="card-h"><h2>Zadnjih 30 dana</h2><a class="small" href={`/admin/v2/payments?tenant=${encodeURIComponent(id)}`}>Uplate →</a></div>
            <div class="card-b" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
              <div class="two"><span class="dim small">Promet</span><span class="amt" style="font-size:20px">{fmtEur(stats?.vol ?? 0)}</span></div>
              <div class="two"><span class="dim small">Plaćene uplate</span><span class="amt" style="font-size:20px">{stats?.paid ?? 0}</span></div>
            </div>
          </section>
          {tenant && !isSbx ? <section class="card"><div class="card-h"><h2>Prihvatni račun</h2></div><div class="card-b"><dl class="kv">
            <dt>Primatelj</dt><dd>{tenant.beneficiary_name}</dd><dt>IBAN</dt><dd><Mono>{tenant.iban}</Mono></dd><dt>BIC</dt><dd><Mono>{tenant.bic ?? '—'}</Mono></dd>
          </dl></div></section> : null}
          <section class="card"><div class="card-h"><h2>Projekti (primatelji)</h2><a class="small" href="/admin/whitelist">Upravljaj (v1)</a></div>
            {d.campaigns.length ? d.campaigns.map((c) => (
              <div class="check"><span class="two" style="flex:1"><span style="display:flex;justify-content:space-between;gap:8px"><span style="font-weight:500">{c.label ?? c.campaign_id}</span>{c.revoked_at ? <Pill tone="muted">opozvan</Pill> : <Pill tone="ok">aktivan</Pill>}</span><Mono>{c.campaign_id} · {short(c.safe_address, 8, 6)}</Mono></span></div>
            )) : <Empty>Nema projekata.</Empty>}
          </section>
          <section class="card"><div class="card-h"><h2>Računi kod drugih providera</h2></div>
            {d.accounts.length ? d.accounts.map((a) => (
              <div class="check"><span class="two" style="flex:1"><span style="display:flex;justify-content:space-between;gap:8px"><span style="font-weight:500">{a.label ?? a.provider}</span>{a.active ? <Pill tone="ok">{a.environment}</Pill> : <Pill tone="muted">neaktivan</Pill>}</span><Mono>{a.provider} · {a.mode} · {a.iban ?? a.external_account_id ?? '—'}</Mono></span></div>
            )) : <Empty>Nema. Uplata kod drugog providera ostaje na tenantovu računu, MPT samo upari intent (ADR 0032).</Empty>}
          </section>
          <section class="card"><div class="card-h"><h2>API ključevi</h2></div>
            {d.keys.length ? d.keys.map((k) => (
              <div class="check"><span class="two" style="flex:1"><span style="display:flex;justify-content:space-between;gap:8px"><span style="font-weight:500">{k.label ?? (k.kind === 'secret' ? 'Tajni ključ' : 'Javni ključ')}</span>{k.revoked_at ? <Pill tone="muted">opozvan</Pill> : <Pill tone={k.kind === 'secret' ? 'warn' : 'info'}>{k.kind}</Pill>}</span><Mono>{short(k.key_hash, 8, 4)} · {fmtDate(k.created_at)}</Mono></span></div>
            )) : <Empty>Nema ključeva.</Empty>}
          </section>
        </div>
      </div>
      <section class="card"><div class="card-h"><h2>Zadnje uplate</h2></div><PaymentsTable scope={scope} rows={recent} compact /></section>
      <section class="card"><div class="card-h"><h2>Aktivnost</h2><a class="small" href={`/admin/v2/developers?tab=audit&tenant=${encodeURIComponent(id)}`}>Sve →</a></div>
        {audit.length ? <div class="tbl"><table><tbody>{audit.map((a) => (
          <tr><td class="dim" style="white-space:nowrap">{fmtDate(a.at)}</td><td><Mono>{a.action}</Mono></td><td class="small">{a.address ? <Mono>{short(a.address, 8, 6)}</Mono> : null}</td><td class="dim small">{a.actor}</td></tr>
        ))}</tbody></table></div> : <Empty>Nema ručnih radnji.</Empty>}
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Developeri
// ---------------------------------------------------------------------------

export type DevTab = 'events' | 'inbox' | 'outbox' | 'audit';

const DevNav: FC<{ tab: DevTab }> = ({ tab }) => (
  <nav class="subnav" aria-label="Developeri">
    {([['events', 'Monerium webhookovi'], ['inbox', 'Priljevi (inbox)'], ['outbox', 'Odlazne isporuke'], ['audit', 'Audit log']] as Array<[DevTab, string]>).map(([k, l]) => (
      <a class={tab === k ? 'on' : ''} href={`/admin/v2/developers?tab=${k}`}>{l}</a>
    ))}
  </nav>
);

export const DevelopersPage: FC<{
  scope: Scope; tab: DevTab; query: Record<string, string | undefined>;
  events?: Awaited<ReturnType<typeof import('./data').listWebhookEvents>>;
  inbox?: Awaited<ReturnType<typeof import('./data').listInbox>>;
  outbox?: Awaited<ReturnType<typeof import('./data').listOutbox>>;
  audit?: Awaited<ReturnType<typeof import('./data').listAuditV2>>;
}> = ({ scope, tab, query, events, inbox, outbox, audit }) => (
  <>
    <div class="row"><h1>Developeri</h1><span class="dim small">dolazni webhook: <Mono>/api/monerium/webhook</Mono></span></div>
    <DevNav tab={tab} />
    {tab === 'events' && events ? (
      <>
        <div class="chips">
          <a class={!query.sig ? 'chip on' : 'chip'} href="/admin/v2/developers?tab=events">Svi</a>
          <a class={query.sig === '1' ? 'chip on' : 'chip'} href="/admin/v2/developers?tab=events&sig=1">Potpis OK</a>
          <a class={query.sig === '0' ? 'chip on' : 'chip'} href="/admin/v2/developers?tab=events&sig=0">Potpis neispravan</a>
        </div>
        <section class="card">{events.length ? <div class="tbl"><table>
          <thead><tr><th>Event</th><th>Potpis</th><th>Iznos</th><th>Uplata</th><th>Tenant</th><th class="r">Primljeno</th></tr></thead>
          <tbody>{events.map((e) => {
            const sid = e.sid_extracted ?? e.sid_resolved;
            const href = `/admin/v2/developers/events/${e.id}`;
            return (
              <tr class="click" data-href={href}>
                <td><span class="two"><a class="mono" href={href} style="color:var(--text)">{e.event_type ?? '—'}</a><span class="dim small">#{e.id}{e.processing_note ? ` · ${e.processing_note.slice(0, 70)}` : ''}</span></span></td>
                <td>{e.signature_ok ? <Pill tone="ok">OK</Pill> : <Pill tone="bad">neispravan</Pill>}</td>
                <td class="amt">{fmtEur(e.amount_cents)}</td>
                <td>{sid ? <a class="mono" href={`/admin/v2/payments/${encodeURIComponent(sid)}`}>{sid}</a> : <span class="dim">—</span>}{e.sid_resolved && !e.sid_extracted ? <span class="dim small"> (resolver)</span> : null}</td>
                <td class="dim">{e.tenant_id ? tenantLabel(scope, e.tenant_id) : '—'}</td>
                <td class="r dim" style="white-space:nowrap">{fmtDateSec(e.received_at)}</td>
              </tr>
            );
          })}</tbody></table></div> : <Empty>Nema eventa.</Empty>}</section>
      </>
    ) : null}
    {tab === 'inbox' && inbox ? (
      <>
        <div class="chips">
          <a class={!query.unmatched ? 'chip on' : 'chip'} href="/admin/v2/developers?tab=inbox">Svi</a>
          <a class={query.unmatched ? 'chip on' : 'chip'} href="/admin/v2/developers?tab=inbox&unmatched=1">Neupareni</a>
        </div>
        <section class="card">{inbox.length ? <div class="tbl"><table>
          <thead><tr><th>Iznos</th><th>Provider</th><th>Uplatitelj</th><th>Opis plaćanja</th><th>Upareno</th><th class="r">Kad</th></tr></thead>
          <tbody>{inbox.map((c) => (
            <tr class={c.matched_sid ? 'click' : ''} data-href={c.matched_sid ? `/admin/v2/payments/${encodeURIComponent(c.matched_sid)}` : undefined}>
              <td class="amt">{fmtEur(c.amount_cents)}</td>
              <td><span class="two"><span>{c.provider}</span><span class="dim small">{c.finality}</span></span></td>
              <td><span class="two"><span>{c.debtor_name ?? '—'}</span><Mono>{c.debtor_account ?? ''}</Mono></span></td>
              <td class="small"><Mono>{(c.remittance ?? '—').slice(0, 60)}</Mono></td>
              <td>{c.matched_sid ? <span class="two"><a class="mono" href={`/admin/v2/payments/${encodeURIComponent(c.matched_sid)}`}>{c.matched_sid}</a><span class="dim small">{c.matched_by}</span></span> : <span class="two"><Pill tone="warn">neupareno</Pill><span class="dim small">{c.match_note ?? ''}</span></span>}</td>
              <td class="r dim" style="white-space:nowrap">{fmtDateSec(c.occurred_at)}</td>
            </tr>
          ))}</tbody></table></div> : <Empty>Inbox je prazan.</Empty>}</section>
      </>
    ) : null}
    {tab === 'outbox' && outbox ? (
      <>
        <div class="chips">
          {([[undefined, 'Sve'], ['delivered', 'Isporučeno'], ['pending', 'U redu'], ['failed', 'Palo']] as Array<[string | undefined, string]>).map(([s, l]) => (
            <a class={query.status === s ? 'chip on' : 'chip'} href={`/admin/v2/developers${qs({ tab: 'outbox', status: s })}`}>{l}</a>
          ))}
        </div>
        <section class="card">{outbox.length ? <div class="tbl"><table>
          <thead><tr><th>Event</th><th>Status</th><th>Zadnji odgovor</th><th>Tenant</th><th class="r">Stvoreno</th><th /></tr></thead>
          <tbody>{outbox.map((o) => {
            const sid = o.id.includes('_') ? o.id.slice(o.id.indexOf('_') + 1) : null;
            return (
              <tr>
                <td><span class="two"><Mono>{o.type}</Mono>{sid ? <a class="mono small" href={`/admin/v2/payments/${encodeURIComponent(sid)}`}>{o.id}</a> : <Mono>{o.id}</Mono>}</span></td>
                <td>{o.status === 'delivered' ? <Pill tone="ok">isporučeno</Pill> : o.status === 'failed' ? <Pill tone="bad">palo</Pill> : <Pill tone="info">u redu</Pill>}<div class="dim small">{o.attempts} pokušaja</div></td>
                <td class="small">{o.last_status ? `HTTP ${o.last_status}` : '—'}{o.last_error ? <div class="dim">{o.last_error.slice(0, 90)}</div> : null}</td>
                <td class="dim">{tenantLabel(scope, o.tenant_id)}</td>
                <td class="r dim" style="white-space:nowrap">{fmtDateSec(o.created_at)}</td>
                <td class="r"><button class="btn" data-post={`/admin/api/outbox/${encodeURIComponent(o.id)}/resend`} data-confirm="Potvrdi" data-done="Poslano ponovno.">Pošalji ponovno</button></td>
              </tr>
            );
          })}</tbody></table></div> : <Empty>Nema isporuka.</Empty>}</section>
      </>
    ) : null}
    {tab === 'audit' && audit ? (
      <>
        <div class="chips">
          <a class={!query.system ? 'chip on' : 'chip'} href={`/admin/v2/developers${qs({ tab: 'audit', tenant: query.tenant })}`}>Ručne radnje</a>
          <a class={query.system ? 'chip on' : 'chip'} href={`/admin/v2/developers${qs({ tab: 'audit', tenant: query.tenant, system: 1 })}`}>Uključi sistemske (outflow.tick…)</a>
          {query.tenant ? <a class="chip on" href={`/admin/v2/developers${qs({ tab: 'audit', system: query.system })}`}>Tenant: {query.tenant} ×</a> : null}
        </div>
        <section class="card">{audit.length ? <div class="tbl"><table>
          <thead><tr><th>Kad</th><th>Radnja</th><th>Tenant</th><th>Adresa</th><th>Tko</th><th>Detalj</th></tr></thead>
          <tbody>{audit.map((a) => (
            <tr>
              <td class="dim" style="white-space:nowrap">{fmtDateSec(a.at)}</td>
              <td><Mono>{a.action}</Mono></td>
              <td class="dim">{a.tenant_id ?? '—'}</td>
              <td>{a.address ? <Mono>{short(a.address, 8, 6)}</Mono> : '—'}</td>
              <td class="small">{a.actor}</td>
              <td class="small"><Mono>{(a.detail ?? '').slice(0, 120)}</Mono></td>
            </tr>
          ))}</tbody></table></div> : <Empty>Nema zapisa.</Empty>}</section>
      </>
    ) : null}
  </>
);

export const EventDetailPage: FC<{ scope: Scope; e: NonNullable<Awaited<ReturnType<typeof import('./data').getWebhookEvent>>> }> = ({ scope, e }) => {
  const pretty = (s: string | null) => { if (!s) return '—'; try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
  const sid = e.sid_extracted ?? e.sid_resolved;
  return (
    <>
      <a href="/admin/v2/developers?tab=events" class="small">← Webhookovi</a>
      <div class="row"><div class="two"><h1 class="mono" style="font-size:22px">{e.event_type ?? 'event'}</h1><span class="dim small">event #{e.id} · {fmtDateSec(e.received_at)}</span></div>
        {e.signature_ok ? <Pill tone="ok">Potpis OK</Pill> : <Pill tone="bad">Potpis neispravan</Pill>}</div>
      <section class="card"><div class="card-b"><dl class="kv">
        <dt>Tenant</dt><dd>{e.tenant_id ? tenantLabel(scope, e.tenant_id) : 'nije razriješen'}</dd>
        <dt>Uplata</dt><dd>{sid ? <a class="mono" href={`/admin/v2/payments/${encodeURIComponent(sid)}`}>{sid}</a> : '—'}{e.sid_resolved && !e.sid_extracted ? ' (stray resolver)' : ''}</dd>
        <dt>Order</dt><dd>{e.order_id ? <a class="mono" href={`/admin/orders/${encodeURIComponent(e.order_id)}`}>{e.order_id}</a> : '—'}</dd>
        <dt>Iznos</dt><dd>{fmtEur(e.amount_cents)}</dd>
        <dt>Napomena</dt><dd>{e.processing_note ?? '—'}</dd>
      </dl></div></section>
      <section class="card"><div class="card-h"><h2>Payload</h2></div><div class="card-b"><pre>{pretty(e.payload)}</pre></div></section>
      <details class="card"><summary class="card-h" style="cursor:pointer"><h2>HTTP zaglavlja</h2></summary><div class="card-b"><pre>{pretty(e.headers_json)}</pre></div></details>
    </>
  );
};

// ---------------------------------------------------------------------------
// Pretraga
// ---------------------------------------------------------------------------

export const SearchPage: FC<{ q: string; hits: SearchHit[] }> = ({ q, hits }) => (
  <>
    <div class="row"><h1>Pretraga</h1><span class="dim small">oba okruženja</span></div>
    {!q ? <Empty>Upiši SID, kratku referencu, 0x adresu ili tx, IBAN uplatitelja, Monerium order id ili ime tenanta.</Empty> : null}
    {q && !hits.length ? <Empty>Ništa za „{q}”.</Empty> : null}
    {hits.length ? (
      <section class="card attn">
        {hits.map((h) => (
          <a href={h.href}><span class="two" style="flex:1"><span><span class="dim small">{h.kind} · </span><strong class="mono">{h.label}</strong></span><span class="dim small">{h.sub}</span></span><span class="cta">Otvori →</span></a>
        ))}
      </section>
    ) : null}
  </>
);
