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
  // Ecosystem RP ID — the parent-domain RP every *.domovina.ai passkey uses.
  // Related Origin Requests (RoR) let a listed third-party origin (pinka.io, via
  // domovina.ai/.well-known/webauthn) run the passkey ceremony NATIVELY in-page.
  const ECOSYSTEM_RP_ID = 'domovina.ai';
  // Public wallet registry (credentialId -> signer/Safe), CORS-open to tenants.
  const REGISTRY_API = 'https://mpt.domovina.ai';

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
      const state = p.get('dw_state');
      for (const k of ['dw_return', 'dw_safe', 'dw_signer', 'dw_cred', 'dw_state']) p.delete(k);
      const clean = u.pathname + (p.toString() ? '?' + p.toString() : '') + u.hash;
      window.history.replaceState(null, '', clean);
      // CSRF: the returned state must match the single-use token we generated
      // before redirecting. A crafted return URL (attacker-chosen safe/signer)
      // has no matching token → ignored. (Identity decides the campaign Safe owner.)
      let expected = null;
      try {
        expected = sessionStorage.getItem(STATE_KEY);
        sessionStorage.removeItem(STATE_KEY);
      } catch (_) {
        /* ignore */
      }
      if (!expected || !state || state !== expected) return null;
      if (!safeAddress || !signerAddress) return null;
      return { safeAddress, signerAddress };
    } catch (_) {
      return null;
    }
  }

  function bufToHex(buf) {
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  // Single-use CSRF token for the redirect handoff (sessionStorage survives the
  // same-tab round-trip to the wallet and back).
  const STATE_KEY = 'domovina_connect_state';
  function newState() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return bufToHex(a.buffer);
  }
  function redirectToWallet() {
    let state = '';
    try {
      state = newState();
      sessionStorage.setItem(STATE_KEY, state);
    } catch (_) {
      /* sessionStorage blocked — proceed without CSRF token (wallet still
         allowlists the return origin; identity is verified there) */
    }
    const url =
      WALLET_ORIGIN +
      '/?dw_connect=1' +
      (state ? '&dw_state=' + encodeURIComponent(state) : '') +
      '&dw_return=' +
      encodeURIComponent(location.href);
    window.location.assign(url);
  }

  // Related Origin Requests: run the passkey ceremony NATIVELY on the host page
  // (top-level → the OS/extension chooser renders correctly, unlike in an
  // iframe) under RP `domovina.ai`, then resolve credentialId -> signer/Safe via
  // the public registry. Throws on any gap so connect() falls back to redirect.
  // Called synchronously from connect() to preserve the click's user activation.
  async function tryRoR() {
    if (!(window.PublicKeyCredential && navigator.credentials)) return null;
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    // Empty allowCredentials → platform surfaces all discoverable domovina.ai
    // passkeys (incl. iCloud/Google-synced ones created on any ecosystem site).
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        rpId: ECOSYSTEM_RP_ID,
        userVerification: 'preferred',
        timeout: 60000,
      },
    });
    if (!assertion || !assertion.rawId) return null;
    const credentialId = '0x' + bufToHex(assertion.rawId);
    const res = await fetch(REGISTRY_API + '/api/wallets/' + encodeURIComponent(credentialId));
    if (!res.ok) throw new Error('registry_' + res.status); // 404 → not registered
    const v = await res.json();
    if (!v || !v.safe_address || !v.signer_address) throw new Error('registry_incomplete');
    return { safeAddress: v.safe_address, signerAddress: v.signer_address };
  }

  // The connected identity (safe + signer) is cached in the HOST page's
  // first-party localStorage so repeat connects are instant — no iframe, no
  // redirect, no re-prompt. Cleared via Domovina.disconnect().
  const STORE_KEY = 'domovina_connected_v1';
  function storeIdentity(id) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ safeAddress: id.safeAddress, signerAddress: id.signerAddress }),
      );
    } catch (_) {
      /* private mode / blocked storage — non-fatal, just no fast path */
    }
  }
  function loadStoredIdentity() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && v.safeAddress && v.signerAddress) {
        return { safeAddress: v.safeAddress, signerAddress: v.signerAddress };
      }
    } catch (_) {
      /* ignore */
    }
    return null;
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
    /** Resolve the user's wallet identity.
     *
     * Best-practice cross-origin handoff (like "Sign in with …"): the passkey
     * ceremony runs FIRST-PARTY on the full wallet.domovina.ai page, where the
     * native/extension credential chooser displays reliably — unlike inside a
     * cross-origin iframe (ITP/storage-partitioning + extensions break it).
     *
     * Resolution order:
     *  1. returning from the wallet (URL has dw_return, CSRF-checked) → cache + resolve;
     *  2. already connected on this host (cached) → resolve instantly, no prompt;
     *  3. Related Origin Requests — run the passkey ceremony NATIVELY in-page (no
     *     navigation; works because pinka.io is listed in domovina.ai/.well-known/
     *     webauthn). MUST be called from a user gesture (the connect button) so the
     *     ceremony keeps the click's activation;
     *  4. on any RoR gap (unsupported browser, cancelled, no passkey, registry
     *     miss) → full-page redirect to the wallet (create OR open existing).
     * Pass { force:true } to skip the cache and re-pick a wallet. */
    connect(opts) {
      const returned = consumeReturnParams();
      if (returned) {
        storeIdentity(returned);
        return Promise.resolve(returned);
      }
      if (!(opts && opts.force)) {
        const stored = loadStoredIdentity();
        if (stored) return Promise.resolve(stored);
      }
      // Run RoR synchronously from here so navigator.credentials.get() inherits
      // the connect button's transient activation (no awaits before the call).
      return (async function () {
        try {
          const id = await tryRoR();
          if (id) {
            storeIdentity(id);
            return id;
          }
        } catch (_) {
          /* unsupported / cancelled / not registered → redirect fallback */
        }
        redirectToWallet();
        return new Promise(function () {}); // navigation in progress; never resolves
      })();
    },
    /** Forget the cached connection so the next connect() re-picks a wallet. */
    disconnect() {
      try {
        localStorage.removeItem(STORE_KEY);
      } catch (_) {
        /* ignore */
      }
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
    _version: '0.7.0',
  };

  Object.defineProperty(window, 'Domovina', { value: api, writable: false });
})();
