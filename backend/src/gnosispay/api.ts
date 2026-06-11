import { Hono } from 'hono';

import type { Env } from '../types';
import { getGpUser, upsertGpUser } from './db';

/// Gnosis Pay onboarding mirror (Faza 1 — docs/plans/gnosis-pay-cards/).
///
/// - POST /api/gp/sync                          — FE mirror onboarding stanja
/// - GET  /api/gp/:credentialId/:safeAddress    — lookup (support/debug)
///
/// Tanak by design: server NE može zvati GP API u ime korisnika (user-scoped
/// SIWE JWT), pa je ovo čisti write-behind keš onoga što FE ionako zna.
/// Mount: app.route('/api/gp', buildGnosisPayApi())

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const STEPS = new Set([
  'anon',
  'signup',
  'terms',
  'kyc',
  'kyc-pending',
  'kyc-action',
  'kyc-rejected',
  'sof',
  'phone',
  'deploy',
  'ready',
]);

interface SyncBody {
  credentialId?: string;
  safeAddress?: string;
  gpUserId?: string;
  gpSigner?: string;
  gpSafeAddress?: string;
  onboardingStep?: string;
  kycStatus?: string;
}

export function buildGnosisPayApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.post('/sync', async (c) => {
    let body: SyncBody;
    try {
      body = await c.req.json<SyncBody>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.credentialId || !HEX_RE.test(body.credentialId)) {
      return c.json({ error: 'invalid_credential_id' }, 400);
    }
    if (!body.safeAddress || !ADDR_RE.test(body.safeAddress)) {
      return c.json({ error: 'invalid_safe_address' }, 400);
    }
    if (!body.gpSigner || !ADDR_RE.test(body.gpSigner)) {
      return c.json({ error: 'invalid_gp_signer' }, 400);
    }
    if (!body.onboardingStep || !STEPS.has(body.onboardingStep)) {
      return c.json({ error: 'invalid_onboarding_step' }, 400);
    }
    if (body.gpSafeAddress && !ADDR_RE.test(body.gpSafeAddress)) {
      return c.json({ error: 'invalid_gp_safe_address' }, 400);
    }
    await upsertGpUser(c.env, {
      credentialId: body.credentialId,
      safeAddress: body.safeAddress,
      gpUserId: body.gpUserId ?? null,
      gpSigner: body.gpSigner,
      gpSafeAddress: body.gpSafeAddress ?? null,
      onboardingStep: body.onboardingStep,
      kycStatus: body.kycStatus ?? null,
    });
    return c.json({ ok: true });
  });

  api.get('/:credentialId/:safeAddress', async (c) => {
    const credentialId = c.req.param('credentialId');
    const safeAddress = c.req.param('safeAddress');
    if (!HEX_RE.test(credentialId) || !ADDR_RE.test(safeAddress)) {
      return c.json({ error: 'invalid_params' }, 400);
    }
    const row = await getGpUser(c.env, credentialId, safeAddress);
    if (!row) return c.json({ error: 'not_found' }, 404);
    // Public lookup — vrati samo ne-osjetljivi mirror (kao i wallet registry).
    return c.json({
      safeAddress: row.safe_address,
      gpSafeAddress: row.gp_safe_address,
      onboardingStep: row.onboarding_step,
      kycStatus: row.kyc_status,
      updatedAt: row.updated_at,
    });
  });

  return api;
}
