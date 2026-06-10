/**
 * DOMOVINA Wallet SDK — host-page bridge for tenant dApps.
 *
 * Usage in any third-party page:
 *   <script src="https://wallet.domovina.ai/sdk.js"></script>
 *   <script>
 *     const { safeAddress, signerAddress } = await Domovina.connect();
 *     const { txHash } = await Domovina.send({ to: '0x...', amount: '1.50' });
 *   </script>
 *
 * connect() is a DETERMINISTIC full-page handoff (like "Sign in with …"): the
 * passkey ceremony runs FIRST-PARTY on wallet.domovina.ai, which presents a
 * curated chooser it controls (a dApp page can't filter the OS passkey picker),
 * then redirects back with the identity in the URL. The identity is cached in the
 * host's first-party localStorage so repeat connects are instant. See
 * docs/cross-origin-wallet-connect.md.
 *
 * send() is the ONLY thing that still uses the iframe at /embed: signing needs the
 * wallet's viem/Safe code, and the iframe runs it under the wallet origin. The
 * connected identity (incl. credentialId) is passed into the send command so the
 * iframe signs from the SAME wallet the host connected — not a divergent local one.
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

  function ensureIframe() {
    if (iframe) return iframe;
    iframe = document.createElement('iframe');
    iframe.src = WALLET_ORIGIN + EMBED_PATH;
    iframe.title = 'DOMOVINA Wallet';
    // WebAuthn inside an iframe requires explicit permission delegation.
    iframe.allow =
      'publickey-credentials-get *; publickey-credentials-create *; clipboard-read *; clipboard-write *';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = FULLSCREEN_STYLE;
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

  // On returning from the wallet handoff, wallet.domovina.ai appends the wallet
  // identity to our URL. Read it, CSRF-check the single-use state token, strip the
  // params from the address bar (replaceState — no reload), and resolve connect()
  // with it. Returns null when this isn't a valid return navigation.
  function consumeReturnParams() {
    try {
      const u = new URL(window.location.href);
      const p = u.searchParams;
      if (p.get('dw_return') !== '1') return null;
      const safeAddress = p.get('dw_safe');
      const signerAddress = p.get('dw_signer');
      const credentialId = p.get('dw_cred');
      const state = p.get('dw_state');
      for (const k of ['dw_return', 'dw_safe', 'dw_signer', 'dw_cred', 'dw_state']) p.delete(k);
      const clean = u.pathname + (p.toString() ? '?' + p.toString() : '') + u.hash;
      window.history.replaceState(null, '', clean);
      // CSRF: the returned state must match the single-use token we generated
      // before redirecting. A crafted return URL (attacker-chosen safe/signer) has
      // no matching token → ignored. (Identity decides the campaign Safe owner.)
      let expected = null;
      try {
        expected = sessionStorage.getItem(STATE_KEY);
        sessionStorage.removeItem(STATE_KEY);
      } catch (_) {
        /* ignore */
      }
      if (!expected || !state || state !== expected) return null;
      if (!safeAddress || !signerAddress) return null;
      return { safeAddress, signerAddress, credentialId: credentialId || null };
    } catch (_) {
      return null;
    }
  }

  // On returning from a createAccount() handoff, the wallet appends the newly
  // derived campaign account (dw_account = derived Safe) plus the connecting
  // identity (dw_safe/signer/cred) and the account's saltNonce. Distinguished
  // from a plain connect-return by the presence of dw_account OR dw_error.
  // CSRF-checks the single-use state, strips all dw_* params. Returns null when
  // this isn't a createAccount return (so connect()'s consumer can handle it).
  function consumeAccountReturnParams() {
    try {
      const u = new URL(window.location.href);
      const p = u.searchParams;
      if (p.get('dw_return') !== '1') return null;
      const accountAddress = p.get('dw_account');
      const error = p.get('dw_error');
      if (!accountAddress && !error) return null; // a plain connect-return, not ours
      const safeAddress = p.get('dw_safe');
      const signerAddress = p.get('dw_signer');
      const credentialId = p.get('dw_cred');
      const saltNonce = p.get('dw_salt');
      const state = p.get('dw_state');
      for (const k of [
        'dw_return', 'dw_account', 'dw_safe', 'dw_signer', 'dw_cred', 'dw_salt', 'dw_state', 'dw_error',
      ]) {
        p.delete(k);
      }
      const clean = u.pathname + (p.toString() ? '?' + p.toString() : '') + u.hash;
      window.history.replaceState(null, '', clean);
      let expected = null;
      try {
        expected = sessionStorage.getItem(STATE_KEY);
        sessionStorage.removeItem(STATE_KEY);
      } catch (_) {
        /* ignore */
      }
      if (!expected || !state || state !== expected) return null;
      if (error) return { error };
      if (!accountAddress || !safeAddress || !signerAddress) return null;
      return {
        accountAddress,
        safeAddress,
        signerAddress,
        credentialId: credentialId || null,
        saltNonce: saltNonce || null,
      };
    } catch (_) {
      return null;
    }
  }

  function redirectToWalletForAccount(name) {
    let state = '';
    try {
      state = newState();
      sessionStorage.setItem(STATE_KEY, state);
    } catch (_) {
      /* sessionStorage blocked — proceed without CSRF token */
    }
    const url =
      WALLET_ORIGIN +
      '/?dw_create_account=1' +
      '&dw_name=' +
      encodeURIComponent(name || '') +
      (state ? '&dw_state=' + encodeURIComponent(state) : '') +
      '&dw_return=' +
      encodeURIComponent(location.href);
    window.location.assign(url);
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

  // The connected identity (safe + signer + credentialId) is cached in the HOST
  // page's first-party localStorage so repeat connects are instant and send() can
  // sign from the right wallet. Cleared via Domovina.disconnect().
  const STORE_KEY = 'domovina_connected_v1';
  function storeIdentity(id) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          safeAddress: id.safeAddress,
          signerAddress: id.signerAddress,
          credentialId: id.credentialId || null,
        }),
      );
    } catch (_) {
      /* private mode / blocked storage — non-fatal, just no fast path */
    }
  }
  function loadStoredIdentity() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && v.safeAddress && v.signerAddress) {
        return {
          safeAddress: v.safeAddress,
          signerAddress: v.signerAddress,
          credentialId: v.credentialId || null,
        };
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  const api = {
    /** Resolve the user's wallet identity.
     *  1. returning from the wallet (URL has dw_return, CSRF-checked) → cache + resolve;
     *  2. already connected on this host (cached) → resolve instantly, no prompt;
     *  3. else deterministic full-page redirect to the wallet's curated chooser,
     *     which returns the identity via dw_* params.
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
      redirectToWallet();
      return new Promise(function () {}); // navigation in progress; never resolves
    },
    /** Open a NEW dedicated wallet account (e.g. one per pinka campaign) and
     * resolve with its address. A derived 1-of-2 [signer, recoveryOwner] Safe in
     * the user's DOMOVINA wallet — listed, signable, recoverable like any account.
     *
     * Deterministic full-page handoff, same shape as connect(): the first call
     * redirects to the wallet (which ensures a passkey session, shows a consent
     * card, derives the account locally) and never resolves; on the return
     * navigation the wallet appends dw_account + identity, which this consumes.
     * NOT cached — every call opens a fresh account. Rejects with 'cancelled' if
     * the user declines.
     * → Promise<{ accountAddress, safeAddress, signerAddress, credentialId?, saltNonce? }> */
    createAccount(opts) {
      const returned = consumeAccountReturnParams();
      if (returned) {
        if (returned.error) {
          return Promise.reject(new Error('DOMOVINA: ' + returned.error));
        }
        // The return leg also carries the connect identity — cache it so a later
        // connect() resolves instantly without a second handoff.
        storeIdentity({
          safeAddress: returned.safeAddress,
          signerAddress: returned.signerAddress,
          credentialId: returned.credentialId,
        });
        return Promise.resolve(returned);
      }
      redirectToWalletForAccount(opts && opts.name);
      return new Promise(function () {}); // navigation in progress; never resolves
    },
    /** Forget the cached connection so the next connect() re-picks a wallet. */
    disconnect() {
      try {
        localStorage.removeItem(STORE_KEY);
      } catch (_) {
        /* ignore */
      }
    },
    /** Send EURe. Shows the iframe for the user to confirm + authorize with Face
     * ID. Signs from the connected wallet (credentialId from the connect cache) so
     * it never diverges from the host's connected identity — call connect() first. */
    send({ to, amount }) {
      if (typeof to !== 'string' || typeof amount !== 'string') {
        return Promise.reject(new TypeError('Domovina.send: { to, amount } strings required'));
      }
      const id = loadStoredIdentity();
      if (!id) {
        return Promise.reject(new Error('DOMOVINA: not connected — call connect() first'));
      }
      return postCommand({
        type: 'send',
        to,
        amount,
        credentialId: id.credentialId,
        safeAddress: id.safeAddress,
      });
    },
    /** For diagnostics / debug. */
    _version: '0.10.0',
  };

  Object.defineProperty(window, 'Domovina', { value: api, writable: false });
})();
