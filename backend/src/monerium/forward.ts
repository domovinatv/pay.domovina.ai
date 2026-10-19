import type { Address } from 'viem';

import type { Env } from '../types';
import type { MoneriumOrder } from './types';
import { getForwardByOrder, insertForward, listOwedForwards, transitionForward, updateForward, type MoneriumForwardRow } from './db';
import {
  extractRoutingFromOrder,
  extractSenderFromOrder,
  type RoutingTarget,
  type SenderInfo,
} from './sid';
import {
  placedAtUnix,
  resolveStray,
  STRAY_CLOCK_SKEW_SECONDS,
  STRAY_LOOKBACK_SECONDS,
  type StrayCandidate,
} from './strayResolver';
import { findStrayCandidates } from '../intents/db';
import { forwardViaSafe, simulateForwardViaSafe, type ForwardArgs, type ForwardResult } from '../router/safe';
import {
  makeConfirmDeps,
  pollForwardConfirmation,
  settleNonRoutedPaid,
} from '../intents/confirm';
import { emitCampaignContributionWebhook, emitForwardBlockedWebhook } from '../intents/outbound';
import {
  authorizeForward,
  describeParkReason,
  makeAuthorizeDeps,
  type AuthorizeDeps,
  type ParkReason,
} from '../tenants/whitelist';
import { writeAudit } from '../tenants/db';
import { defaultTenantId } from '../tenants/whitelist';
import { getTenantRail, listRailTenantIds, type TenantRail } from '../tenants/rail';
import { sendAlert } from '../alerts';
import { receiptKind } from '../receipts/sid';
import { publishIntentChange } from '../intents/stream';

/// The forward hop: EURe that Monerium minted into the MPT Safe is pushed on
/// to the payee. Extracted out of index.ts so the fail-closed branches are
/// unit-testable — every external effect goes through `ForwardDeps`.
///
/// Authorisation lives entirely in `authorizeForward` (../tenants/whitelist.ts);
/// nothing here decides on its own that an address is acceptable.

export interface ForwardDeps {
  authorize: AuthorizeDeps;
  getForwardByOrder(orderId: string): Promise<{ status: string } | null>;
  insertForward(args: Parameters<typeof insertForward>[1]): Promise<number>;
  updateForward(id: number, patch: Parameters<typeof updateForward>[2]): Promise<void>;
  forward(args: ForwardArgs): Promise<ForwardResult>;
  /// ADR 0026: settles D4 owed rows through the ProjectRouter role, which the
  /// Roles modifier restricts on-chain to the approved project Safes. Absent =
  /// the rail has no such role and D4 stays a manual 2/3 transfer.
  projectRouter?: {
    /// eth_call of the exact role call. Not ok = the modifier would refuse.
    simulate(args: Pick<ForwardArgs, 'target' | 'amountWei'>): Promise<ForwardResult>;
    forward(args: ForwardArgs): Promise<ForwardResult>;
    /// owed → broadcasting, atomically. False = another caller took the row
    /// (webhook vs cron) or it was settled meanwhile.
    claimOwed(forwardId: number): Promise<boolean>;
  };
  /// Wait before the one nonce-collision retry. Defaults to setTimeout.
  sleep?(ms: number): Promise<void>;
  settleNonRoutedPaid(args: {
    sid: string;
    orderId: string;
    forwardId: number;
    amountCents: number | null;
    sender: SenderInfo;
  }): Promise<boolean>;
  pollConfirmation(fwd: {
    id: number;
    tenant_id: string | null;
    order_id: string;
    sid: string | null;
    tx_hash: string;
    amount_cents: number | null;
    memo_prefix: string | null;
    target_address: string;
  }): Promise<'confirmed' | 'failed' | 'timeout'>;
  alert(text: string): Promise<void>;
  /// Stray resolver (./strayResolver.ts): the rail tenant's unsettled intents
  /// of exactly this amount created in [from, to]. Absent = resolver off —
  /// reference-less payments park as before.
  findStrayCandidates?(args: {
    amountCents: number;
    createdFrom: number;
    createdTo: number;
  }): Promise<StrayCandidate[]>;
  /// Clock for the resolver window; defaults to Date.now().
  nowUnix?(): number;
  /// Poke the intent's SSE stream (ADR 0017). Optional, fail-soft.
  publish?(sid: string | null): Promise<void>;
  audit(entry: {
    tenantId: string | null;
    action: string;
    address?: string | null;
    actor: string;
    detail?: string | null;
  }): Promise<void>;
  /// Direct mode D6: a contribution minted straight into a project Safe.
  /// Optional: absent = no merchant event (the record is still written).
  emitContribution?(args: Parameters<typeof emitCampaignContributionWebhook>[1]): Promise<void>;
  emitBlocked(args: {
    reason: string;
    orderId: string;
    sid: string | null;
    campaignId: string | null;
    targetAddress: string | null;
    amountCents: number | null;
    tenantId: string | null;
  }): Promise<void>;
}

/// Deps for one tenant's rail (ADR 0017). Everything that decides or moves
/// value is bound to `rail`: whose intents it may settle, which Safe the money
/// must be in, and which signer moves it. Forward rows are stamped with the
/// tenant so confirmation reads the right chain.
export function makeForwardDeps(env: Env, rail: TenantRail): ForwardDeps {
  return {
    authorize: makeAuthorizeDeps(env, rail),
    getForwardByOrder: (orderId) => getForwardByOrder(env, orderId),
    insertForward: (args) => insertForward(env, { ...args, tenantId: rail.tenantId }),
    updateForward: async (id, patch) => {
      await updateForward(env, id, patch);
    },
    // A direct-mode rail never signs (its gate never answers 'forward'); this
    // is the second lock, in case a future path forgets to ask the gate.
    forward: rail.mode === 'direct'
      ? async () => ({ ok: false, error: 'router_disabled: direct mode never signs' })
      : (args) => forwardViaSafe(rail.signer, args),
    projectRouter: rail.mode === 'direct' && rail.projectRouter
      ? {
          simulate: (args) => simulateForwardViaSafe(rail.projectRouter!, args),
          forward: (args) => forwardViaSafe(rail.projectRouter!, args),
          claimOwed: (id) => transitionForward(env, id, 'router_claim', { error: null }),
        }
      : undefined,
    settleNonRoutedPaid: (args) => settleNonRoutedPaid(makeConfirmDeps(env), args),
    pollConfirmation: (fwd) => pollForwardConfirmation(makeConfirmDeps(env), fwd),
    alert: (text) => sendAlert(env, text),
    findStrayCandidates: env.STRAY_RESOLVER === '1'
      ? (args) => findStrayCandidates(env, {
          ...args,
          tenantId: rail.tenantId,
          defaultTenantId: defaultTenantId(env),
        })
      : undefined,
    publish: (sid) => publishIntentChange(env, sid),
    audit: (entry) => writeAudit(env, entry),
    emitBlocked: (args) => emitForwardBlockedWebhook(env, args),
    emitContribution: (args) => emitCampaignContributionWebhook(env, args),
  };
}

import { parseAmountCents } from './orderState';
export { parseAmountCents };

/// EURe has 18 decimals. Split on the decimal point and pad so no float math
/// touches a money value.
export function eurToWei(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || '0');
}

/// Forward-level idempotency guard, then the forward itself. Called inside
/// `executionCtx.waitUntil` so the webhook response is never blocked.
export async function maybeForward(
  deps: ForwardDeps,
  order: MoneriumOrder,
): Promise<void> {
  // Cheap early exit for the common retry. NOT the guard — the atomic latch
  // on insertForward is (check-then-act here would race, BW-02).
  const existing = await deps.getForwardByOrder(order.id);
  if (existing && (existing.status === 'submitted' || existing.status === 'confirmed'
    || existing.status === 'resolved_offrail')) {
    console.log(`forward ${order.id} already ${existing.status}, skipping`);
    return;
  }
  await handleForward(deps, order);
}

/// How a forward found its intent: from the memo (null), by the stray
/// resolver ('auto') or by an operator in the admin UI ('manual'). Stored in
/// monerium_forwards.memo_prefix for the latter two.
type ResolvedVia = 'auto' | 'manual';

export async function handleForward(
  deps: ForwardDeps,
  order: MoneriumOrder,
  /// Operator reroute of a parked order onto a chosen intent (admin UI).
  manual?: { sid: string },
): Promise<void> {
  // What the payer actually sent. Parks always report THIS, not a resolved
  // guess — a `forward.blocked` webhook must never name an intent the
  // payment merely might have belonged to.
  const memoRouting = extractRoutingFromOrder(order);
  let routing = memoRouting;
  const sender = extractSenderFromOrder(order);
  const amountCents = parseAmountCents(order.amount);

  // ---- Reference-less payment → find the intent it paid. ----
  // The resolver only ever proposes an intent's own, tenant-authorised
  // target; the synthesised routing then faces the same gate as a memo.
  let claimSids: string[] | null = null;
  let via: ResolvedVia | null = null;
  let strayNote: string | null = null;
  let ambiguousIntent = false;
  if (manual) {
    const intent = await deps.authorize.getIntentBySid(manual.sid);
    if (intent) {
      routing = resolvedRouting(intent.target_address, manual.sid);
      claimSids = [manual.sid];
      via = 'manual';
    }
  } else if (isStray(routing) && deps.findStrayCandidates && amountCents !== null) {
    const now = deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);
    const placed = placedAtUnix(order.meta?.placedAt, now);
    const candidates = await deps.findStrayCandidates({
      amountCents,
      createdFrom: placed - STRAY_LOOKBACK_SECONDS,
      createdTo: placed + STRAY_CLOCK_SKEW_SECONDS,
    });
    const res = resolveStray(candidates, placed);
    if (res.kind === 'match') {
      routing = resolvedRouting(res.target, res.sids[0]);
      claimSids = res.sids;
      via = 'auto';
      ambiguousIntent = res.ambiguousIntent;
    } else if (res.kind === 'conflict') {
      strayNote =
        `kandidati s istim iznosom vode na RAZLIČITE adrese — ručno odabrati:\n` +
        res.candidates
          .slice(0, 5)
          .map((c) => `• <code>${c.sid}</code> → <code>${c.target_address}</code> (${c.state})`)
          .join('\n');
    } else {
      strayNote = res.untrusted
        ? `nema pouzdanog kandidata; ${res.untrusted} intent(a) s tim iznosom vodi na wallet adresu ` +
          `koja nije na statičnoj whitelisti — ručno preusmjeriti ako je to prava uplata`
        : 'nema otvorenog/nedavno isteklog intenta s tim iznosom (48 h)';
    }
  }

  // BW-23: only EUR issue orders become EURe forwards. Checked before the
  // gate (whose order of checks stays as it is).
  if ((order.currency ?? 'eur').toLowerCase() !== 'eur') {
    await park(deps, { order, routing: memoRouting, amountCents, reason: 'unsupported_currency', tenantId: deps.authorize.railTenantId, note: null });
    return;
  }

  // ---- Single authorisation gate. No forward path bypasses this. ----
  const decision = await authorizeForward(deps.authorize, routing, {
    mintAddress: order.address ?? null,
    amountCents,
  });

  if (decision.action === 'park') {
    await park(deps, {
      order,
      routing: memoRouting,
      amountCents,
      reason: decision.reason,
      tenantId: decision.tenantId,
      note: strayNote ?? (via
        ? `povezano s intentom <code>${routing.sid}</code> (${via}) → <code>${routing.target}</code>, ali gate odbio`
        : null),
    });
    return;
  }

  // Memo targets the Safe itself: nothing to transfer, the mint already landed
  // where it should. `state=processed` means that mint is on-chain confirmed,
  // so 'paid' keys off it directly.
  //
  // Direct mode is the same bookkeeping: Monerium minted into the intent's
  // project Safe because the reference named it, so the rail only records a
  // confirmed zero-value forward and settles the intent.
  if (decision.action === 'self_noop' || decision.action === 'direct_settle') {
    const direct = decision.action === 'direct_settle';
    if (direct) routing = { ...routing, sid: decision.sid, target: decision.target };
    const claimed = await claimForward(deps, order, routing, claimSids, via, {
      orderId: order.id,
      targetAddress: routing.target!,
      amountWei: '0',
      amountCents,
      status: 'confirmed',
      error: direct ? 'direct_mint' : 'self_target_noop',
    });
    if (claimed.forwardId === 0) {
      if (claimed.exhausted) {
        await park(deps, { order, routing: memoRouting, amountCents, reason: 'no_routing_target',
          tenantId: decision.tenantId, note: 'svi kandidati već preuzeti drugom uplatom' });
        return;
      }
      console.log(`forward ${order.id} self_noop already claimed by a concurrent delivery`);
      return;
    }
    if (claimed.sid) {
      await deps.settleNonRoutedPaid({
        sid: claimed.sid,
        orderId: order.id,
        forwardId: claimed.forwardId,
        amountCents,
        sender,
      });
    }
    return;
  }

  // Direct mode D6: a sid-less `<chain>:0x<project Safe>` payment Monerium
  // minted straight into the project. Record it as a contribution, done.
  if (decision.action === 'direct_contribution') {
    const id = await deps.insertForward({
      orderId: order.id,
      targetAddress: decision.target,
      amountWei: '0',
      amountCents,
      sid: null,
      memoPrefix: routing.prefix,
      status: 'confirmed',
      error: 'direct_contribution',
    });
    if (id === 0) {
      console.log(`forward ${order.id} direct contribution already recorded`);
      return;
    }
    console.log(`forward ${order.id} direct contribution → ${decision.campaignId} (${decision.target})`);
    await safely(deps.emitContribution?.({
      campaignId: decision.campaignId,
      orderId: order.id,
      amountCents,
      currency: order.currency ?? 'eur',
      targetAddress: decision.target,
      forwardTxHash: null,
      senderIban: sender.iban,
      senderName: sender.name,
      tenantId: decision.tenantId,
    }) ?? Promise.resolve());
    return;
  }

  // Direct mode D4: the order is this intent's, but the EURe sits in the
  // tenant's main Safe (reference lost). The rail never signs, so it books
  // the transfer as OWED: a live `pending` row (latches the order and the
  // intent) without a tx. The outflow watcher settles it when the 2/3 owners
  // send exactly this amount from the main Safe to the target.
  if (decision.action === 'direct_owed') {
    routing = { ...routing, sid: decision.sid, target: decision.target };
    const claimed = await claimForward(deps, order, routing, claimSids, via, {
      orderId: order.id,
      targetAddress: decision.target,
      amountWei: eurToWei(order.amount ?? '0').toString(),
      amountCents,
      status: 'pending',
      error: 'direct_owed',
    });
    if (claimed.forwardId === 0) {
      if (claimed.exhausted) {
        await park(deps, { order, routing: memoRouting, amountCents, reason: 'no_routing_target',
          tenantId: decision.tenantId, note: 'svi kandidati već preuzeti drugom uplatom' });
        return;
      }
      console.log(`forward ${order.id} direct_owed already claimed by a concurrent delivery`);
      return;
    }
    for (const other of claimSids ?? []) {
      if (other !== claimed.sid) await safely(deps.publish?.(other) ?? Promise.resolve());
    }
    await safely(deps.publish?.(claimed.sid) ?? Promise.resolve());
    console.log(`forward ${order.id} direct_owed → ${decision.target} sid=${claimed.sid}${via ? ` (${via})` : ''}`);
    if (deps.projectRouter) {
      const routed = await routeOwed(deps, {
        id: claimed.forwardId,
        orderId: order.id,
        sid: claimed.sid,
        target: decision.target,
        amountWei: eurToWei(order.amount ?? '0'),
        amountCents,
        memoPrefix: via ?? routing.prefix,
      }, { ambiguousIntent });
      if (routed.outcome !== 'not_routable') return;
      await safely(deps.alert(
        `🧾 <b>Uplata povezana s projektom — čeka ProjectRouter</b>\n` +
          `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b>\n` +
          `intent: <code>${claimed.sid}</code>${via ? ` (${via === 'auto' ? 'automatski po iznosu i vremenu' : 'ručno'})` : ''}\n` +
          `novac je na glavnom Safeu <code>${deps.authorize.safeAddress ?? '-'}</code> → <code>${decision.target}</code>\n` +
          `simulacija: <code>${(routed.error ?? '-').slice(0, 200)}</code>\n` +
          `Rail ga prosljeđuje sam čim simulacija prođe (Safe projekta u roli, prijedlog potvrđen 2/3). ` +
          `Ne prenositi ručno: ručni prijenos i rail platili bi isti dug dvaput.`,
      ));
      return;
    }
    await safely(deps.alert(
      `🧾 <b>Uplata povezana s projektom — treba ručni prijenos</b>\n` +
        `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b>\n` +
        `intent: <code>${claimed.sid}</code>${via ? ` (${via === 'auto' ? 'automatski po iznosu i vremenu' : 'ručno'})` : ''}\n` +
        `novac je na glavnom Safeu <code>${deps.authorize.safeAddress ?? '-'}</code>\n` +
        `2/3 vlasnika: prebaciti <b>točno ${order.amount} EURe</b> → <code>${decision.target}</code>.\n` +
        `Rail prepoznaje taj prijenos sam i zatvara intent.` +
        (ambiguousIntent
          ? `\n⚠️ više intenata s istim iznosom i istom adresom — pripisivanje intentu je procjena`
          : ''),
    ));
    return;
  }

  // ---- Authorised: move the money. ----
  const target = routing.target!;
  const amountWei = eurToWei(order.amount ?? '0');
  const claimed = await claimForward(deps, order, routing, claimSids, via, {
    orderId: order.id,
    targetAddress: target,
    amountWei: amountWei.toString(),
    amountCents,
    status: 'pending',
  });
  // The INSERT is the decision (migration 0016 latch): a concurrent delivery
  // that lost the race must not broadcast a second transfer.
  if (claimed.forwardId === 0) {
    if (claimed.exhausted) {
      await park(deps, { order, routing: memoRouting, amountCents, reason: 'no_routing_target',
        tenantId: decision.tenantId, note: 'svi kandidati već preuzeti drugom uplatom' });
      return;
    }
    console.log(`forward ${order.id} already claimed by a concurrent delivery, skipping`);
    return;
  }
  const forwardId = claimed.forwardId;
  // From here on the sid is the CLAIMED one — for a resolved stray it may be
  // a later candidate than the one the gate was asked about (same target).
  routing = { ...routing, sid: claimed.sid };
  // The other candidates' checkouts may be showing this payment's early
  // "zaprimljeno" (sid_resolved preview); poke them so they re-read and drop
  // it now that it belongs to `claimed.sid` (SR-03).
  for (const other of claimSids ?? []) {
    if (other !== claimed.sid) await safely(deps.publish?.(other) ?? Promise.resolve());
  }
  const forwardArgs: ForwardArgs = {
    target: target as Address,
    amountWei,
    // When PAYMENT_REGISTRY_ADDRESS + MULTISEND_ADDRESS are set, the rail
    // batches `registry.record(...)` alongside the transfer so each forward
    // emits an onchain `Payment` event. Null → legacy single-transfer path.
    sessionId: routing.sid,
    // ADR 0022 §3: a receipt sid is a direct receipt only when it came in the
    // payer's own remittance; a resolved stray is marked unbound on-chain.
    kind: receiptKind(routing.sid, via),
  };
  let result = await deps.forward(forwardArgs);
  // MT-10: two isolates picked the same router nonce. Our tx was NOT
  // accepted, so one more broadcast (fresh nonce) cannot pay twice. Never on
  // "already known" — that means the node HAS our tx.
  if (!result.ok && NONCE_COLLISION_RE.test(result.error ?? '')) {
    console.warn(`forward ${order.id} nonce collision (${result.error}) — one retry`);
    await (deps.sleep ?? defaultSleep)(NONCE_RETRY_DELAY_MS);
    result = await deps.forward(forwardArgs);
  }
  if (!result.ok) {
    await deps.updateForward(forwardId, {
      status: 'failed',
      error: result.error ?? 'unknown',
      attempts: 1,
    });
    console.error(`forward ${order.id} FAILED: ${result.error}`);
    await safely(deps.publish?.(routing.sid) ?? Promise.resolve());
    // Money is minted but parked in the MPT Safe and nothing retries a
    // failed broadcast automatically (Fable5 BW-04) — an operator must know.
    await safely(deps.alert(
      `❌ <b>MPT forward nije uspio (broadcast)</b>\n` +
        `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b> (ostaje u Safe-u)\n` +
        `cilj: <code>${target}</code> · sid: <code>${routing.sid ?? '-'}</code>\n` +
        `greška: <code>${(result.error ?? 'unknown').slice(0, 300)}</code>`,
    ));
    return;
  }

  await deps.updateForward(forwardId, {
    status: 'submitted',
    tx_hash: result.txHash!,
    attempts: 1,
  });
  console.log(`forward ${order.id} → ${target} tx=${result.txHash}${via ? ` (${via} sid=${routing.sid})` : ''}`);
  if (via) {
    await safely(deps.alert(
      `🔀 <b>Uplata bez reference ${via === 'auto' ? 'automatski' : 'ručno'} povezana s intentom</b>\n` +
        `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b>\n` +
        `intent: <code>${routing.sid}</code> → <code>${target}</code>\n` +
        `tx: <code>${result.txHash}</code>` +
        (ambiguousIntent
          ? `\n⚠️ više intenata s istim iznosom i istom adresom — novac je na pravom mjestu, pripisivanje intentu je procjena`
          : ''),
    ));
  }
  await safely(deps.publish?.(routing.sid) ?? Promise.resolve());
  // 'paid' + the merchant/campaign webhooks fire on ON-CHAIN CONFIRMATION, not
  // on broadcast — a forward that later reverts must never have told the
  // merchant "plaćeno". If this poll is evicted, the cron reconcile and the
  // status read path are the backstops; all three settle through the same
  // atomic submitted → confirmed flip, so effects stay single-fire.
  const outcome = await deps.pollConfirmation({
    id: forwardId,
    tenant_id: deps.authorize.railTenantId,
    order_id: order.id,
    sid: routing.sid,
    tx_hash: result.txHash!,
    amount_cents: amountCents,
    memo_prefix: routing.prefix,
    target_address: target,
  });
  await safely(deps.publish?.(routing.sid) ?? Promise.resolve());
  if (outcome === 'timeout') {
    console.log(`forward ${order.id} unconfirmed after poll window — cron reconcile will settle`);
  } else if (outcome === 'failed') {
    console.error(`forward ${order.id} REVERTED on-chain tx=${result.txHash} — intent NOT paid, no webhook`);
    await safely(deps.alert(
      `❌ <b>MPT forward revertan on-chain</b>\n` +
        `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b> (ostaje u Safe-u)\n` +
        `tx: <code>${result.txHash}</code> · sid: <code>${routing.sid ?? '-'}</code>`,
    ));
  }
}

/// One D4 debt, as the ProjectRouter needs it.
export interface OwedForward {
  id: number;
  orderId: string;
  sid: string | null;
  target: string;
  amountWei: bigint;
  amountCents: number | null;
  memoPrefix: string | null;
}

export type OwedOutcome = 'submitted' | 'not_routable' | 'lost_race' | 'failed';

/// ADR 0026: move one owed debt from the main Safe to its project Safe through
/// the ProjectRouter role. Order matters:
///   1. simulate — a revert (project not in the role yet, balance short) leaves
///      the row `owed`; the cron tries again, so the payment goes through on
///      its own once the owners confirm the proposal;
///   2. claim — owed → broadcasting is the latch: the webhook and the cron
///      can never both pay the same debt;
///   3. broadcast — an error after the claim is `failed` + alert, NOT back to
///      `owed`: an ambiguous RPC error may mean the tx went out after all.
/// From `submitted` on it is the ordinary forward: paid + webhooks on
/// on-chain confirmation, cron reconcile as the backstop.
export async function routeOwed(
  deps: ForwardDeps,
  row: OwedForward,
  /// poll: false (cron) leaves confirmation to the cron reconcile, so a
  /// sweep over many debts is not ~75 s of polling per row.
  opts: { ambiguousIntent?: boolean; poll?: boolean } = {},
): Promise<{ outcome: OwedOutcome; error?: string }> {
  const pr = deps.projectRouter;
  if (!pr) return { outcome: 'not_routable', error: 'no ProjectRouter' };
  const args: ForwardArgs = { target: row.target as Address, amountWei: row.amountWei };
  const sim = await pr.simulate(args);
  if (!sim.ok) {
    console.log(`owed ${row.id} not routable yet: ${sim.error}`);
    return { outcome: 'not_routable', error: sim.error };
  }
  if (!(await pr.claimOwed(row.id))) {
    console.log(`owed ${row.id} already taken by another caller`);
    return { outcome: 'lost_race' };
  }
  const amount = row.amountCents !== null ? (row.amountCents / 100).toFixed(2) : '?';
  let result = await pr.forward(args);
  if (!result.ok && NONCE_COLLISION_RE.test(result.error ?? '')) {
    console.warn(`owed ${row.id} nonce collision (${result.error}) — one retry`);
    await (deps.sleep ?? defaultSleep)(NONCE_RETRY_DELAY_MS);
    result = await pr.forward(args);
  }
  if (!result.ok) {
    await deps.updateForward(row.id, { status: 'failed', error: result.error ?? 'unknown', attempts: 1 });
    console.error(`owed ${row.id} ProjectRouter broadcast FAILED: ${result.error}`);
    await safely(deps.publish?.(row.sid) ?? Promise.resolve());
    await safely(deps.alert(
      `❌ <b>ProjectRouter prijenos nije uspio (broadcast)</b>\n` +
        `order: <code>${row.orderId}</code> · iznos: <b>${amount} EUR</b> (ostaje na glavnom Safeu)\n` +
        `cilj: <code>${row.target}</code> · sid: <code>${row.sid ?? '-'}</code>\n` +
        `greška: <code>${(result.error ?? 'unknown').slice(0, 300)}</code>\n` +
        `Prije ručnog prijenosa provjeriti na lancu da tx nije ipak prošao.`,
    ));
    return { outcome: 'failed', error: result.error };
  }
  await deps.updateForward(row.id, { status: 'submitted', tx_hash: result.txHash!, attempts: 1 });
  console.log(`owed ${row.id} → ${row.target} via ProjectRouter tx=${result.txHash}`);
  await safely(deps.alert(
    `🔀 <b>Uplata bez reference proslijeđena kroz ProjectRouter</b>\n` +
      `order: <code>${row.orderId}</code> · iznos: <b>${amount} EUR</b>\n` +
      `intent: <code>${row.sid ?? '-'}</code> → <code>${row.target}</code>\n` +
      `tx: <code>${result.txHash}</code>` +
      (opts.ambiguousIntent
        ? `\n⚠️ više intenata s istim iznosom i istom adresom — novac je na pravom mjestu, pripisivanje intentu je procjena`
        : ''),
  ));
  await safely(deps.publish?.(row.sid) ?? Promise.resolve());
  if (opts.poll === false) return { outcome: 'submitted' };
  const outcome = await deps.pollConfirmation({
    id: row.id,
    tenant_id: deps.authorize.railTenantId,
    order_id: row.orderId,
    sid: row.sid,
    tx_hash: result.txHash!,
    amount_cents: row.amountCents,
    memo_prefix: row.memoPrefix,
    target_address: row.target,
  });
  await safely(deps.publish?.(row.sid) ?? Promise.resolve());
  if (outcome === 'failed') {
    console.error(`owed ${row.id} ProjectRouter tx REVERTED ${result.txHash}`);
    await safely(deps.alert(
      `❌ <b>ProjectRouter prijenos revertan on-chain</b>\n` +
        `order: <code>${row.orderId}</code> · iznos: <b>${amount} EUR</b> (ostaje na glavnom Safeu)\n` +
        `tx: <code>${result.txHash}</code> · sid: <code>${row.sid ?? '-'}</code>`,
    ));
  }
  return { outcome: 'submitted' };
}

export function owedFromRow(row: MoneriumForwardRow): OwedForward {
  return {
    id: row.id,
    orderId: row.order_id,
    sid: row.sid,
    target: row.target_address,
    amountWei: BigInt(row.amount_wei || '0'),
    amountCents: row.amount_cents,
    memoPrefix: row.memo_prefix,
  };
}

/// Cron (ADR 0026): every rail with a ProjectRouter retries its owed debts.
/// A debt whose project was not in the role yet goes through on the first
/// tick after the owners confirm the proposal. Cheap when nothing is owed:
/// one SELECT per rail, an eth_call per owed row.
export async function routeAllOwedForwards(env: Env): Promise<{ tried: number; submitted: number }> {
  const rails: TenantRail[] = [];
  for (const id of await listRailTenantIds(env)) {
    const r = await getTenantRail(env, id);
    if (r) rails.push(r);
  }
  let tried = 0;
  let submitted = 0;
  for (const rail of rails) {
    if (rail.mode !== 'direct' || !rail.projectRouter) continue;
    const owed = await listOwedForwards(env, rail.tenantId);
    if (owed.length === 0) continue;
    const deps = makeForwardDeps(env, rail);
    for (const row of owed) {
      tried++;
      try {
        if ((await routeOwed(deps, owedFromRow(row), { poll: false })).outcome === 'submitted') submitted++;
      } catch (e) {
        console.error(`owed ${row.id} (${rail.tenantId}) route failed: ${(e as Error).message}`);
      }
    }
  }
  return { tried, submitted };
}

/// Fail-closed landing: record WHY we refused, alert, tell the merchant, and
/// leave the EURe in the Safe. Never throws — an alert or webhook failure must
/// not turn a refusal into an exception that some caller might retry blindly.
async function park(
  deps: ForwardDeps,
  args: {
    order: MoneriumOrder;
    routing: ReturnType<typeof extractRoutingFromOrder>;
    amountCents: number | null;
    reason: ParkReason;
    tenantId: string | null;
    /// Extra operator context for the alert (stray resolver outcome).
    note?: string | null;
  },
): Promise<void> {
  const { order, routing, amountCents, reason, tenantId, note } = args;
  const observed = routing.target ?? routing.diagnosticTarget ?? '';

  // 'no_routing_target' keeps its historical status ('failed') because it
  // predates the whitelist and admin tooling already filters on it. Every
  // authorisation refusal gets the new 'blocked' status so an operator can
  // tell "we refused" apart from "the chain/RPC refused".
  const status = reason === 'no_routing_target' ? 'failed' : 'blocked';

  await deps.insertForward({
    orderId: order.id,
    targetAddress: observed,
    amountWei: '0',
    amountCents,
    sid: routing.sid,
    memoPrefix: routing.prefix,
    status,
    error: reason === 'no_routing_target' ? 'no_routing_target' : `not_whitelisted:${reason}`,
  });

  const amountEur = amountCents !== null ? (amountCents / 100).toFixed(2) : '?';
  console.warn(
    `forward ${order.id} BLOCKED (${reason}): memo="${order.memo ?? ''}" ` +
      `observed=${observed || '-'} tenant=${tenantId ?? '-'} amount=${amountEur} EUR`,
  );

  await safely(deps.audit({
    tenantId,
    action: 'forward.blocked',
    address: observed || null,
    actor: 'system',
    detail: JSON.stringify({
      order_id: order.id,
      reason,
      prefix: routing.prefix,
      sid: routing.sid,
      campaign_id: routing.campaignId,
      amount_cents: amountCents,
    }),
  }));

  await safely(deps.alert(
    `🛑 <b>MPT forward blokiran</b>\n` +
      `razlog: <code>${reason}</code> — ${describeParkReason(reason)}\n` +
      `order: <code>${order.id}</code>\n` +
      `iznos: <b>${amountEur} EUR</b> (ostaje u Safe-u)\n` +
      `adresa iz memo-a: <code>${observed || '-'}</code>\n` +
      `tenant: <code>${tenantId ?? '-'}</code> · prefix: <code>${routing.prefix ?? '-'}</code>` +
      (note ? `\n${note}` : ''),
  ));

  await safely(deps.publish?.(routing.sid) ?? Promise.resolve());

  // Only worth telling the merchant when there is something to correlate on.
  if (routing.sid || routing.campaignId) {
    await safely(deps.emitBlocked({
      reason,
      orderId: order.id,
      sid: routing.sid,
      campaignId: routing.campaignId,
      targetAddress: observed || null,
      amountCents,
      tenantId,
    }));
  }
}

/// Read-only preview of the stray resolver for the checkout timeline: which
/// intent would a reference-less order most plausibly settle? Runs on
/// `order.created` (~1 s after the payer taps Send) so the open checkout can
/// show "received" right away instead of after the forward (~15 s).
///
/// Never moves value and never claims: the forward still resolves on
/// `processed` with the same rule. The two can disagree only if candidates
/// change in between (a new intent opened or another stray claimed one) —
/// then the preview lit "received" on a sibling intent of the SAME payee.
/// Conflict / none → null, and the checkout simply waits as before.
export async function previewStraySid(
  deps: Pick<ForwardDeps, 'findStrayCandidates' | 'nowUnix'>,
  order: MoneriumOrder,
): Promise<string | null> {
  if (order.kind !== 'issue' || order.state === 'rejected' || !deps.findStrayCandidates) return null;
  if (!isStray(extractRoutingFromOrder(order))) return null;
  const amountCents = parseAmountCents(order.amount);
  if (amountCents === null) return null;
  const now = deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);
  const placed = placedAtUnix(order.meta?.placedAt, now);
  const candidates = await deps.findStrayCandidates({
    amountCents,
    createdFrom: placed - STRAY_LOOKBACK_SECONDS,
    createdTo: placed + STRAY_CLOCK_SKEW_SECONDS,
  });
  const res = resolveStray(candidates, placed);
  return res.kind === 'match' ? res.sids[0] : null;
}

/// No address, no sid, no campaign — nothing in the remittance to route on.
/// (A bare 0x / gnosis: memo is NOT a stray: the payer named a destination we
/// refuse, and guessing a different one would be worse than parking.)
function isStray(r: RoutingTarget): boolean {
  return !r.target && !r.diagnosticTarget && !r.sid && !r.campaignId;
}

function resolvedRouting(target: string, sid: string): RoutingTarget {
  const t = target.toLowerCase();
  return { target: t, diagnosticTarget: t, sid, campaignId: null, prefix: 'mpt' };
}

/// Insert the forward row = take the latch. Memo-carried forwards insert once
/// under their own sid. Resolved ones walk the candidate list: the per-intent
/// latch (migration 0018) makes a concurrent stray that already took an intent
/// push this one to the next candidate.
async function claimForward(
  deps: ForwardDeps,
  order: MoneriumOrder,
  routing: RoutingTarget,
  claimSids: string[] | null,
  via: ResolvedVia | null,
  row: Omit<Parameters<ForwardDeps['insertForward']>[0], 'sid' | 'memoPrefix'>,
): Promise<{ forwardId: number; sid: string | null; exhausted: boolean }> {
  if (!claimSids || !via) {
    const id = await deps.insertForward({ ...row, sid: routing.sid, memoPrefix: routing.prefix });
    return { forwardId: id, sid: routing.sid, exhausted: false };
  }
  for (const sid of claimSids) {
    const id = await deps.insertForward({ ...row, sid, memoPrefix: via });
    if (id !== 0) return { forwardId: id, sid, exhausted: false };
    // Lost a latch — which one? The order latch means another delivery of
    // THIS order owns it: stop. Otherwise the intent was taken: next one.
    const existing = await deps.getForwardByOrder(order.id);
    if (existing && LIVE.has(existing.status)) return { forwardId: 0, sid: null, exhausted: false };
  }
  return { forwardId: 0, sid: null, exhausted: true };
}

const LIVE = new Set(['pending', 'submitted', 'confirmed']);

const NONCE_COLLISION_RE = /nonce too low|replacement transaction underpriced/i;
const NONCE_RETRY_DELAY_MS = 5_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/// Operator reroute (admin UI): push a PARKED order onto the intent the
/// operator picked. Refuses when the order already has a live forward. The
/// pick still goes through `authorizeForward` — the operator chooses among
/// tenant-authorised intents, never a free address.
export type RerouteRefusal =
  | 'already_forwarded'
  | 'resolved_offrail'
  | 'unknown_sid'
  | 'not_processed'
  /// The picked intent already has its money (paid, late or underpaid) —
  /// a second transfer onto it would be silent (SR-02).
  | 'already_settled'
  /// Order amount ≠ intent amount. Allowed only with `force` + a reason, so
  /// 1 € can never flip a 500 € intent by two careless clicks (SR-02).
  | 'amount_mismatch';

export async function checkReroute(
  deps: ForwardDeps,
  order: MoneriumOrder,
  sid: string,
  opts: { force?: boolean } = {},
): Promise<RerouteRefusal | null> {
  if (order.kind !== 'issue' || (order.state ?? order.meta?.state) !== 'processed') {
    return 'not_processed';
  }
  const existing = await deps.getForwardByOrder(order.id);
  if (existing && LIVE.has(existing.status)) return 'already_forwarded';
  // Paid out by hand outside the rail: forwarding again would pay twice, out
  // of whatever other payments happen to be sitting in the Safe.
  if (existing?.status === 'resolved_offrail') return 'resolved_offrail';
  const intent = await deps.authorize.getIntentBySid(sid);
  if (!intent) return 'unknown_sid';
  if (intent.state === 'paid' || intent.monerium_order_id) return 'already_settled';
  if (!opts.force && intent.amount_cents !== parseAmountCents(order.amount)) return 'amount_mismatch';
  return null;
}

export async function rerouteParkedOrder(
  deps: ForwardDeps,
  order: MoneriumOrder,
  sid: string,
  opts: { force?: boolean } = {},
): Promise<'ok' | RerouteRefusal> {
  const refusal = await checkReroute(deps, order, sid, opts);
  if (refusal) return refusal;
  await handleForward(deps, order, { sid });
  return 'ok';
}

async function safely(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error(`forward park side-effect failed: ${(e as Error).message}`);
  }
}
