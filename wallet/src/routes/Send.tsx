import { useEffect, useRef, useState } from 'react';
import { parseUnits, encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem';
import { ClipboardPaste, ExternalLink, Fingerprint, ScanLine } from 'lucide-react';
import {
  AddressInput,
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Section,
  useToast,
} from '../ui';
import { ScannerSheet } from '../components/ScannerSheet';
import { RecipientChips } from '../components/RecipientChips';
import { AddressBookSheet } from '../components/AddressBookSheet';
import { decodeQR } from '../lib/eip681';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';
import { parseAmount, isAmountInvalidForDisplay } from '../lib/amount';
import { addRecipient, listRecentRecipients, type Recipient } from '../lib/recipients';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { encodeWebAuthnSignature, getSafeTxHash } from '../lib/safe';
import { getActivePasskey, recordRpId, savePasskey, signWithPasskey, type PasskeyRecord } from '../lib/passkey';
import { lookupWallet } from '../lib/registry';
import { relayTx, getRelayStatus, type RelayStatus } from '../lib/relay';
import { getEureBalance } from '../lib/balance';

export function Send() {
  const { safeAddress, credentialId, signerAddress, balance, setBalance, saltNonce, recoveryOwner, accountKind } =
    useWalletStore();
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [recents, setRecents] = useState<Recipient[]>(() => listRecentRecipients(5));
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [, setNowTick] = useState(0); // re-render every minute for countdown
  const sendInFlightRef = useRef(false);

  // Pull a fresh balance on mount when the store is empty (deep-link to /send
  // without going through Home first). The store is populated by Wallet.tsx
  // when the user goes home, but a direct /send open would otherwise show "—"
  // next to the Max chip until the user navigates back.
  useEffect(() => {
    if (!safeAddress || balance !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const { formatted } = await getEureBalance(safeAddress);
        if (!cancelled) setBalance(formatted);
      } catch {
        /* ignore — balance label will just show "—" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [safeAddress, balance, setBalance]);

  // Fetch relay free-tier counter on mount + every 60s + after each send.
  useEffect(() => {
    if (!signerAddress) return;
    let cancelled = false;
    async function fetchStatus() {
      const status = await getRelayStatus(signerAddress!);
      if (!cancelled && status) setRelayStatus(status);
    }
    fetchStatus();
    const id = setInterval(() => {
      fetchStatus();
      setNowTick((t) => t + 1);
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [signerAddress]);

  const numericBalance = balance === null ? null : Number(balance);
  const hasBalance = numericBalance !== null && isFinite(numericBalance) && numericBalance > 0;

  function fillMaxAmount() {
    if (balance === null) return;
    // Use the EXACT formatUnits decimal string (NOT Number(balance), whose float
    // round-trip can round Max ABOVE the real balance → guaranteed revert). Trim
    // trailing zeros so "0,5" reads naturally instead of "0,500000000000000000".
    let max = balance;
    if (max.includes('.')) max = max.replace(/0+$/, '').replace(/\.$/, '');
    if (max === '' || max === '0') return;
    setAmount(max.replace('.', ','));
    haptic('tap');
  }

  async function refreshRelayStatus() {
    if (!signerAddress) return;
    const status = await getRelayStatus(signerAddress);
    if (status) setRelayStatus(status);
  }

  // Filter out the current input value so we don't show "Nedavno" for the
  // address the user is already targeting.
  const visibleRecents = recents.filter(
    (r) => r.address.toLowerCase() !== to.toLowerCase(),
  );

  // Refresh recents when navigating back to /send (browser back, etc.) — the
  // localStorage may have been updated by a successful Send mid-session.
  // Also: parse `?to=` and `?amount=` so a shareable link from /receive opens
  // here pre-filled. Strips the query from the URL once consumed so a refresh
  // doesn't keep re-prefilling and clobbering edits.
  useEffect(() => {
    setRecents(listRecentRecipients(5));

    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const linkTo = params.get('to');
    const linkAmount = params.get('amount');
    if (!linkTo && !linkAmount) return;

    let prefilled = false;
    if (linkTo && isAddress(linkTo)) {
      setTo(linkTo);
      prefilled = true;
    }
    if (linkAmount) {
      // Accept either dot or comma in shared links; render in user locale.
      const cleaned = linkAmount.replace(',', '.');
      if (/^\d+(\.\d+)?$/.test(cleaned)) {
        setAmount(cleaned.replace('.', ','));
        prefilled = true;
      }
    }
    if (prefilled) {
      haptic('success');
      toast({
        variant: 'success',
        title: 'Transakcija prefiltirana',
        description: linkTo && isAddress(linkTo) ? `${linkTo.slice(0, 6)}…${linkTo.slice(-4)}` : undefined,
      });
      // Clean the URL so a refresh starts blank.
      window.history.replaceState({}, '', '/send');
    }
  }, []);

  function handleScanResult(raw: string) {
    const decoded = decodeQR(raw);
    if (decoded.kind === 'unsupported') {
      toast({ variant: 'error', title: 'QR nije podržan', description: decoded.reason });
      setScanOpen(false);
      return;
    }
    setTo(decoded.recipient);
    if (decoded.kind === 'eure-gnosis' && decoded.amountDecimal) {
      // Convert canonical "1.5" → user-locale "1,5" so the field reads natural.
      setAmount(decoded.amountDecimal.replace('.', ','));
    }
    setScanOpen(false);
    haptic('success');
    toast({
      variant: 'success',
      title: 'QR skeniran',
      description:
        decoded.kind === 'eure-gnosis' && decoded.amountDecimal
          ? `${decoded.amountDecimal} EURe → ${decoded.recipient.slice(0, 6)}…${decoded.recipient.slice(-4)}`
          : `${decoded.recipient.slice(0, 6)}…${decoded.recipient.slice(-4)}`,
    });
  }

  const addressLooksValid = to.length === 0 || isAddress(to);
  const parsedAmount = parseAmount(amount);
  const amountShowsError = isAmountInvalidForDisplay(amount);
  // Treat unknown (status not yet loaded) as remaining > 0 so we never block
  // a user before we even know the real count. Server enforces the hard limit.
  const quotaExhausted = relayStatus !== null && relayStatus.remaining === 0;

  // Insufficient-balance + self-send guards (bigint, no float). Without these a
  // user can burn a Face ID ceremony + a free relay slot on a doomed transfer.
  const overBalance =
    parsedAmount.ok && balance !== null
      ? (() => {
          try {
            return parseUnits(parsedAmount.normalized, EURE_DECIMALS) > parseUnits(balance, EURE_DECIMALS);
          } catch {
            return false;
          }
        })()
      : false;
  const isSelfSend = isAddress(to) && !!safeAddress && to.toLowerCase() === safeAddress.toLowerCase();

  const valid =
    isAddress(to) && parsedAmount.ok && !quotaExhausted && !overBalance && !isSelfSend;

  let amountErrorMsg: string | undefined;
  if (amountShowsError && !parsedAmount.ok) {
    amountErrorMsg =
      parsedAmount.reason === 'zero'
        ? 'Iznos mora biti veći od 0'
        : parsedAmount.reason === 'decimals'
          ? 'Najviše 18 decimala'
          : 'Iznos nije valjan broj';
  } else if (overBalance) {
    amountErrorMsg = 'Nedovoljno stanje';
  }
  const recipientErrorMsg = !addressLooksValid
    ? 'Adresa nije valjana'
    : isSelfSend
      ? 'To je tvoja vlastita adresa'
      : undefined;

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setTo(text.trim());
    } catch (e) {
      toast({ variant: 'error', title: humanizeError(e, 'clipboard') });
    }
  }

  async function send() {
    if (sendInFlightRef.current) {
      console.warn('[Send] duplicate invocation IGNORED — send() is already in flight');
      return;
    }
    sendInFlightRef.current = true;
    console.log('[Send] step 1: enter send()', {
      safeAddress,
      credentialId,
      signerAddress,
      to,
      amount,
    });
    if (!safeAddress || !credentialId || !signerAddress) {
      sendInFlightRef.current = false;
      console.warn('[Send] missing identity, abort');
      return;
    }
    let passkey = getActivePasskey();
    if (!passkey) {
      console.warn('[Send] no active passkey');
      sendInFlightRef.current = false;
      setError('No active passkey on this device — re-open wallet.');
      return;
    }
    // Belt-and-suspenders: Landing.openKnown should have already healed any
    // stub pubKey, but a session that started before that landed (e.g. the
    // app was just upgraded and the user is mid-flow) could still carry the
    // stub. Refetch from backend so the relay's stub-0 guard doesn't fire.
    if (passkey.pubKey.x === '0' || passkey.pubKey.y === '0') {
      console.warn('[Send] stub pubKey at send time — refetching');
      const remote = await lookupWallet(passkey.credentialId);
      if (remote && remote.pub_key_x !== '0' && remote.pub_key_y !== '0') {
        const healed: PasskeyRecord = {
          ...passkey,
          pubKey: { x: remote.pub_key_x, y: remote.pub_key_y },
          rpId: passkey.rpId ?? remote.rp_id,
        };
        savePasskey(healed);
        passkey = healed;
      }
    }
    console.log('[Send] step 2: loaded active passkey', {
      credentialId: passkey.credentialId,
      pubKeyX: passkey.pubKey.x.slice(0, 18) + '…',
    });
    if (!parsedAmount.ok) {
      sendInFlightRef.current = false;
      setError('Iznos nije valjan broj.');
      return;
    }
    setError(null);
    setTxHash(null);
    setBusy(true);
    haptic('tap');
    try {
      const value = parseUnits(parsedAmount.normalized, EURE_DECIMALS);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to as Address, value],
      });
      console.log('[Send] step 3: built transfer calldata', { value: value.toString(), dataLen: data.length });

      console.log('[Send] step 4: calling getSafeTxHash…');
      const { hash: safeTxHash, fields } = await getSafeTxHash(safeAddress, {
        to: EURE_ADDRESS,
        value: 0n,
        data,
      });
      console.log('[Send] step 5: got safeTxHash', { safeTxHash, nonce: fields.nonce.toString() });

      console.log('[Send] step 6: calling signWithPasskey (will open FaceID)…');
      const assertion = await signWithPasskey(credentialId, hexToBytes(safeTxHash), recordRpId(passkey));
      console.log('[Send] step 7: got passkey assertion', {
        authenticatorDataLen: assertion.authenticatorData.length,
        clientDataJSONLen: assertion.clientDataJSON.length,
        signatureLen: assertion.signature.length,
      });

      console.log('[Send] step 8: encoding WebAuthn signature…');
      const signature = encodeWebAuthnSignature({ ...assertion, signerAddress });
      console.log('[Send] step 9: signature encoded', { signatureLen: signature.length });

      console.log('[Send] step 10: POST /api/relay…');
      // ADR 0013: a DERIVED account is a counterfactual 1-of-2 [signer,
      // recoveryOwner] Safe — pass its saltNonce + recoveryOwner so the relay's
      // cold path deploys the matching 2-owner Safe on first send. A BOOTSTRAP
      // account is already deployed (hot path) and needs neither — omit both so
      // its behaviour is byte-for-byte what it was before this slice.
      const derived = accountKind === 'derived';
      const result = await relayTx({
        safeAddress,
        signerAddress,
        pubKeyX: passkey.pubKey.x,
        pubKeyY: passkey.pubKey.y,
        to: EURE_ADDRESS,
        value: '0',
        data,
        signature,
        ...(derived && saltNonce != null ? { saltNonce } : {}),
        ...(derived && recoveryOwner ? { recoveryOwner } : {}),
      });
      console.log('[Send] step 11: relay result', result);

      if (!result.ok) {
        throw new Error(result.rateLimited ? 'Dosegao si dnevni limit (5 besplatnih).' : result.error);
      }
      setTxHash(result.txHash);
      addRecipient(to);
      setRecents(listRecentRecipients(5));
      void refreshRelayStatus();
      toast({ variant: 'success', title: 'Poslano ✓', description: `${parsedAmount.normalized} EURe → ${shortAddr(to)}` });
    } catch (e) {
      console.error('[Send] FAILED', e);
      const friendly = humanizeError(e, 'passkey');
      setError(friendly);
      toast({ variant: 'error', title: 'Slanje neuspješno', description: friendly });
    } finally {
      setBusy(false);
      sendInFlightRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Pošalji EURe" description="Na Gnosis Chain, bez gas-a za tebe">
        <Card className="flex flex-col gap-5">
          <RecipientChips
            recipients={visibleRecents}
            onPick={(addr) => {
              haptic('tap');
              setTo(addr);
            }}
            onEdit={() => setBookOpen(true)}
          />
          <Field
            label="Primatelj"
            hint="Gnosis Chain · EVM adresa"
            error={recipientErrorMsg}
          >
            {() => (
              <AddressInput
                value={to}
                onChange={(e) => setTo(e.target.value)}
                invalid={!addressLooksValid || isSelfSend}
                trailing={
                  <div className="flex gap-0.5">
                    <IconButton
                      aria-label="Skeniraj QR"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        haptic('tap');
                        setScanOpen(true);
                      }}
                    >
                      <ScanLine />
                    </IconButton>
                    <IconButton aria-label="Zalijepi" size="sm" variant="ghost" onClick={paste}>
                      <ClipboardPaste />
                    </IconButton>
                  </div>
                }
              />
            )}
          </Field>

          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs text-ink-muted">
              Stanje:{' '}
              <span className="font-semibold tabular text-ink-secondary">
                {numericBalance === null
                  ? '—'
                  : numericBalance.toLocaleString('hr-HR', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
              </span>{' '}
              EURe
            </span>
            <button
              type="button"
              onClick={fillMaxAmount}
              disabled={!hasBalance}
              className={
                'rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest transition active:scale-[0.95] ' +
                (hasBalance
                  ? 'bg-brand-navy-700 text-white hover:bg-brand-navy-600 dark:bg-brand-navy-400 dark:text-brand-navy-900 dark:hover:bg-brand-navy-300'
                  : 'bg-surface-sunken text-ink-muted cursor-not-allowed')
              }
            >
              Max
            </button>
          </div>
          <Field label="Iznos (EURe)" error={amountErrorMsg}>
            {(id) => (
              <Input
                id={id}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                invalid={amountShowsError}
                className="text-2xl font-semibold tabular text-center"
                placeholder="0,00"
              />
            )}
          </Field>

          <Button onClick={send} disabled={!valid || busy} size="xl" block>
            <Fingerprint className="h-5 w-5" />
            {busy ? 'Potpisujem & šaljem…' : 'Potpiši s Face ID i pošalji'}
          </Button>

          {error && (
            <p className="text-sm text-brand-red-700 text-center" role="alert">
              {error}
            </p>
          )}
        </Card>
      </Section>

      {txHash && (
        <Card
          padding="md"
          elevation="elevated"
          className="flex flex-col gap-3 border-emerald-200 dark:border-emerald-900/40"
        >
          <div className="text-center">
            <p className="font-semibold text-ink-primary">Poslano ✓</p>
            <p className="text-sm text-ink-secondary">
              {parsedAmount.ok ? parsedAmount.normalized : amount} EURe → {shortAddr(to)}
            </p>
          </div>
          <a
            href={`https://gnosisscan.io/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-surface-border bg-surface-sunken px-4 py-3 text-sm font-medium text-ink-primary hover:bg-surface-muted transition"
          >
            Pogledaj na Gnosisscan
            <ExternalLink className="h-4 w-4" />
          </a>
        </Card>
      )}

      <RelayQuotaBadge status={relayStatus} />

      <ScannerSheet open={scanOpen} onOpenChange={setScanOpen} onResult={handleScanResult} />
      <AddressBookSheet
        open={bookOpen}
        onOpenChange={setBookOpen}
        onChange={() => setRecents(listRecentRecipients(5))}
      />
    </div>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function RelayQuotaBadge({ status }: { status: RelayStatus | null }) {
  if (!status) {
    return (
      <p className="text-xs text-center text-ink-muted">
        xDAI gas plaćamo mi · 5 besplatnih transakcija dnevno
      </p>
    );
  }
  // Bug previously: the label showed "5/5 besplatnih danas" for BOTH the
  // fresh state (5 remaining of 5) and the exhausted state (5 used of 5),
  // which read identically while meaning opposite things. The fix is to
  // make the framing explicit: "Preostalo X od 5" when active, "Iskorišten
  // dnevni limit · 5 od 5" when exhausted. Different words, no ambiguity.
  const exhausted = status.remaining === 0;
  const reset = formatResetIn(status.resetsInSec);
  return (
    <div
      className={
        'flex flex-col items-center gap-1 text-xs ' +
        (exhausted ? 'text-brand-red-700' : 'text-ink-muted')
      }
      aria-live="polite"
    >
      <span className="font-medium tabular">
        {exhausted ? (
          <>Iskorišten dnevni limit · {status.used} od {status.limit}</>
        ) : (
          <>Preostalo {status.remaining} od {status.limit} besplatnih</>
        )}
      </span>
      <span>
        Resetira se za <span className="tabular">{reset}</span> · xDAI gas plaćamo mi
      </span>
    </div>
  );
}

function formatResetIn(seconds: number): string {
  if (seconds <= 0) return 'sad';
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}
