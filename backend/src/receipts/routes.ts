import { Hono } from 'hono';

import type { Env } from '../types';
import { registerReceiptAnchorRoutes } from './api';

/// ADR 0022 is on unless RECEIPTS is explicitly "0" in wrangler.toml.
export function receiptsEnabled(env: Env): boolean {
  return env.RECEIPTS !== '0';
}

/// Mounted at /api/receipts.
export function buildReceiptAnchorApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();
  registerReceiptAnchorRoutes(api);
  return api;
}
