/**
 * /kartica — Gnosis Pay VISA kartica onboarding (Faza 1, docs/plans/gnosis-pay-cards/).
 *
 * Wizard je VOĐEN ISKLJUČIVO serverskim stanjem (useGpStore.step ← GET /user):
 * korisnik može zatvoriti app na bilo kojem koraku i nastaviti gdje je stao.
 * Plan A: GP identitet = korisnikov DOMOVINA Safe (passkey ERC-1271) — Safe
 * mora biti deployan prije prve prijave (pre-flight getCode, house rule).
 */
import { useEffect, useRef, useState } from 'react';
import {
  CreditCard,
  ExternalLink,
  IdCard,
  ListChecks,
  Phone,
  RefreshCw,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Card, Field, Input, Section, StatusPill, useToast } from '../ui';
import { useWalletStore } from '../state/store';
import { useGpStore, type GpStep } from '../state/gpStore';
import {
  clearGpJwt,
  getGpJwt,
  gpApi,
  GpApiError,
  GpAuthExpiredError,
  gpLogin,
  type GpSofQuestion,
} from '../lib/gnosispay';
import { isSafeDeployed } from '../lib/safe';

export function Kartica() {
  const safeAddress = useWalletStore((s) => s.safeAddress);
  const { step, refresh } = useGpStore();
  const { toast } = useToast();
  const [booting, setBooting] = useState(true);

  // Sesija iz ranije u ovom tabu? Sinkroniziraj stanje; inače ostani na 'anon'.
  useEffect(() => {
    (async () => {
      try {
        if (getGpJwt()) await refresh();
      } catch (e) {
        toast({ variant: 'error', title: 'Gnosis Pay nedostupan', description: msg(e) });
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // KYC u tijeku → tihi polling /user dok Sumsub ne završi.
  useEffect(() => {
    if (step !== 'kyc' && step !== 'kyc-pending') return;
    const t = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [step, refresh]);

  if (!safeAddress) return null;

  return (
    <Section
      title="VISA kartica"
      description="Besplatna virtualna Gnosis Pay VISA kartica — troši EURe sa svog računa na bilo kojem POS-u, uz Apple Pay / Google Pay."
    >
      <Stepper step={step} />
      {booting ? (
        <Spinner label="Provjeravam stanje…" />
      ) : (
        <StepBody step={step} />
      )}
    </Section>
  );
}

/* ── prikaz napretka: riječi, ne brojevi (counter-label pravilo) ─────────────── */

const STEP_LABELS: { match: GpStep[]; label: string }[] = [
  { match: ['anon'], label: 'Prijava' },
  { match: ['signup'], label: 'Registracija' },
  { match: ['terms'], label: 'Uvjeti' },
  { match: ['kyc', 'kyc-pending', 'kyc-action', 'kyc-rejected'], label: 'Identitet' },
  { match: ['sof'], label: 'Porijeklo sredstava' },
  { match: ['phone'], label: 'Telefon' },
  { match: ['deploy'], label: 'Otvaranje' },
  { match: ['ready'], label: 'Spremno' },
];

function Stepper({ step }: { step: GpStep }) {
  const activeIdx = STEP_LABELS.findIndex((s) => s.match.includes(step));
  return (
    <div className="flex flex-wrap gap-1.5">
      {STEP_LABELS.map((s, i) => (
        <span
          key={s.label}
          className={
            'rounded-pill px-2.5 py-1 text-[11px] font-medium transition ' +
            (i < activeIdx
              ? 'bg-surface-sunken text-ink-muted line-through decoration-1'
              : i === activeIdx
                ? 'bg-brand-navy-700 text-white'
                : 'bg-surface-sunken text-ink-muted')
          }
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

function StepBody({ step }: { step: GpStep }) {
  switch (step) {
    case 'anon':
      return <LoginStep />;
    case 'signup':
      return <SignupStep />;
    case 'terms':
      return <TermsStep />;
    case 'kyc':
      return <KycStep />;
    case 'kyc-pending':
      return (
        <Card padding="lg" className="flex flex-col items-center gap-3">
          <StatusPill tone="warning" dot pulse>
            Provjera u tijeku
          </StatusPill>
          <p className="text-sm text-ink-secondary text-center">
            Dokumenti su zaprimljeni — provjera obično traje par minuta, a najviše jedan radni
            dan. Slobodno zatvori ovu stranicu; nastavljamo gdje si stao.
          </p>
        </Card>
      );
    case 'kyc-action':
      return (
        <Card padding="lg" className="flex flex-col gap-3 border-amber-300">
          <p className="font-medium text-ink-primary">Potrebna je tvoja reakcija</p>
          <p className="text-sm text-ink-secondary">
            Provjera identiteta traži dopunu (npr. ponovno slikanje dokumenta) ili ručni
            pregled. Otvori provjeru ponovno ili kontaktiraj podršku Gnosis Paya.
          </p>
          <KycReopenButton />
        </Card>
      );
    case 'kyc-rejected':
      return (
        <Card padding="lg" className="flex flex-col gap-2 border-brand-red-500/40">
          <p className="font-medium text-ink-primary">Provjera identiteta odbijena</p>
          <p className="text-sm text-ink-secondary">
            Gnosis Pay je trajno odbio provjeru identiteta — kartica se za ovaj račun ne može
            otvoriti. Za detalje se obrati podršci Gnosis Paya (help.gnosispay.com).
          </p>
        </Card>
      );
    case 'sof':
      return <SofStep />;
    case 'phone':
      return <PhoneStep />;
    case 'deploy':
      return <DeployStep />;
    case 'ready':
      return <ReadyStep />;
  }
}

/* ── koraci ──────────────────────────────────────────────────────────────────── */

function LoginStep() {
  const safeAddress = useWalletStore((s) => s.safeAddress);
  const { refresh } = useGpStore();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [notDeployed, setNotDeployed] = useState(false);

  async function login() {
    setBusy(true);
    try {
      // Plan A preduvjet: ERC-1271 verifikacija zahtijeva deployani Safe
      // (counterfactual nema koda → potpis pada na GP strani).
      if (!safeAddress || !(await isSafeDeployed(safeAddress))) {
        setNotDeployed(true);
        return;
      }
      await gpLogin();
      await refresh();
    } catch (e) {
      toast({ variant: 'error', title: 'Prijava nije uspjela', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBubble>
          <CreditCard className="h-5 w-5" />
        </IconBubble>
        <div className="text-sm text-ink-secondary flex flex-col gap-2">
          <p>
            Karticu izdaje <strong>Gnosis Pay</strong> (VISA program, izdavatelj Monavate) —
            otvaraš je vlastitim računom, bez posrednika. Tvoj passkey ostaje jedini ključ.
          </p>
          <p>
            Trebat će ti: e-mail, osobna iskaznica ili putovnica (provjera identiteta) i broj
            mobitela.
          </p>
        </div>
      </div>
      {notDeployed ? (
        <Card padding="md" className="border-amber-300 text-sm text-ink-secondary">
          Račun još nije aktiviran na mreži. Otvori <strong>Postavke → Aktiviraj račun</strong>{' '}
          (ili pošalji bilo koju prvu transakciju) pa se vrati ovdje.
        </Card>
      ) : (
        <Button onClick={login} size="xl" block disabled={busy}>
          {busy ? <RefreshCw className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
          Prijavi se passkeyem
        </Button>
      )}
    </Card>
  );
}

function SignupStep() {
  const { refresh } = useGpStore();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      // OTP je trenutno "optional during transition period" (findings-faza0) —
      // probaj direktno; ako server zatraži kod, pošalji ga mailom i pokaži polje.
      await gpApi.signup(email.trim(), otpRequired ? otp.trim() : undefined);
      await refresh();
    } catch (e) {
      if (e instanceof GpApiError && /otp/i.test(msg(e))) {
        try {
          await gpApi.signupOtp(email.trim());
          setOtpRequired(true);
          toast({ variant: 'info', title: 'Kod poslan', description: `Provjeri ${email.trim()}` });
        } catch (e2) {
          toast({ variant: 'error', title: 'Slanje koda nije uspjelo', description: msg(e2) });
        }
      } else if (e instanceof GpApiError && e.status === 409) {
        toast({
          variant: 'error',
          title: 'Račun već postoji',
          description: 'Ova adresa ili e-mail su već vezani uz Gnosis Pay račun.',
        });
      } else {
        toast({ variant: 'error', title: 'Registracija nije uspjela', description: msg(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Gnosis Pay traži e-mail za račun kartice (obavijesti o transakcijama i podrška idu na
        njega).
      </p>
      <Field label="E-mail adresa">
        {(id) => (
          <Input
            id={id}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="ime@primjer.hr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </Field>
      {otpRequired && (
        <Field label="Kod iz e-maila" hint="Šesteroznamenkasti kod poslan na tvoju adresu">
          {(id) => (
            <Input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          )}
        </Field>
      )}
      <Button
        onClick={submit}
        size="lg"
        block
        disabled={busy || !emailOk || (otpRequired && otp.trim().length !== 6)}
      >
        {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
        Nastavi
      </Button>
    </Card>
  );
}

function TermsStep() {
  const { terms, refresh } = useGpStore();
  const { toast } = useToast();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const pending = (terms ?? []).filter((t) => !t.accepted);
  const allChecked = pending.every((t) => checked[t.type]);

  async function acceptAll() {
    setBusy(true);
    try {
      for (const t of pending) {
        try {
          await gpApi.acceptTerms(t.type, t.currentVersion);
        } catch (e) {
          // 422 "already accepted" (npr. general-tos se auto-prihvaća na signupu).
          if (!(e instanceof GpApiError && e.status === 422)) throw e;
        }
      }
      await refresh();
    } catch (e) {
      toast({ variant: 'error', title: 'Prihvaćanje nije uspjelo', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBubble>
          <ListChecks className="h-5 w-5" />
        </IconBubble>
        <p className="text-sm text-ink-secondary">
          Karticu reguliraju uvjeti Gnosis Paya i izdavatelja Monavate. Pročitaj i prihvati
          svaki dokument.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {pending.map((t) => (
          <label key={t.type} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-brand-navy-700"
              checked={!!checked[t.type]}
              onChange={(e) => setChecked((c) => ({ ...c, [t.type]: e.target.checked }))}
            />
            <span className="text-sm text-ink-secondary">
              Prihvaćam{' '}
              <a
                href={t.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-navy-600 underline underline-offset-2"
              >
                {termName(t.type, t.name)}
                <ExternalLink className="ml-1 inline h-3 w-3" />
              </a>
            </span>
          </label>
        ))}
      </div>
      <Button onClick={acceptAll} size="lg" block disabled={busy || !allChecked}>
        {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
        Prihvati i nastavi
      </Button>
    </Card>
  );
}

function termName(type: string, fallback?: string): string {
  switch (type) {
    case 'general-tos':
      return 'Uvjete korištenja Gnosis Paya';
    case 'card-monavate-tos':
      return 'Uvjete za korisnike Monavate kartice';
    case 'cashback-tos':
      return 'Uvjete cashback programa';
    case 'privacy-policy':
      return 'Pravila privatnosti Gnosis Paya';
    case 'monavate-privacy-policy':
      return 'Pravila privatnosti Monavatea';
    default:
      return fallback ?? type;
  }
}

function KycStep() {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const res = await gpApi.kycIntegration('hr');
      setUrl(res.url);
    } catch (e) {
      toast({ variant: 'error', title: 'Provjera nedostupna', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  if (url) {
    return (
      <div className="flex flex-col gap-3">
        <Card padding="none" elevation="elevated" className="overflow-hidden">
          {/* Sumsub WebSDK; kamera treba allow atribute. Na iOS PWA standalone
              modu getUserMedia zna biti blokiran → fallback link ispod. */}
          <iframe
            src={url}
            title="Provjera identiteta"
            allow="camera; microphone"
            className="h-[560px] w-full border-0 bg-white"
          />
        </Card>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="self-center text-xs text-ink-muted underline underline-offset-2"
        >
          Kamera ne radi? Otvori provjeru u Safariju / pregledniku
        </a>
        <p className="text-center text-xs text-ink-muted">
          Kad završiš, ovdje se sve nastavlja automatski.
        </p>
      </div>
    );
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBubble>
          <IdCard className="h-5 w-5" />
        </IconBubble>
        <div className="text-sm text-ink-secondary flex flex-col gap-2">
          <p>
            Kartica je regulirani platni proizvod, pa Gnosis Pay zakonski mora provjeriti tvoj
            identitet (KYC). Provjeru radi njihov partner Sumsub — treba ti osobna iskaznica
            ili putovnica i par minuta.
          </p>
          <p>
            Dokumenti idu izravno Gnosis Payu/Sumsubu — DOMOVINA wallet ih ne vidi i ne
            pohranjuje.
          </p>
        </div>
      </div>
      <Button onClick={start} size="xl" block disabled={busy}>
        {busy && <RefreshCw className="h-5 w-5 animate-spin" />}
        Pokreni provjeru identiteta
      </Button>
    </Card>
  );
}

function KycReopenButton() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="lg"
      block
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await gpApi.kycIntegration('hr');
          window.open(res.url, '_blank', 'noopener');
        } catch (e) {
          toast({ variant: 'error', title: 'Provjera nedostupna', description: msg(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      Otvori provjeru ponovno
    </Button>
  );
}

function SofStep() {
  const { refresh } = useGpStore();
  const { toast } = useToast();
  const [questions, setQuestions] = useState<GpSofQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    gpApi
      .sourceOfFundsQuestions()
      .then(setQuestions)
      .catch((e) => toast({ variant: 'error', title: 'Upitnik nedostupan', description: msg(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!questions) return <Spinner label="Učitavam upitnik…" />;

  const complete = questions.every((q) => (answers[q.question] ?? '').trim() !== '');

  async function submit() {
    setBusy(true);
    try {
      // Sve odgovore u JEDNOM POST-u, s tekstom pitanja (02-onboarding.md).
      await gpApi.submitSourceOfFunds(
        questions!.map((q) => ({ question: q.question, answer: answers[q.question].trim() })),
      );
      await refresh();
    } catch (e) {
      toast({ variant: 'error', title: 'Slanje nije uspjelo', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Regulatorna obveza izdavatelja: par kratkih pitanja o porijeklu sredstava kojima ćeš
        puniti karticu.
      </p>
      {questions.map((q) => (
        <Field key={q.question} label={q.question}>
          {(id) =>
            q.answers && q.answers.length > 0 ? (
              <select
                id={id}
                className="w-full rounded-2xl border border-surface-border bg-surface-base px-4 py-3 text-base text-ink-primary focus:border-brand-navy-500 focus:outline-none"
                value={answers[q.question] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: e.target.value }))}
              >
                <option value="" disabled>
                  Odaberi…
                </option>
                {q.answers.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={id}
                value={answers[q.question] ?? ''}
                onChange={(e) => setAnswers((an) => ({ ...an, [q.question]: e.target.value }))}
              />
            )
          }
        </Field>
      ))}
      <Button onClick={submit} size="lg" block disabled={busy || !complete}>
        {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
        Pošalji odgovore
      </Button>
    </Card>
  );
}

function PhoneStep() {
  const { refresh } = useGpStore();
  const { toast } = useToast();
  // type=text + inputMode (iOS decimal/comma lekcija vrijedi i za tel polja).
  const [phone, setPhone] = useState('+385');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'input' | 'code'>('input');
  const [busy, setBusy] = useState(false);

  async function sendSms() {
    setBusy(true);
    try {
      await gpApi.startPhoneVerification(phone.replace(/\s+/g, ''));
      setStage('code');
    } catch (e) {
      const m =
        e instanceof GpApiError && e.status === 429
          ? 'Previše pokušaja — pričekaj minutu pa pokušaj ponovno.'
          : msg(e);
      toast({ variant: 'error', title: 'SMS nije poslan', description: m });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    try {
      await gpApi.checkPhoneVerification(code.trim());
      await refresh();
    } catch (e) {
      toast({ variant: 'error', title: 'Kod nije prihvaćen', description: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBubble>
          <Phone className="h-5 w-5" />
        </IconBubble>
        <p className="text-sm text-ink-secondary">
          VISA mreža koristi tvoj broj kao drugi faktor kod online plaćanja, pa Gnosis Pay
          traži vlastitu SMS potvrdu — neovisno o verifikaciji broja u DOMOVINA walletu.
        </p>
      </div>
      {stage === 'input' ? (
        <>
          <Field label="Broj mobitela" hint="Međunarodni format, npr. +385 91 234 5678">
            {(id) => (
              <Input
                id={id}
                type="text"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            )}
          </Field>
          <Button
            onClick={sendSms}
            size="lg"
            block
            disabled={busy || !/^\+\d{8,15}$/.test(phone.replace(/\s+/g, ''))}
          >
            {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
            Pošalji SMS kod
          </Button>
        </>
      ) : (
        <>
          <Field label="Kod iz SMS-a">
            {(id) => (
              <Input
                id={id}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <Button onClick={verify} size="lg" block disabled={busy || code.trim().length < 4}>
            {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
            Potvrdi kod
          </Button>
          <button
            type="button"
            onClick={() => setStage('input')}
            className="self-center text-xs text-ink-muted underline underline-offset-2"
          >
            Promijeni broj / pošalji ponovno
          </button>
        </>
      )}
    </Card>
  );
}

function DeployStep() {
  const { refresh } = useGpStore();
  const { toast } = useToast();
  const [deploying, setDeploying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => clearInterval(pollRef.current ?? undefined), []);

  async function deploy() {
    setDeploying(true);
    try {
      // Bez dailyLimit → GP default 350 €. Konačni default je odluka u
      // TODO-MATIJA #7; limit se ionako mijenja kasnije (Faza 2 UI).
      await gpApi.deploySafe();
      pollRef.current = setInterval(async () => {
        try {
          const [dep, cfg] = await Promise.all([gpApi.deployStatus(), gpApi.safeConfig()]);
          // accountStatus: 0 = Ok, 7 = DelayQueueNotEmpty (validan); null prije deploya.
          if (dep.status === 'ok' && (cfg.accountStatus === 0 || cfg.accountStatus === 7)) {
            clearInterval(pollRef.current ?? undefined);
            await refresh();
          } else if (dep.status === 'failed') {
            clearInterval(pollRef.current ?? undefined);
            setDeploying(false);
            toast({
              variant: 'error',
              title: 'Otvaranje računa nije uspjelo',
              description: 'Pokušaj ponovno — postupak je siguran za ponavljanje.',
            });
          }
        } catch {
          /* prolazna greška — sljedeći tick */
        }
      }, 4000);
    } catch (e) {
      setDeploying(false);
      toast({ variant: 'error', title: 'Otvaranje nije pokrenuto', description: msg(e) });
    }
  }

  if (deploying) {
    return (
      <Card padding="lg" className="flex flex-col items-center gap-3">
        <StatusPill tone="info" dot pulse>
          Otvaram račun kartice
        </StatusPill>
        <p className="text-sm text-ink-secondary text-center">
          Gnosis Pay postavlja tvoj kartični račun na Gnosis mreži (bez troška za tebe) —
          obično traje do minute.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBubble>
          <Rocket className="h-5 w-5" />
        </IconBubble>
        <p className="text-sm text-ink-secondary">
          Sve provjere su gotove. Zadnji korak otvara tvoj kartični račun — zaseban račun na
          Gnosis mreži s kojeg kartica troši, a koji puniš prijenosom EURe sa svog DOMOVINA
          računa (i u svakom trenutku povlačiš natrag).
        </p>
      </div>
      <Button onClick={deploy} size="xl" block>
        <CreditCard className="h-5 w-5" />
        Otvori račun kartice
      </Button>
    </Card>
  );
}

function ReadyStep() {
  const { user } = useGpStore();
  const gpSafe = user?.safeWallets[0]?.address;
  return (
    <Card padding="lg" elevation="elevated" className="flex flex-col items-center gap-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
        <CreditCard className="h-6 w-6" />
      </div>
      <div className="text-center">
        <p className="font-semibold text-ink-primary">Kartični račun je otvoren</p>
        {gpSafe && (
          <p className="mt-1 font-mono text-xs text-ink-secondary break-all">{gpSafe}</p>
        )}
      </div>
      <Badge tone="info">Izdavanje kartice stiže u sljedećoj nadogradnji</Badge>
      <p className="text-xs text-ink-muted text-center">
        Do tada karticu možeš izdati i vidjeti na app.gnosispay.com — prijava istim računom
        (passkey).
      </p>
    </Card>
  );
}

/* ── sitnice ─────────────────────────────────────────────────────────────────── */

function IconBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
      {children}
    </div>
  );
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
  if (e instanceof GpAuthExpiredError) return 'Prijava je istekla — prijavi se ponovno.';
  if (e instanceof Error) return e.message;
  return String(e);
}

// Sesija je u memoriji taba; eksplicitna odjava za Settings (kasnije).
export function gpLogout(): void {
  clearGpJwt();
  useGpStore.getState().reset();
}
