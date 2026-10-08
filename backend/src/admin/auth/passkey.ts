// Preneseno iz bank-push-gateway/worker/src/admin/passkey.ts — držati u skladu.
// WebAuthn ceremonije preko @simplewebauthn/server (CBOR/COSE/potpis se ne pišu ručno).
// Isti obrazac kao crosulja-hr/site/src/lib/webauthn.ts.
//
// rpID i origin izvode se iz zahtjeva: ključ upisan na localhostu ne otvara produkciju.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Env } from "../../types";
import { adminEmails } from "./env";
import { consumeChallenge, storeChallenge } from "./session";

const RP_NAME = "MPT admin";

interface PasskeyRow {
  id: string;
  email: string;
  public_key: string;
  counter: number;
  transports: string | null;
}

const ctx = (url: URL) => ({ rpID: url.hostname, origin: url.origin });
const transports = (t: string | null) => (t ? (t.split(",") as AuthenticatorTransport[]) : undefined);

export async function registrationOptions(env: Env, url: URL, email: string) {
  const existing = await env.DB.prepare("SELECT id, transports FROM admin_passkeys WHERE email = ?")
    .bind(email)
    .all<{ id: string; transports: string | null }>();
  const userID = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: ctx(url).rpID,
    userName: email,
    userID,
    attestationType: "none",
    excludeCredentials: existing.results.map((k) => ({ id: k.id, transports: transports(k.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await storeChallenge(env, options.challenge, "register", email);
  return options;
}

export async function verifyRegistration(
  env: Env,
  url: URL,
  email: string,
  response: RegistrationResponseJSON,
  label: string,
): Promise<boolean> {
  const { rpID, origin } = ctx(url);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: async (c) => (await consumeChallenge(env, c, "register"))?.email === email,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) return false;
  const { credential } = result.registrationInfo;
  await env.DB.prepare(
    `INSERT INTO admin_passkeys (id, email, public_key, counter, transports, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      credential.id,
      email,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      credential.transports?.join(",") ?? null,
      label.slice(0, 80) || "passkey",
      new Date().toISOString(),
    )
    .run();
  return true;
}

export async function loginOptions(env: Env, url: URL) {
  const options = await generateAuthenticationOptions({
    rpID: ctx(url).rpID,
    userVerification: "required",
    allowCredentials: [], // discoverable: autentifikator sam ponudi ključ za ovu domenu
  });
  await storeChallenge(env, options.challenge, "login", null);
  return options;
}

/** Vraća e-mail vlasnika ključa ili null. Poruke greške namjerno ne razlikuju razloge. */
export async function verifyLogin(env: Env, url: URL, response: AuthenticationResponseJSON): Promise<string | null> {
  const key = await env.DB.prepare(
    "SELECT id, email, public_key, counter, transports FROM admin_passkeys WHERE id = ?",
  )
    .bind(response.id)
    .first<PasskeyRow>();
  if (!key || !adminEmails(env).has(key.email)) return null;

  const { rpID, origin } = ctx(url);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: async (c) => (await consumeChallenge(env, c, "login")) !== null,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: key.id,
      publicKey: isoBase64URL.toBuffer(key.public_key),
      counter: key.counter,
      transports: transports(key.transports),
    },
  }).catch(() => null);
  if (!result?.verified) return null;

  await env.DB.prepare("UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, new Date().toISOString(), key.id)
    .run();
  return key.email;
}
