import { useRef, useState } from 'react';
import { parseUnits, encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem';
import { BrandHeader } from '../components/Brand';
import { useWalletStore } from '../state/store';
import { EURE_ADDRESS, EURE_DECIMALS } from '../lib/constants';
import { encodeWebAuthnSignature, getSafeTxHash } from '../lib/safe';
import { getActivePasskey, signWithPasskey } from '../lib/passkey';
import { relayTx } from '../lib/relay';

export function Send() {
  const { safeAddress, credentialId, signerAddress, setScreen } = useWalletStore();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const sendInFlightRef = useRef(false);

  const valid = isAddress(to) && Number(amount) > 0;

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
    setError(null);
    setTxHash(null);
    setBusy(true);
    try {
      const value = parseUnits(amount, EURE_DECIMALS);
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
        clientDataJSONSnippet: new TextDecoder().decode(assertion.clientDataJSON).slice(0, 120),
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
    } catch (e) {
      console.error('[Send] FAILED', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      sendInFlightRef.current = false;
    }
  }

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto">
      <BrandHeader />

      <main className="flex-1 flex flex-col gap-6">
        <button onClick={() => setScreen('wallet')} className="self-start text-sm text-gray-500">
          ← natrag
        </button>

        <section className="card space-y-4">
          <h2 className="text-xl font-semibold">Pošalji EURe</h2>

          <label className="block">
            <span className="text-sm text-gray-600">Primatelj (Gnosis adresa)</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              className="mt-1 w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Iznos (EURe)</span>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-300 px-4 py-3 text-lg font-semibold"
              min="0"
              step="0.01"
            />
          </label>

          <button onClick={send} disabled={!valid || busy} className="btn-primary w-full">
            {busy ? 'Potpisujem & šaljem…' : 'Sign with Face ID & send'}
          </button>

          {error && <div className="text-sm text-domovina-red">{error}</div>}
          {txHash && (
            <a
              href={`https://gnosisscan.io/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="block text-sm text-domovina-navy underline break-all"
            >
              Vidi tx ↗
            </a>
          )}
        </section>

        <p className="text-xs text-center text-gray-400">
          xDAI gas plaćamo mi · 5 besplatnih transakcija dnevno
        </p>
      </main>
    </div>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
