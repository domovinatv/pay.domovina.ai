import { describe, expect, it } from 'vitest';

import { makeForwardDeps } from '../src/monerium/forward';
import {
  getReferenceStyle,
  intentReference,
  legacyRail,
  legacyRailMode,
} from '../src/tenants/rail';
import type { Env } from '../src/types';

// ADR 0025: the default tenant (ITalk) moves to direct mode with one env flag.
// The router key must not even be read, and references become `gnosis:`.

const ITALK_SAFE = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';
const PROJECT_SAFE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';

function env(over: Partial<Env> = {}): Env {
  return {
    DEFAULT_TENANT_ID: 'italk',
    MONERIUM_BASE_URL: 'https://api.monerium.app',
    MONERIUM_CLIENT_ID: 'italk-client',
    MONERIUM_CLIENT_SECRET: 'italk-secret',
    MONERIUM_WEBHOOK_SECRET: 'whsec_italk',
    SAFE_ADDRESS: ITALK_SAFE,
    ROLES_MODIFIER_ADDRESS: '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
    ROLE_KEY: '0xrole',
    ROUTER_PRIVATE_KEY: '0xitalk-router',
    EURE_CONTRACT: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    PAYMENT_REGISTRY_ADDRESS: '0xregistry',
    MULTISEND_ADDRESS: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
    MULTI_TENANT_RAIL: '1',
    // Any DB read would throw: the default tenant's style comes from env only.
    DB: new Proxy({}, { get: () => { throw new Error('DB must not be read'); } }),
    ...over,
  } as unknown as Env;
}

describe('legacyRailMode', () => {
  it('unset or forward keeps the router path', () => {
    expect(legacyRailMode(env())).toBe('forward');
    expect(legacyRailMode(env({ LEGACY_RAIL_MODE: 'forward' }))).toBe('forward');
    expect(legacyRailMode(env({ LEGACY_RAIL_MODE: '' }))).toBe('forward');
  });

  it('direct, with or without whitespace', () => {
    expect(legacyRailMode(env({ LEGACY_RAIL_MODE: 'direct' }))).toBe('direct');
    expect(legacyRailMode(env({ LEGACY_RAIL_MODE: ' direct\n' }))).toBe('direct');
  });

  it('an unknown value fails closed to the mode that cannot sign', () => {
    expect(legacyRailMode(env({ LEGACY_RAIL_MODE: 'drect' }))).toBe('direct');
  });
});

describe('legacyRail in direct mode', () => {
  it('never loads the router key or the MultiSend path', () => {
    const r = legacyRail(env({ LEGACY_RAIL_MODE: 'direct' }));
    expect(r.mode).toBe('direct');
    expect(r.legacy).toBe(true);
    expect(r.receivingSafe).toBe(ITALK_SAFE.toLowerCase());
    expect(r.signer.privateKey).toBe('');
    expect(r.signer.paymentRegistry).toBe('');
    expect(r.signer.multiSend).toBe('');
    // Monerium credentials stay: direct mode still reads orders and webhooks.
    expect(r.monerium.clientSecret).toBe('italk-secret');
    expect(r.webhookSecret).toBe('whsec_italk');
  });

  it('forward mode is unchanged (no mode field, key present)', () => {
    const r = legacyRail(env());
    expect(r.mode).toBeUndefined();
    expect(r.signer.privateKey).toBe('0xitalk-router');
  });

  it('the forward dep refuses even if a path forgets to ask the gate', async () => {
    const deps = makeForwardDeps(env({ LEGACY_RAIL_MODE: 'direct' }), legacyRail(env({ LEGACY_RAIL_MODE: 'direct' })));
    const res = await deps.forward({} as never);
    expect(res).toEqual({ ok: false, error: 'router_disabled: direct mode never signs' });
  });
});

describe('payment reference for the default tenant', () => {
  const intent = { target_address: PROJECT_SAFE, sid: 'abc123' };

  it('direct: gnosis:<project Safe> sid:<sid>, for tenant id and for legacy null', async () => {
    const e = env({ LEGACY_RAIL_MODE: 'direct' });
    for (const tenantId of ['italk', null]) {
      const style = await getReferenceStyle(e, tenantId);
      expect(style).toEqual({ mode: 'direct', chain: 'gnosis' });
      expect(intentReference(style, intent)).toBe(`gnosis:${PROJECT_SAFE} sid:abc123`);
    }
  });

  it('forward: the mpt: reference, as before', async () => {
    const style = await getReferenceStyle(env(), 'italk');
    expect(style).toBeNull();
    expect(intentReference(style, intent)).toBe(`mpt:${PROJECT_SAFE}?sid=abc123`);
  });
});
