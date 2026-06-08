import { useEffect, useRef, useState } from 'react';
import { parseUnits, encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem';
import { Fingerprint, KeyRound, Plus } from 'lucide-react';
import { Button, Card } from '../ui';
import {
  getActivePasskey,
  listKnownPasskeys,
  lookupPasskey,
  pickExistingPasskey,
  recordRpId,
  savePasskey,
  setActivePasskey,
  signWithPasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { lookupWallet } from '../lib/registry';
import {
  encodeWebAuthnSignature,
  getSafeTxHash,
} from '../lib/safe';
import { relayTx } from '../lib/relay';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { humanizeError } from '../lib/errors';
import { haptic } from '../lib/haptic';

type ConnectResult = {
  safeAddress: string;
  signerAddress: string;
  credentialId: string;
  keychainName?: string;
};

type SendResult = {
  txHash: string;
};

type Command =
  | { type: 'connect'; requestId: number; parentOrigin: string; returnUrl?: string }
  | { type: 'send'; requestId: number; parentOrigin: string; to: string; amount: string };

type ConnectCmd = Extract<Command, { type: 'connect' }>;

type Stage =
  | { kind: 'waiting' }
  | { kind: 'choose'; cmd: ConnectCmd; error?: string }
  | { kind: 'connecting' }
  | { kind: 'send-confirm'; cmd: Extract<Command, { type: 'send' }>; to: Address; value: bigint }
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
      if (!cmd.type || typeof cmd.requestId !== 'number') return;

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

  async function handleCommand(cmd: Command, parentOrigin: string) {
    // Safari ITP partitions third-party iframe storage by default. Request
    // first-party storage access on the first command so the wallet's
    // existing localStorage (passkeys, recipients) is visible.
    try {
      if (
        typeof document.requestStorageAccess === 'function' &&
        typeof document.hasStorageAccess === 'function'
      ) {
        const has = await document.hasStorageAccess();
        if (!has) {
          // Must come from a user gesture on some browsers; here we attempt
          // optimistically — if it fails the connect handler degrades to
          // surfacing an explanatory error.
          await document.requestStorageAccess().catch(() => undefined);
        }
      }
    } catch {
      /* non-fatal */
    }

    if (cmd.type === 'connect') {
      // Wallet already known on this device → resolve instantly, no prompt.
      const active = getActivePasskey() ?? listKnownPasskeys()[0] ?? null;
      if (active) {
        resolveConnect(cmd as ConnectCmd, active);
        return;
      }
      // Otherwise surface the branded sheet. WebAuthn (and any OS chooser) only
      // fires after the user taps "Imam novčanik" — never before this point.
      showIframe();
      setStage({ kind: 'choose', cmd: cmd as ConnectCmd });
      return;
    }

    if (cmd.type === 'send') {
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
      const active = getActivePasskey();
      if (!active) {
        postError(
          parentOrigin,
          cmd.requestId,
          'Nema aktivnog walleta. Otvori https://wallet.domovina.ai i kreiraj ga.',
        );
        return;
      }

      // Surface the iframe with a confirm card. Face ID will only fire after
      // the user clicks Confirm in-iframe so we have transient activation.
      showIframe();
      setStage({ kind: 'send-confirm', cmd, to: cmd.to as Address, value });
    }
  }

  function resolveConnect(cmd: ConnectCmd, record: PasskeyRecord) {
    const result: ConnectResult = {
      safeAddress: record.safeAddress,
      signerAddress: record.signerAddress,
      credentialId: record.credentialId,
      keychainName: record.keychainName,
    };
    postResult(cmd.parentOrigin, cmd.requestId, result);
    hideIframe();
    setStage({ kind: 'waiting' });
  }

  /// "Imam novčanik": discoverable passkey get under our RP (surfaces synced
  /// iCloud/Google passkeys too), resolve to a wallet via the local registry or
  /// the backend, persist it, and return. Fires only on the user's tap, so the
  /// OS chooser now has DOMOVINA context. On cancel/failure we stay on the sheet.
  async function chooseExisting(cmd: ConnectCmd) {
    setStage({ kind: 'connecting' });
    try {
      const { credentialId } = await pickExistingPasskey();
      let record = lookupPasskey(credentialId);
      if (!record) {
        const remote = await lookupWallet(credentialId);
        if (!remote) {
          throw new Error(
            'Ovaj passkey nije registriran. Kreiraj novčanik ili ga otvori na izvornom uređaju.',
          );
        }
        record = {
          credentialId,
          pubKey: { x: remote.pub_key_x, y: remote.pub_key_y },
          signerAddress: remote.signer_address,
          safeAddress: remote.safe_address,
          createdAt: remote.created_at,
          rpId: remote.rp_id,
        };
        savePasskey(record); // also sets active
      } else {
        setActivePasskey(record.credentialId);
      }
      haptic('success');
      resolveConnect(cmd, record);
    } catch (e) {
      haptic('error');
      setStage({ kind: 'choose', cmd, error: humanizeError(e, 'passkey') });
    }
  }

  /// "Kreiraj novčanik": hand off to wallet.domovina.ai (full-page, first-party)
  /// to create the passkey + Safe, then return to the host with the identity in
  /// the URL. The host SDK navigates the top window (we can't cross-origin).
  function chooseCreate(cmd: ConnectCmd) {
    const ret = cmd.returnUrl ?? '';
    const url = `${window.location.origin}/?dw_connect=1&dw_return=${encodeURIComponent(ret)}`;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: '__domovina_redirect__', url }, cmd.parentOrigin);
    }
  }

  function dismissConnect(cmd: ConnectCmd) {
    postError(cmd.parentOrigin, cmd.requestId, 'Korisnik je odustao');
    hideIframe();
    setStage({ kind: 'waiting' });
  }

  async function confirmSend(cmd: Extract<Command, { type: 'send' }>, to: Address, value: bigint) {
    const active = getActivePasskey();
    if (!active) return;
    setStage({ kind: 'send-busy' });
    try {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, value],
      });
      const { hash: safeTxHash } = await getSafeTxHash(active.safeAddress, {
        to: EURE_ADDRESS,
        value: 0n,
        data,
      });
      const assertion = await signWithPasskey(
        active.credentialId,
        hexToBytes(safeTxHash),
        recordRpId(active),
      );
      const signature = encodeWebAuthnSignature({ ...assertion, signerAddress: active.signerAddress });
      const result = await relayTx({
        safeAddress: active.safeAddress,
        signerAddress: active.signerAddress,
        pubKeyX: active.pubKey.x,
        pubKeyY: active.pubKey.y,
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
        subtitle: `Transakcija je predana na Gnosis Chain. Možeš zatvoriti ovaj prozor.`,
      });
      setTimeout(() => {
        hideIframe();
        setStage({ kind: 'waiting' });
      }, 2200);
    } catch (e) {
      haptic('error');
      const msg = humanizeError(e, 'passkey');
      postError(cmd.parentOrigin, cmd.requestId, msg);
      setStage({
        kind: 'success',
        title: 'Slanje neuspješno',
        subtitle: msg,
      });
      setTimeout(() => {
        hideIframe();
        setStage({ kind: 'waiting' });
      }, 3000);
    }
  }

  function dismissSend(cmd: Extract<Command, { type: 'send' }>) {
    postError(cmd.parentOrigin, cmd.requestId, 'Korisnik je odustao');
    hideIframe();
    setStage({ kind: 'waiting' });
  }

  // ── Render

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      {stage.kind === 'waiting' && null}

      {stage.kind === 'choose' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-ink-primary">Poveži DOMOVINA novčanik</h2>
            <p className="text-sm text-ink-secondary">
              Poveži se sa svojim novčanikom da nastaviš
              {stage.cmd.parentOrigin
                ? ` na ${hostnameFromOrigin(stage.cmd.parentOrigin)}`
                : ''}
              .
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={() => chooseExisting(stage.cmd)} size="lg" block>
              <KeyRound className="h-5 w-5" />
              Imam novčanik
            </Button>
            <Button onClick={() => chooseCreate(stage.cmd)} variant="secondary" size="lg" block>
              <Plus className="h-5 w-5" />
              Kreiraj novčanik
            </Button>
          </div>
          {stage.error && <p className="text-sm text-brand-red-500">{stage.error}</p>}
          <Button onClick={() => dismissConnect(stage.cmd)} variant="ghost" size="md" block>
            Odustani
          </Button>
        </Card>
      )}

      {stage.kind === 'connecting' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col items-center gap-3">
          <Fingerprint className="h-10 w-10 text-brand-navy-500 animate-pulse" />
          <p className="text-sm text-ink-secondary text-center">Odaberi svoj passkey…</p>
        </Card>
      )}

      {stage.kind === 'send-confirm' && (
        <Card padding="md" className="max-w-sm w-full flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-ink-primary">Potvrdi slanje</h2>
          <div className="text-sm text-ink-secondary flex flex-col gap-1">
            <Row label="Iznos" value={`${stage.cmd.amount} EURe`} />
            <Row label="Prima" value={shortAddr(stage.to)} mono />
            <Row label="Aplikacija" value={hostnameFromOrigin(stage.cmd.parentOrigin)} />
          </div>
          <div className="flex flex-col gap-2 pt-2">
            <Button onClick={() => confirmSend(stage.cmd, stage.to, stage.value)} size="lg" block>
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
