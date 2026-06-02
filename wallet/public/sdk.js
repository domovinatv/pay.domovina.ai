/**
 * DOMOVINA Wallet SDK — embedded-iframe bridge.
 *
 * Usage in any third-party page:
 *   <script src="https://wallet.domovina.ai/sdk.js"></script>
 *   <script>
 *     const result = await Domovina.connect();
 *     console.log(result.safeAddress);
 *     const { txHash } = await Domovina.send({ to: '0x...', amount: '1.50' });
 *   </script>
 *
 * Architecture: a hidden iframe pointing at https://wallet.domovina.ai/embed
 * runs the wallet code under its own origin (so the user's existing passkey +
 * Safe registry are surfaced natively). Commands flow via postMessage and the
 * iframe shows itself fullscreen for any step that needs user attention
 * (passkey prompts, Send confirmation).
 *
 * connect() is RoR-first: when the browser supports WebAuthn Related Origin
 * Requests, we run the passkey ceremony natively on the host page under RP ID
 * `domovina.ai` (domovina.ai/.well-known/webauthn lists this origin), resolve
 * the credential -> signer/Safe via the public wallet registry, and skip the
 * iframe entirely. Any unsupported browser / failure falls back to the iframe.
 * send() always uses the iframe (signing needs the wallet's viem/Safe code).
 */
(function () {
  if (window.Domovina) return; // already loaded

  const WALLET_ORIGIN = 'https://wallet.domovina.ai';
  const EMBED_PATH = '/embed';
  // Ecosystem RP ID — the same parent-domain RP the wallet uses for every
  // *.domovina.ai page (wallet/src/lib/constants.ts deriveRpId). RoR lets a
  // third-party origin (e.g. pinka.io) reuse this RP's passkey natively.
  const ECOSYSTEM_RP_ID = 'domovina.ai';
  // Public wallet registry (credentialId -> signer/Safe). Same backend the
  // wallet itself calls (mpt.domovina.ai). MUST allow the host origin via CORS.
  const REGISTRY_API = 'https://mpt.domovina.ai';

  /** @type {HTMLIFrameElement | null} */
  let iframe = null;
  let iframeReady = false;
  let nextId = 1;
  const pending = new Map();
  const queue = [];

  function ensureIframe() {
    if (iframe) return iframe;
    iframe = document.createElement('iframe');
    iframe.src = WALLET_ORIGIN + EMBED_PATH;
    iframe.title = 'DOMOVINA Wallet';
    // WebAuthn inside iframe requires explicit permission delegation. Without
    // this, navigator.credentials.{create,get} inside the iframe throws
    // NotAllowedError on most browsers.
    iframe.allow = 'publickey-credentials-get *; publickey-credentials-create *; clipboard-read *; clipboard-write *';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'border:0',
      'margin:0',
      'padding:0',
      'z-index:2147483647',
      'display:none',
      'background:transparent',
      'color-scheme:light dark',
    ].join(';');
    document.body.appendChild(iframe);

    window.addEventListener('message', onMessage);
    return iframe;
  }

  function onMessage(event) {
    if (event.origin !== WALLET_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === '__domovina_iframe_ready__') {
      iframeReady = true;
      iframe.setAttribute('aria-hidden', 'true');
      for (const fn of queue.splice(0)) fn();
      return;
    }
    if (data.type === '__domovina_show__') {
      iframe.style.display = 'block';
      iframe.removeAttribute('aria-hidden');
      return;
    }
    if (data.type === '__domovina_hide__') {
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      return;
    }
    if (data.requestId && pending.has(data.requestId)) {
      const { resolve, reject } = pending.get(data.requestId);
      pending.delete(data.requestId);
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error || 'DOMOVINA: command failed'));
    }
  }

  function postCommand(cmd) {
    ensureIframe();
    const requestId = nextId++;
    const message = { ...cmd, requestId, parentOrigin: location.origin };
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      const send = () => iframe.contentWindow.postMessage(message, WALLET_ORIGIN);
      if (iframeReady) send();
      else queue.push(send);
    });
  }

  function bufToHex(buf) {
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  // Decide whether to attempt Related Origin Requests. getClientCapabilities is
  // Chrome/Edge-only; when it definitively reports relatedOrigins we trust it,
  // otherwise (Safari, Firefox, older Chrome) we optimistically TRY — an
  // unsupported browser rejects credentials.get for a cross-origin rpId fast and
  // without UI, so the iframe fallback kicks in cleanly.
  async function shouldTryRoR() {
    try {
      if (
        window.PublicKeyCredential &&
        typeof PublicKeyCredential.getClientCapabilities === 'function'
      ) {
        const caps = await PublicKeyCredential.getClientCapabilities();
        if (caps && typeof caps.relatedOrigins === 'boolean') return caps.relatedOrigins;
      }
    } catch (_) {
      /* fall through to optimistic */
    }
    return true;
  }

  // Native cross-origin connect: run the passkey ceremony here (under RP
  // `domovina.ai` via RoR), then resolve credentialId -> signer/Safe through the
  // public wallet registry. No iframe, no Safari storage-access dance. Throws on
  // any gap so connect() can fall back to the iframe bridge.
  async function connectViaRoR() {
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('no_webauthn');
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        rpId: ECOSYSTEM_RP_ID,
        userVerification: 'preferred',
        timeout: 60000,
        // empty allowCredentials -> the platform surfaces all discoverable
        // domovina.ai passkeys (incl. iCloud/Google-synced ones on a fresh
        // device, which the iframe's localStorage-only path cannot see).
      },
    });
    if (!assertion || !assertion.rawId) throw new Error('no_assertion');
    // Canonical credentialId == '0x' + lowercase hex of rawId (matches
    // wallet/src/lib/passkey.ts normalizeCredentialId + the registry key).
    const credentialId = '0x' + bufToHex(assertion.rawId);
    const res = await fetch(REGISTRY_API + '/api/wallets/' + encodeURIComponent(credentialId));
    if (!res.ok) throw new Error('registry_lookup_' + res.status); // 404 -> not registered
    const v = await res.json();
    if (!v || !v.safe_address || !v.signer_address) throw new Error('registry_incomplete');
    return { safeAddress: v.safe_address, signerAddress: v.signer_address };
  }

  const api = {
    /** Resolve the user's wallet identity. RoR-first (native passkey prompt on
     * the host page); falls back to the iframe bridge on any unsupported
     * browser or failure. The iframe path reads the wallet's own localStorage
     * and only shows UI if no wallet exists. */
    connect() {
      return (async () => {
        if (await shouldTryRoR()) {
          try {
            return await connectViaRoR();
          } catch (_) {
            // RoR unsupported / cancelled / credential not in registry — fall
            // back to the iframe, which resolves silently from wallet storage
            // or surfaces the proper "create a wallet" UI.
          }
        }
        return postCommand({ type: 'connect' });
      })();
    },
    /** Send EURe (or native xDAI in a future revision). Shows the iframe for
     * the user to confirm the amount and authorize with Face ID. */
    send({ to, amount }) {
      if (typeof to !== 'string' || typeof amount !== 'string') {
        return Promise.reject(new TypeError('Domovina.send: { to, amount } strings required'));
      }
      return postCommand({ type: 'send', to, amount });
    },
    /** For diagnostics / debug. */
    _version: '0.2.0',
  };

  Object.defineProperty(window, 'Domovina', { value: api, writable: false });
})();
