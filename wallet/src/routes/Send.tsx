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
import { decodeQR } from '../lib/eip681';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { parseAmount, isAmountInvalidForDisplay } from '../lib/amount';
import { addRecipient, listRecentRecipients, type Recipient } from '../lib/recipients';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { encodeWebAuthnSignature, getSafeTxHash } from '../lib/safe';
import { getActivePasskey, signWithPasskey } from '../lib/passkey';
import { relayTx } from '../lib/relay';

export function Send() {
  const { safeAddress, credentialId, signerAddress } = useWalletStore();
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [recents, setRecents] = useState<Recipient[]>(() => listRecentRecipients(5));
  const sendInFlightRef = useRef(false);

  // Filter out the current input value so we don't show "Nedavno" for the
  // address the user is already targeting.
  const visibleRecents = recents.filter(
    (r) => r.address.toLowerCase() !== to.toLowerCase(),
  );

  // Refresh recents when navigating back to /send (browser back, etc.) — the
  // localStorage may have been updated by a successful Send mid-session.
  useEffect(() => {
    setRecents(listRecentRecipients(5));
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
  const valid = isAddress(to) && parsedAmount.ok;
  const amountErrorMsg = amountShowsError
    ? parsedAmount.ok
      ? undefined
      : parsedAmount.reason === 'zero'
        ? 'Iznos mora biti veći od 0'
        : 'Iznos nije valjan broj'
    : undefined;

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setTo(text.trim());
    } catch {
      toast({ variant: 'error', title: 'Clipboard nedostupan' });
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
    const passkey = getActivePasskey();
    if (!passkey) {
      console.warn('[Send] no active passkey');
      sendInFlightRef.current = false;
      setError('No active passkey on this device — re-open wallet.');
      return;
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
      const assertion = await signWithPasskey(credentialId, hexToBytes(safeTxHash));
      console.log('[Send] step 7: got passkey assertion', {
        authenticatorDataLen: assertion.authenticatorData.length,
        clientDataJSONLen: assertion.clientDataJSON.length,
        signatureLen: assertion.signature.length,
      });

      console.log('[Send] step 8: encoding WebAuthn signature…');
      const signature = encodeWebAuthnSignature({ ...assertion, signerAddress });
      console.log('[Send] step 9: signature encoded', { signatureLen: signature.length });

      console.log('[Send] step 10: POST /api/relay…');
      const result = await relayTx({
        safeAddress,
        signerAddress,
        pubKeyX: passkey.pubKey.x,
        pubKeyY: passkey.pubKey.y,
        to: EURE_ADDRESS,
        value: '0',
        data,
        signature,
      });
      console.log('[Send] step 11: relay result', result);

      if (!result.ok) {
        throw new Error(result.rateLimited ? 'Dosegao si dnevni limit (5 besplatnih).' : result.error);
      }
      setTxHash(result.txHash);
      addRecipient(to);
      setRecents(listRecentRecipients(5));
      toast({ variant: 'success', title: 'Poslano ✓', description: `${parsedAmount.normalized} EURe → ${shortAddr(to)}` });
    } catch (e) {
      console.error('[Send] FAILED', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ variant: 'error', title: 'Slanje neuspješno', description: msg });
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
          />
          <Field
            label="Primatelj"
            hint="Gnosis Chain · EVM adresa"
            error={!addressLooksValid ? 'Adresa nije valjana' : undefined}
          >
            {() => (
              <AddressInput
                value={to}
                onChange={(e) => setTo(e.target.value)}
                invalid={!addressLooksValid}
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

      <p className="text-xs text-center text-ink-muted">
        xDAI gas plaćamo mi · 5 besplatnih transakcija dnevno
      </p>

      <ScannerSheet open={scanOpen} onOpenChange={setScanOpen} onResult={handleScanResult} />
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
