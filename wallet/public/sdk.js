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
 */
(function () {
  if (window.Domovina) return; // already loaded

  const WALLET_ORIGIN = 'https://wallet.domovina.ai';
  const EMBED_PATH = '/embed';

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

  const api = {
    /** Resolve the user's wallet identity. Shows in-iframe UI only if no
     * existing passkey is found and the user needs to create one. */
    connect() {
      return postCommand({ type: 'connect' });
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
    _version: '0.1.0',
  };

  Object.defineProperty(window, 'Domovina', { value: api, writable: false });
})();
