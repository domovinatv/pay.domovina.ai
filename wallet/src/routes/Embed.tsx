import { useEffect, useRef, useState } from 'react';
import { parseUnits, encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem';
import { Fingerprint } from 'lucide-react';
import { Button, Card } from '../ui';
import {
  getActivePasskey,
  lookupPasskey,
  recordRpId,
  signWithPasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { lookupWalletStrict } from '../lib/registry';
import { encodeWebAuthnSignature, getSafeTxHash } from '../lib/safe';
import { relayTx } from '../lib/relay';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { humanizeError } from '../lib/errors';
import { haptic } from '../lib/haptic';

// The /embed iframe is used ONLY for send() now — connect() is a deterministic
// full-page redirect handled by the SDK (no iframe). The send command carries the
// connected credentialId so we sign from the SAME wallet the host connected.

type SendCmd = {
  type: 'send';
  requestId: number;
  parentOrigin: string;
  to: string;
  amount: string;
  credentialId?: string | null;
  safeAddress?: string | null;
};
type Command = SendCmd;

type SendResult = { txHash: string };

type Stage =
  | { kind: 'waiting' }
  | { kind: 'send-confirm'; cmd: SendCmd; to: Address; value: bigint; record: PasskeyRecord }
  | { kind: 'send-busy' }
  | { kind: 'success'; title: string; subtitle: string };

const READY_MESSAGE = { type: '__domovina_iframe_ready__' };
const SHOW_MESSAGE = { type: '__domovina_show__' };
const HIDE_MESSAGE = { type: '__domovina_hide__' };

export function Embed() {
  const parentOriginRef = useRef<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'waiting' });

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const cmd = data as Command;
      if (cmd.type !== 'send' || typeof cmd.requestId !== 'number') return;

      // Capture parent origin on first command. Subsequent commands must match.
      if (parentOriginRef.current === null) {
        parentOriginRef.current = event.origin;
      } else if (event.origin !== parentOriginRef.current) {
        return;
      }

      void handleCommand(cmd, event.origin);
    }

    window.addEventListener('message', onMessage);
    // Tell the SDK we're ready to receive commands.
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(READY_MESSAGE, '*');
    }
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function postResult(parentOrigin: string, requestId: number, result: unknown) {
    window.parent?.postMessage({ requestId, ok: true, result }, parentOrigin);
  }
  function postError(parentOrigin: string, requestId: number, error: string) {
    window.parent?.postMessage({ requestId, ok: false, error }, parentOrigin);
  }
  function showIframe() {
    if (window.parent && window.parent !== window) window.parent.postMessage(SHOW_MESSAGE, '*');
  }
  function hideIframe() {
    if (window.parent && window.parent !== window) window.parent.postMessage(HIDE_MESSAGE, '*');
  }

  /// Resolve the signing record from the connected credentialId (threaded from
  /// the host's connect cache): local registry first, else the backend registry
  /// (works even when the iframe's storage is partitioned/empty). Falls back to
  /// the iframe's own active passkey only when no credentialId was provided.
  async function resolveSigningRecord(credentialId?: string | null): Promise<PasskeyRecord | null> {
    if (credentialId) {
      const local = lookupPasskey(credentialId);
      if (local) return local;
      try {
        const remote = await lookupWalletStrict(credentialId);
        if (remote) {
          return {
            credentialId,
            pubKey: { x: remote.pub_key_x, y: remote.pub_key_y },
            signerAddress: remote.signer_address,
            safeAddress: remote.safe_address,
            createdAt: remote.created_at,
            rpId: remote.rp_id,
          };
        }
      } catch {
        /* registry unreachable — fall through to the local active passkey */
      }
    }
    return getActivePasskey();
  }

  async function handleCommand(cmd: SendCmd, parentOrigin: string) {
    // Safari ITP partitions third-party iframe storage; request first-party access
    // so the wallet's localStorage (passkeys) is visible for the local fast path.
    try {
      if (
        typeof document.requestStorageAccess === 'function' &&
        typeof document.hasStorageAccess === 'function'
      ) {
        const has = await document.hasStorageAccess();
        if (!has) await document.requestStorageAccess().catch(() => undefined);
      }
    } catch {
      /* non-fatal */
    }

    if (!isAddress(cmd.to)) {
      postError(parentOrigin, cmd.requestId, 'Invalid recipient address');
      return;
    }
    let value: bigint;
    try {
      value = parseUnits(cmd.amount.replace(',', '.'), EURE_DECIMALS);
    } catch {
      postError(parentOrigin, cmd.requestId, 'Invalid amount');
      return;
    }

    // Require the host's connected Safe — the legit SDK always sends it. Without
    // it we'd fall back to getActivePasskey() and could sign from a divergent
    // wallet, so refuse rather than guess.
    if (!cmd.safeAddress) {
      postError(parentOrigin, cmd.requestId, 'Nije povezan novčanik. Poveži se ponovno.');
      return;
    }
    const record = await resolveSigningRecord(cmd.credentialId);
    if (!record) {
      postError(parentOrigin, cmd.requestId, 'Nije povezan novčanik. Poveži se ponovno.');
      return;
    }
    // Defense: never sign from a Safe other than the one the host connected.
    if (record.safeAddress.toLowerCase() !== cmd.safeAddress.toLowerCase()) {
      postError(parentOrigin, cmd.requestId, 'Novčanik se ne podudara s povezanim.');
      return;
    }

    // Surface the iframe with a confirm card. Face ID fires only after the user
    // taps Confirm in-iframe so we have transient activation.
    showIframe();
    setStage({ kind: 'send-confirm', cmd, to: cmd.to as Address, value, record });
  }

  async function confirmSend(cmd: SendCmd, to: Address, value: bigint, record: PasskeyRecord) {
    setStage({ kind: 'send-busy' });
    try {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] });
      const { hash: safeTxHash } = await getSafeTxHash(record.safeAddress, {
        to: EURE_ADDRESS,
        value: 0n,
        data,
      });
      const assertion = await signWithPasskey(
        record.credentialId,
        hexToBytes(safeTxHash),
        recordRpId(record),
      );
      const signature = encodeWebAuthnSignature({ ...assertion, signerAddress: record.signerAddress });
      const result = await relayTx({
        safeAddress: record.safeAddress,
        signerAddress: record.signerAddress,
        pubKeyX: record.pubKey.x,
        pubKeyY: record.pubKey.y,
        to: EURE_ADDRESS,
        value: '0',
        data,
        signature,
      });
      if (!result.ok) throw new Error(result.error);

      const out: SendResult = { txHash: result.txHash };
      postResult(cmd.parentOrigin, cmd.requestId, out);
      haptic('success');
      setStage({
        kind: 'success',
        title: 'Poslano ✓',
        subtitle: 'Transakcija je predana na Gnosis Chain. Možeš zatvoriti ovaj prozor.',
      });
      setTimeout(() => {
        hideIframe();
        setStage({ kind: 'waiting' });
      }, 2200);
    } catch (e) {
      haptic('error');
      const msg = humanizeError(e, 'passkey');
      postError(cmd.parentOrigin, cmd.requestId, msg);
      setStage({ kind: 'success', title: 'Slanje neuspješno', subtitle: msg });
      setTimeout(() => {
        hideIframe();
        setStage({ kind: 'waiting' });
      }, 3000);
    }
  }

  function dismissSend(cmd: SendCmd) {
    postError(cmd.parentOrigin, cmd.requestId, 'Korisnik je odustao');
    hideIframe();
    setStage({ kind: 'waiting' });
  }

  // ── Render (fullscreen overlay; only shown while a send needs attention)

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      {stage.kind === 'waiting' && null}

      {stage.kind === 'send-confirm' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-ink-primary">Potvrdi slanje</h2>
          <div className="text-sm text-ink-secondary flex flex-col gap-1">
            <Row label="Iznos" value={`${stage.cmd.amount} EURe`} />
            <Row label="Prima" value={shortAddr(stage.to)} mono />
            <Row label="Aplikacija" value={hostnameFromOrigin(stage.cmd.parentOrigin)} />
          </div>
          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={() => confirmSend(stage.cmd, stage.to, stage.value, stage.record)}
              size="lg"
              block
            >
              <Fingerprint className="h-5 w-5" />
              Potpiši Face ID-om
            </Button>
            <Button onClick={() => dismissSend(stage.cmd)} variant="ghost" size="md" block>
              Odustani
            </Button>
          </div>
        </Card>
      )}

      {stage.kind === 'send-busy' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col items-center gap-3">
          <Fingerprint className="h-10 w-10 text-brand-navy-500 animate-pulse" />
          <p className="text-sm text-ink-secondary text-center">Otvori Face ID i pričekaj relay…</p>
        </Card>
      )}

      {stage.kind === 'success' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col gap-2">
          <p className="font-medium text-ink-primary">{stage.title}</p>
          <p className="text-sm text-ink-secondary">{stage.subtitle}</p>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className={mono ? 'font-mono text-ink-primary' : 'text-ink-primary'}>{value}</span>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function hostnameFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
