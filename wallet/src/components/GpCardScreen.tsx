/**
 * Ekran žive kartice (Faza 2) — renderira se u /kartica kad je GP account
 * spreman (step 'ready'). Sve operacije idu direktno na api.gnosispay.com s
 * user JWT-om; Delay-module operacije (povlačenje, limit, drugi owner)
 * potpisuje passkey kao Safe ERC-1271 (signGpModuleTx).
 *
 * Postmortem-0001 gate: dok GP account nema ≥2 Delay-ownera, punjenje je
 * ograničeno na preset iznose ≤ 50 € — gubitak passkeya tada smije zarobiti
 * najviše "džeparac", ne štednju.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CreditCard,
  ExternalLink,
  KeyRound,
  Lock,
  LockOpen,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { Button, Card, Input, Section, StatusPill, useToast } from '../ui';
import { useWalletStore } from '../state/store';
import {
  gpApi,
  GpApiError,
  resolveGpSafeAddress,
  signGpModuleTx,
  type GpBalances,
  type GpCard,
  type GpCardTxEvent,
  type GpDelayTx,
} from '../lib/gnosispay';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { parseAmount } from '../lib/amount';

/** Postmortem-0001: max kumulativni preset bez drugog Delay-ownera. */
const PRESETS_EUR = [10, 25, 50];

export function GpCardScreen() {
  const [cards, setCards] = useState<GpCard[] | null>(null);
  const [balances, setBalances] = useState<GpBalances | null>(null);
  const [owners, setOwners] = useState<Address[] | null>(null);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    const [c, b, o] = await Promise.allSettled([gpApi.cards(), gpApi.balances(), gpApi.owners()]);
    if (c.status === 'fulfilled') setCards(c.value);
    else if (c.reason instanceof GpApiError && c.reason.status === 404) setCards([]);
    if (b.status === 'fulfilled') setBalances(b.value);
    if (o.status === 'fulfilled') setOwners(o.value.data.owners);
  }, []);

  useEffect(() => {
    reload().catch((e) =>
      toast({ variant: 'error', title: 'Učitavanje nije uspjelo', description: msg(e) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasSecondOwner = (owners?.length ?? 0) >= 2;

  return (
    <div className="flex flex-col gap-6">
      <BalanceCard balances={balances} />
      <CardsSection cards={cards} onChanged={reload} />
      <FundSection unlocked={hasSecondOwner} />
      <WithdrawSection balances={balances} />
      {owners !== null && !hasSecondOwner && <SecondOwnerSection onAdded={reload} />}
      <LimitSection />
      <CardActivitySection />
    </div>
  );
}

/* ── balans ──────────────────────────────────────────────────────────────────── */

function BalanceCard({ balances }: { balances: GpBalances | null }) {
  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-widest text-ink-muted">
        Raspoloživo na kartici
      </span>
      <span className="text-3xl font-bold text-ink-primary tabular">
        {balances ? `${fmtEure(balances.spendable)} €` : '—'}
      </span>
      {balances && BigInt(balances.pending) > 0n && (
        <span className="text-xs text-ink-muted">
          + {fmtEure(balances.pending)} € rezervirano (autorizacije u tijeku)
        </span>
      )}
    </Card>
  );
}

/* ── kartice ─────────────────────────────────────────────────────────────────── */

function CardsSection({ cards, onChanged }: { cards: GpCard[] | null; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      toast({ variant: 'error', title: 'Akcija nije uspjela', description: msg(e) });
    } finally {
      setBusy(null);
    }
  }

  if (cards === null) return <Spinner label="Učitavam kartice…" />;

  const active = cards.filter((c) => ![1009, 1199, 1041, 1043, 1054, 1154].includes(c.statusCode));

  return (
    <Section title="Kartice">
      <div className="flex flex-col gap-3">
        {active.map((c) => {
          const frozen = c.statusCode === 1006 || c.statusName?.toLowerCase().includes('frozen');
          return (
            <Card key={c.id} padding="md" className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded-lg bg-brand-navy-700 text-white">
                  <CreditCard className="h-5 w-5" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="font-mono text-sm text-ink-primary">
                    •••• {c.lastFourDigits}
                  </span>
                  <span className="text-[11px] text-ink-muted">
                    {c.virtual ? 'Virtualna' : 'Fizička'} · {frozen ? 'Zamrznuta' : 'Aktivna'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      c.id,
                      () => (frozen ? gpApi.unfreezeCard(c.id) : gpApi.freezeCard(c.id)),
                    )
                  }
                  title={frozen ? 'Odmrzni' : 'Zamrzni'}
                >
                  {frozen ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                </Button>
                {c.virtual && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(
                        `void-${c.id}`,
                        () => gpApi.voidCard(c.id),
                        `Trajno poništi karticu •••• ${c.lastFourDigits}? Ovo se ne može vratiti.`,
                      )
                    }
                    title="Poništi karticu (trajno)"
                  >
                    <Trash2 className="h-4 w-4 text-brand-red-600" />
                  </Button>
                )}
              </div>
            </Card>
          );
        })}

        {active.length === 0 && (
          <Card padding="md" className="text-sm text-ink-secondary">
            Nemaš aktivnu karticu — izdaj prvu (besplatno, odmah aktivna).
          </Card>
        )}

        <Button
          size="lg"
          block
          variant={active.length === 0 ? 'primary' : 'secondary'}
          disabled={busy !== null}
          onClick={() =>
            act('create', async () => {
              await gpApi.createVirtualCard();
              toast({ variant: 'success', title: 'Kartica izdana ✓' });
            })
          }
        >
          {busy === 'create' ? (
            <RefreshCw className="h-5 w-5 animate-spin" />
          ) : (
            <CreditCard className="h-5 w-5" />
          )}
          Izdaj virtualnu karticu
        </Button>
        <p className="text-center text-xs text-ink-muted">
          Broj kartice (PAN/CVV) zasad vidiš na app.gnosispay.com — prijava istim passkeyem.
          Prikaz u walletu stiže s partner integracijom.
        </p>
      </div>
    </Section>
  );
}

/* ── punjenje ────────────────────────────────────────────────────────────────── */

function FundSection({ unlocked }: { unlocked: boolean }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  async function fund(amountEur: string) {
    setBusy(true);
    try {
      // Svježa adresa pri SVAKOM punjenju (GP safe-replacement migracije).
      const gpSafe = await resolveGpSafeAddress();
      if (!gpSafe) throw new Error('GP račun nema adresu — pokušaj ponovno.');
      // Postojeći Send flow (passkey → relay → MultiSend) s prefillom. Šaljemo
      // isključivo EURe V2 — jedino što wallet drži; account-kit primjer još
      // citira V1, pa do empirijske potvrde (GP call / prvi e2e) vrijedi
      // small-amounts gate ispod.
      setLocation(`/send?to=${gpSafe}&amount=${amountEur}`);
    } catch (e) {
      toast({ variant: 'error', title: 'Punjenje nije moguće', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  const parsedCustom = parseAmount(custom);

  return (
    <Section
      title="Napuni karticu"
      description="Prijenos EURe s tvog računa na račun kartice — bez naknade, traje sekunde."
    >
      <Card padding="md" className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          {PRESETS_EUR.map((v) => (
            <Button
              key={v}
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => fund(String(v))}
            >
              {v} €
            </Button>
          ))}
        </div>
        {unlocked ? (
          <div className="flex gap-2">
            <Input
              type="text"
              inputMode="decimal"
              placeholder="Drugi iznos (€)"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button
              size="lg"
              disabled={busy || !parsedCustom.ok}
              onClick={() => fund(custom.replace(',', '.'))}
            >
              <ArrowUpFromLine className="h-5 w-5" />
            </Button>
          </div>
        ) : (
          <p className="text-xs text-ink-muted">
            Veći iznosi se otključavaju kad dodaš rezervni ključ kartičnog računa (ispod) — da
            gubitak passkeya nikad ne zarobi sredstva.
          </p>
        )}
      </Card>
    </Section>
  );
}

/* ── povlačenje ──────────────────────────────────────────────────────────────── */

function WithdrawSection({ balances }: { balances: GpBalances | null }) {
  const safeAddress = useWalletStore((s) => s.safeAddress);
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState<GpDelayTx | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => clearInterval(pollRef.current ?? undefined), []);

  async function withdraw() {
    if (!safeAddress) return;
    const parsed = parseAmount(amount);
    if (!parsed.ok) return;
    setBusy(true);
    try {
      const wei = parseUnits(amount.replace(',', '.'), EURE_DECIMALS);
      const { data: typedData } = await gpApi.withdrawTransactionData(
        EURE_ADDRESS,
        safeAddress,
        wei,
      );
      const signed = await signGpModuleTx(typedData);
      const { data: tx } = await gpApi.withdraw({
        tokenAddress: EURE_ADDRESS,
        to: safeAddress,
        amount: wei,
        ...signed,
      });
      setPending(tx);
      setAmount('');
      pollRef.current = setInterval(async () => {
        try {
          const list = await gpApi.delayRelay();
          const cur = list.find((d) => d.id === tx.id);
          if (cur) setPending(cur);
          if (cur?.status === 'EXECUTED' || cur?.status === 'FAILED') {
            clearInterval(pollRef.current ?? undefined);
            if (cur.status === 'EXECUTED') {
              toast({ variant: 'success', title: 'Sredstva su na tvom računu ✓' });
              setPending(null);
            }
          }
        } catch {
          /* sljedeći tick */
        }
      }, 10_000);
    } catch (e) {
      toast({ variant: 'error', title: 'Povlačenje nije uspjelo', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <Section title="Vrati na svoj račun">
        <Card padding="md" className="flex flex-col items-center gap-2">
          <StatusPill tone={pending.status === 'FAILED' ? 'danger' : 'info'} dot pulse={pending.status !== 'FAILED'}>
            {pending.status === 'FAILED' ? 'Nije uspjelo' : 'Sigurnosna odgoda u tijeku'}
          </StatusPill>
          <p className="text-xs text-ink-secondary text-center">
            Povlačenje se izvršava nakon ~3 minute (zaštitni mehanizam računa). Kartice su
            zamrznute dok odgoda traje.
          </p>
          {pending.status === 'FAILED' && (
            <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
              Pokušaj ponovno
            </Button>
          )}
        </Card>
      </Section>
    );
  }

  return (
    <Section
      title="Vrati na svoj račun"
      description="Povuci EURe s kartice natrag — izvršava se nakon 3 min, kartica je u međuvremenu zamrznuta."
    >
      <Card padding="md" className="flex gap-2">
        <Input
          type="text"
          inputMode="decimal"
          placeholder="Iznos (€)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button
          size="lg"
          variant="secondary"
          disabled={
            busy ||
            !parseAmount(amount).ok ||
            !balances ||
            parseUnitsSafe(amount) > BigInt(balances.spendable)
          }
          onClick={withdraw}
        >
          {busy ? <RefreshCw className="h-5 w-5 animate-spin" /> : <ArrowDownToLine className="h-5 w-5" />}
        </Button>
      </Card>
    </Section>
  );
}

/* ── drugi Delay-owner (postmortem-0001 gate) ───────────────────────────────── */

function SecondOwnerSection({ onAdded }: { onAdded: () => Promise<void> }) {
  const recoveryOwner = useWalletStore((s) => s.recoveryOwner);
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  async function addOwner() {
    if (!recoveryOwner) return;
    setBusy(true);
    try {
      const { data: typedData } = await gpApi.addOwnerTransactionData(recoveryOwner);
      const signed = await signGpModuleTx(typedData);
      await gpApi.addOwner({ newOwner: recoveryOwner, ...signed });
      setPending(true);
      // Owner postaje vidljiv nakon 3-min delaya; osvježi listu kasnije.
      setTimeout(() => void onAdded(), 200_000);
    } catch (e) {
      toast({ variant: 'error', title: 'Dodavanje nije uspjelo', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Sigurnost kartičnog računa">
      <Card padding="md" className="flex items-start gap-3 border-amber-300">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="flex-1 flex flex-col gap-2">
          <div>
            <p className="font-medium text-ink-primary">Dodaj rezervni ključ</p>
            <p className="text-sm text-ink-secondary">
              Kartičnim računom sad upravlja samo tvoj passkey. Dodaj i svoj rezervni ključ
              (isti koji čuva tvoj DOMOVINA račun) — da gubitak passkeya nikad ne zarobi
              sredstva na kartici. Do tada je punjenje ograničeno na manje iznose.
            </p>
          </div>
          {pending ? (
            <StatusPill tone="info" dot pulse>
              Dodavanje u tijeku (~3 min)
            </StatusPill>
          ) : recoveryOwner ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={addOwner}>
              {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
              Dodaj rezervni ključ
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">
              Ovaj račun još nema rezervni ključ — postavi ga prvo kroz{' '}
              <strong>Postavke → Proširi pristup</strong>, pa se vrati ovdje.
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

/* ── dnevni limit ────────────────────────────────────────────────────────────── */

function LimitSection() {
  const { toast } = useToast();
  const [limit, setLimit] = useState<{ dailyLimit: number; dailyRemaining: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [newLimit, setNewLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingChange, setPendingChange] = useState(false);

  useEffect(() => {
    gpApi
      .dailyLimit()
      .then((r) => setLimit(r.data))
      .catch(() => {});
  }, []);

  async function save() {
    const n = Number(newLimit);
    if (!Number.isInteger(n) || n < 1 || n > 8000) return;
    setBusy(true);
    try {
      const { data: typedData } = await gpApi.dailyLimitTransactionData(n);
      const signed = await signGpModuleTx(typedData);
      await gpApi.setDailyLimit({ newLimit: n, ...signed });
      setPendingChange(true);
      setEditing(false);
      toast({
        variant: 'success',
        title: 'Promjena limita pokrenuta',
        description: 'Vrijedi za ~3 minute (sigurnosna odgoda).',
      });
    } catch (e) {
      toast({ variant: 'error', title: 'Promjena nije uspjela', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Dnevni limit potrošnje">
      <Card padding="md" className="flex items-center justify-between gap-3">
        <div className="flex flex-col leading-tight">
          <span className="text-lg font-semibold text-ink-primary tabular">
            {limit ? `${limit.dailyLimit} €` : '—'}
          </span>
          {limit && (
            <span className="text-[11px] text-ink-muted">
              Preostalo danas: {limit.dailyRemaining} €
            </span>
          )}
          {pendingChange && (
            <span className="text-[11px] text-amber-600">Promjena u tijeku (~3 min)</span>
          )}
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              placeholder="npr. 200"
              className="w-24"
              value={newLimit}
              onChange={(e) => setNewLimit(e.target.value)}
            />
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Spremi'}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Promijeni
          </Button>
        )}
      </Card>
    </Section>
  );
}

/* ── kartična aktivnost ──────────────────────────────────────────────────────── */

function CardActivitySection() {
  const [events, setEvents] = useState<GpCardTxEvent[] | null>(null);

  useEffect(() => {
    gpApi
      .cardTransactions(25)
      .then((r) => setEvents(r.results))
      .catch(() => setEvents([]));
  }, []);

  if (events === null) return <Spinner label="Učitavam transakcije…" />;
  if (events.length === 0) return null;

  return (
    <Section title="Kartične transakcije">
      <Card padding="sm" className="flex flex-col divide-y divide-surface-border">
        {events.map((e) => {
          const sign = e.kind === 'Payment' ? '−' : '+';
          const declined = e.kind === 'Payment' && e.status && e.status !== 'Approved';
          const hash = e.transactions?.find((t) => t.hash)?.hash;
          return (
            <div
              key={`${e.threadId}-${e.createdAt}`}
              className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1"
            >
              <div className="flex flex-col leading-tight min-w-0">
                <span className="text-sm font-medium text-ink-primary truncate">
                  {e.merchant?.name ?? (e.kind === 'Refund' ? 'Povrat' : 'Transakcija')}
                </span>
                <span className="text-[11px] text-ink-muted">
                  {new Date(e.createdAt).toLocaleString('hr-HR', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {e.isPending && ' · u obradi'}
                  {declined && ` · odbijeno`}
                  {hash && (
                    <>
                      {' · '}
                      <a
                        href={`https://gnosisscan.io/tx/${hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        Gnosisscan
                        <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                      </a>
                    </>
                  )}
                </span>
              </div>
              <span
                className={
                  'shrink-0 font-mono text-sm tabular ' +
                  (declined
                    ? 'text-ink-muted line-through'
                    : e.kind === 'Payment'
                      ? 'text-ink-primary'
                      : 'text-emerald-600')
                }
              >
                {sign}
                {fmtMinor(e.billingAmount, e.billingCurrency.decimals)}{' '}
                {e.billingCurrency.symbol ?? e.billingCurrency.code}
              </span>
            </div>
          );
        })}
      </Card>
      {events.some((e) => e.kind === 'Payment' && e.isPending) && (
        <p className="text-xs text-ink-muted">
          Transakcije „u obradi" su autorizacije — konačni iznos sjeda u 24–48 h.
        </p>
      )}
    </Section>
  );
}

/* ── helperi ─────────────────────────────────────────────────────────────────── */

function fmtEure(baseUnits: string): string {
  const n = Number(formatUnits(BigInt(baseUnits), EURE_DECIMALS));
  return n.toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Minor-units string (npr. '2550' + 2 → "25,50"). */
function fmtMinor(minor: string, decimals: number): string {
  const n = Number(minor) / 10 ** decimals;
  return n.toLocaleString('hr-HR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function parseUnitsSafe(raw: string): bigint {
  try {
    return parseUnits(raw.replace(',', '.'), EURE_DECIMALS);
  } catch {
    return 0n;
  }
}

function Spinner({ label }: { label: string }) {
  return (
    <Card padding="md" className="flex items-center justify-center gap-2">
      <RefreshCw className="h-4 w-4 animate-spin text-ink-muted" />
      <span className="text-sm text-ink-secondary">{label}</span>
    </Card>
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
