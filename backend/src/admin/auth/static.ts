// Preneseno iz bank-push-gateway/worker/src/admin/static.ts — držati u skladu.
// Klijentski WebAuthn: prijava (#passkey-login) i upis (#passkey-register).

export const PASSKEY_JS = `
"use strict";
const b64uToBuf = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const bufToB64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");

function credToJSON(c) {
  if (typeof c.toJSON === "function") return c.toJSON();
  const r = c.response;
  const response = { clientDataJSON: bufToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufToB64u(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    response.authenticatorData = bufToB64u(r.authenticatorData);
    response.signature = bufToB64u(r.signature);
    if (r.userHandle) response.userHandle = bufToB64u(r.userHandle);
  }
  return { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, response,
    clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment };
}

function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: b64uToBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
}

function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

function show(el, text, bad) {
  if (!el) return;
  el.textContent = text;
  el.className = "msg" + (bad ? " bad" : "");
  el.hidden = false;
}

const loginBtn = document.getElementById("passkey-login");
if (loginBtn) {
  loginBtn.addEventListener("click", async () => {
    const msg = document.getElementById("msg");
    try {
      const opts = await post("/admin/passkey/login/options");
      const cred = await navigator.credentials.get({ publicKey: requestOptions(opts) });
      const res = await post("/admin/passkey/login/verify", { response: credToJSON(cred), next: loginBtn.dataset.next });
      location.href = res.next;
    } catch (e) {
      show(msg, "Prijava nije uspjela: " + e.message, true);
    }
  });
}

const regForm = document.getElementById("passkey-register");
if (regForm) {
  regForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById("msg");
    try {
      const opts = await post("/admin/passkey/register/options");
      const cred = await navigator.credentials.create({ publicKey: creationOptions(opts) });
      await post("/admin/passkey/register/verify", { response: credToJSON(cred), label: regForm.label.value });
      location.reload();
    } catch (e) {
      show(msg, "Upis nije uspio: " + e.message, true);
    }
  });
}
`;
