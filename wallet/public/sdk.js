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
 * connect() is iframe-first and BRANDED-first: the wallet's own embed UI (under
 * wallet.domovina.ai) decides what to show. If a wallet already exists it
 * resolves silently; otherwise it surfaces a DOMOVINA-branded sheet and the
 * passkey ceremony only fires AFTER the user taps "Imam novčanik" — so the OS
 * passkey chooser never appears before any context. "Kreiraj novčanik" redirects
 * the top window to wallet.domovina.ai and returns here with the wallet identity
 * in the URL (consumed transparently by connect() on the way back).
 *
 * Why not RoR-first: running the native passkey ceremony on the host page summons
 * the OS/extension credential chooser (LastPass, Apple Passwords, …) with zero
 * DOMOVINA framing and, with empty allowCredentials, chains every provider in
 * turn. Gating WebAuthn behind the branded sheet fixes that.
 * send() always uses the iframe (signing needs the wallet's viem/Safe code).
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
  // When the host calls mount(el), the iframe lives INLINE inside `el` (in the
  // page flow, below the connect button) instead of a fixed fullscreen overlay,
  // and its height tracks the embed's content via __domovina_resize__.
  /** @type {HTMLElement | null} */
  let inlineContainer = null;
  let inlineMode = false;
  // While a passkey ceremony runs, an inline embed temporarily goes fullscreen so
  // the OS/extension credential UI (LastPass, Apple/Google) — which a password
  // manager extension injects INSIDE our iframe — isn't clipped by the short
  // inline panel. `expanded` suppresses resize handling during that window.
  let expanded = false;
  let lastInlineHeight = 0;

  const INLINE_STYLE = [
    'display:none',
    'width:100%',
    'height:0',
    'border:0',
    'margin:0',
    'padding:0',
    'overflow:hidden',
    'background:transparent',
    'color-scheme:light dark',
  ].join(';');
  const FULLSCREEN_STYLE = [
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
  // Same as fullscreen but shown — used to temporarily un-clip an inline embed
  // during a passkey ceremony (the provider UI renders inside the iframe).
  const EXPAND_STYLE = FULLSCREEN_STYLE.replace('display:none', 'display:block');

  function ensureIframe() {
    if (iframe) return iframe;
    inlineMode = !!inlineContainer;
    iframe = document.createElement('iframe');
    // ?inline=1 tells the embed to render as an integrated panel (no dark
    // backdrop / fullscreen centering) and to report its content height.
    iframe.src = WALLET_ORIGIN + EMBED_PATH + (inlineMode ? '?inline=1' : '');
    iframe.title = 'DOMOVINA Wallet';
    // WebAuthn inside iframe requires explicit permission delegation. Without
    // this, navigator.credentials.{create,get} inside the iframe throws
    // NotAllowedError on most browsers.
    iframe.allow = 'publickey-credentials-get *; publickey-credentials-create *; clipboard-read *; clipboard-write *';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = inlineMode ? INLINE_STYLE : FULLSCREEN_STYLE;
    (inlineMode ? inlineContainer : document.body).appendChild(iframe);

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
      if (inlineMode) iframe.style.height = '0';
      iframe.setAttribute('aria-hidden', 'true');
      return;
    }
    // Inline auto-resize: the embed reports its content height so the iframe is
    // exactly as tall as the panel — no inner scrollbars, no clipped content.
    if (data.type === '__domovina_resize__' && inlineMode && typeof data.height === 'number') {
      // Ignore resizes while expanded — the ceremony layout is full-viewport and
      // would otherwise be remembered as the collapsed panel height.
      if (!expanded) {
        lastInlineHeight = Math.max(0, Math.ceil(data.height));
        iframe.style.height = lastInlineHeight + 'px';
      }
      return;
    }
    // Temporarily expand an inline embed to fullscreen for a passkey ceremony,
    // then collapse back so the provider chooser isn't clipped by the panel.
    if (data.type === '__domovina_fullscreen__' && inlineMode) {
      expanded = !!data.on;
      if (expanded) {
        iframe.style.cssText = EXPAND_STYLE;
      } else {
        iframe.style.cssText = INLINE_STYLE;
        iframe.style.display = 'block';
        iframe.style.height = lastInlineHeight + 'px';
      }
      return;
    }
    // The embed asks the host to navigate the TOP window (it can't cross-origin
    // navigate the parent itself). Used by the "Kreiraj novčanik" branch, which
    // sends the user to wallet.domovina.ai and returns with identity params.
    if (data.type === '__domovina_redirect__' && typeof data.url === 'string') {
      if (data.url.indexOf(WALLET_ORIGIN + '/') === 0) window.location.assign(data.url);
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
    // returnUrl lets the embed build a "create wallet" redirect that comes back
    // to exactly where the user started (consumed by consumeReturnParams below).
    const message = { ...cmd, requestId, parentOrigin: location.origin, returnUrl: location.href };
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      const send = () => iframe.contentWindow.postMessage(message, WALLET_ORIGIN);
      if (iframeReady) send();
      else queue.push(send);
    });
  }

  // On returning from a "Kreiraj novčanik" redirect, wallet.domovina.ai appends
  // the new wallet identity to our URL. Read it, strip the params from the
  // address bar (history.replaceState — no reload), and resolve connect() with
  // it. Returns null when this isn't a return navigation.
  function consumeReturnParams() {
    try {
      const u = new URL(window.location.href);
      const p = u.searchParams;
      if (p.get('dw_return') !== '1') return null;
      const safeAddress = p.get('dw_safe');
      const signerAddress = p.get('dw_signer');
      for (const k of ['dw_return', 'dw_safe', 'dw_signer', 'dw_cred']) p.delete(k);
      const clean = u.pathname + (p.toString() ? '?' + p.toString() : '') + u.hash;
      window.history.replaceState(null, '', clean);
      if (!safeAddress || !signerAddress) return null;
      return { safeAddress, signerAddress };
    } catch (_) {
      return null;
    }
  }

  const api = {
    /** Mount the wallet iframe INLINE inside `container` (an HTMLElement in the
     * host page, e.g. a div below the connect button) instead of the default
     * fixed fullscreen overlay. The iframe renders as an integrated panel and
     * auto-resizes to its content (no scrollbars). Call BEFORE connect(). Pass
     * null to revert to fullscreen. Returns the API for chaining. */
    mount(container) {
      inlineContainer = container && container.nodeType === 1 ? container : null;
      if (!iframe) {
        ensureIframe(); // pre-create inline so it's ready when connect() runs
      } else if (inlineContainer && iframe.parentElement !== inlineContainer) {
        // Iframe already existed (e.g. created fullscreen) — re-home it inline.
        inlineMode = true;
        iframe.style.cssText = INLINE_STYLE;
        inlineContainer.appendChild(iframe);
      }
      return api;
    },
    /** Resolve the user's wallet identity through the branded embed. If the user
     * just returned from creating a wallet (URL carries dw_return), resolve from
     * those params immediately. Otherwise the embed resolves silently from wallet
     * storage, or shows the branded sheet (passkey prompt only after a tap).
     * Pass { container } to mount the embed inline (same as calling mount first). */
    connect(opts) {
      if (opts && opts.container) api.mount(opts.container);
      const returned = consumeReturnParams();
      if (returned) return Promise.resolve(returned);
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
    _version: '0.5.0',
  };

  Object.defineProperty(window, 'Domovina', { value: api, writable: false });
})();
