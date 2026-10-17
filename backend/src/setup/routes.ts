import type { Hono } from 'hono';

import type { Env } from '../types';
import { getTenant, listCampaigns } from '../tenants/db';
import {
  CHIADO_RPC_DEFAULT,
  GNOSIS_RPC_DEFAULT,
  getTenantRailRow,
  isLegacyTenant,
  parseChain,
} from '../tenants/rail';
import { SETUP_CLIENT_JS } from './client.generated';

/// Tenant on-chain setup dApp (ADR 0027). The page plans the ProjectRouter
/// role (ADR 0026) from the chain, and the owners propose, sign and execute it
/// with their own wallet. The Worker only serves the page and the tenant's
/// public rail facts: it holds no owner key and signs nothing here.

export interface SetupContext {
  tenantId: string;
  tenantName: string;
  legacy: boolean;
  chain: 'gnosis' | 'chiado';
  chainId: number;
  rpcUrl: string;
  safe: string;
  roles: string | null;
  roleKey: string | null;
  router: string | null;
  eure: string;
  /// First block of the modifier's events; null = the page asks Blockscout.
  fromBlock: string | null;
  recipients: { address: string; label: string | null; campaignId: string }[];
  /// Revoked campaigns whose Safe no active campaign uses: the plan takes
  /// them out of the role, so D1 stays the desired state in both directions.
  revoked?: { address: string; label: string | null; campaignId: string }[];
}

const CHAIN_ID = { gnosis: 100, chiado: 10200 } as const;
const EURE_DEFAULT = {
  gnosis: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
  chiado: '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71',
} as const;
/// Batch 001 set the MPT modifier up in this block (safe-tx/009 ENVS.gnosis).
const LEGACY_FROM_BLOCK = '46280000';
const BLOCKSCOUT = { gnosis: 'https://gnosis.blockscout.com', chiado: 'https://gnosis-chiado.blockscout.com' } as const;

export async function loadSetupContext(env: Env, tenantId: string): Promise<SetupContext | { error: string }> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return { error: 'tenant_not_found' };
  const all = await listCampaigns(env, tenantId);
  const view = (c: (typeof all)[number]) => ({ address: c.safe_address, label: c.label, campaignId: c.campaign_id });
  const recipients = all.filter((c) => c.revoked_at === null).map(view);
  const active = new Set(recipients.map((r) => r.address.toLowerCase()));
  const revoked = all.filter((c) => c.revoked_at !== null && !active.has(c.safe_address.toLowerCase())).map(view);
  if (isLegacyTenant(env, tenantId)) {
    return {
      tenantId,
      tenantName: tenant.name,
      legacy: true,
      chain: 'gnosis',
      chainId: CHAIN_ID.gnosis,
      rpcUrl: env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT,
      safe: env.SAFE_ADDRESS ?? '',
      roles: env.ROLES_MODIFIER_ADDRESS || null,
      roleKey: env.PROJECT_ROUTER_ROLE_KEY || null,
      // The legacy router key is generated offline (safe-tx/000): the page asks for its address.
      router: null,
      eure: env.EURE_CONTRACT || EURE_DEFAULT.gnosis,
      fromBlock: LEGACY_FROM_BLOCK,
      recipients,
      revoked,
    };
  }
  const row = await getTenantRailRow(env, tenantId);
  if (!row) return { error: 'rail_not_found' };
  const chain = parseChain(row.chain) ?? 'gnosis';
  return {
    tenantId,
    tenantName: tenant.name,
    legacy: false,
    chain,
    chainId: CHAIN_ID[chain],
    rpcUrl: row.rpc_url || (chain === 'gnosis' ? env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT : CHIADO_RPC_DEFAULT),
    safe: row.receiving_safe,
    roles: row.roles_modifier,
    roleKey: row.role_key,
    router: row.router_address,
    eure: row.eure_contract || EURE_DEFAULT[chain],
    fromBlock: null,
    recipients,
    revoked,
  };
}

/// Hosts the page talks to directly (CSP connect-src): the rail RPC, the Safe
/// Transaction Service and Blockscout. Everything else stays 'self'.
export function setupConnectSrc(ctx: Pick<SetupContext, 'rpcUrl' | 'chain'>): string {
  const hosts = new Set<string>(['https://api.safe.global', BLOCKSCOUT[ctx.chain]]);
  try {
    hosts.add(new URL(ctx.rpcUrl).origin);
  } catch {
    /* bad rpc_url: the page reports it */
  }
  return [...hosts].join(' ');
}

/// Content hash in the script URL: every deploy busts the 5-minute cache.
const CLIENT_VERSION = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < SETUP_CLIENT_JS.length; i++) h = Math.imul(h ^ SETUP_CLIENT_JS.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
})();

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/// JSON inside <script type="application/json">: `<` escaped so a label can
/// never close the tag.
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const STYLE = `
:root{--navy:#002F6C;--red:#c00;--ok:#0a7a33;--muted:#667;--line:#dde;--bg:#fff;--fg:#111}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e8eaf0;--muted:#99a;--line:#2a3142;--navy:#8fb3ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:920px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:1.6rem 0 .5rem;color:var(--navy)}
a{color:var(--navy)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:.85em;word-break:break-all}.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:.35rem .4rem;text-align:left;vertical-align:top}
th{font-weight:600;width:30%}button{font:inherit;padding:.45rem .9rem;border-radius:6px;border:1px solid var(--navy);background:var(--navy);color:#fff;cursor:pointer;margin:.2rem .3rem .2rem 0}
button.sec{background:transparent;color:var(--navy)}button:disabled{opacity:.45;cursor:default}
input{font:inherit;padding:.4rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%;max-width:560px}
.ok{color:var(--ok)}.bad{color:var(--red)}.box{border:1px solid var(--line);border-radius:8px;padding:.8rem 1rem;margin:.6rem 0}
ol.steps li{margin:.3rem 0}.log{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:var(--muted);max-height:240px;overflow:auto}
`;

export function renderSetupPage(ctx: SetupContext): string {
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>On-chain setup — ${esc(ctx.tenantId)} — MPT Admin</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="muted"><a href="/admin/tenants">← Tenanti</a></p>
<h1>On-chain setup: ${esc(ctx.tenantName)} <span class="muted mono">${esc(ctx.tenantId)}</span></h1>
<p class="muted">ProjectRouter (ADR 0026) iz stanja na lancu. Prijedlog, potpis i izvršenje rade vlasnici Safe-a
svojim novčanikom (ADR 0027); server ovdje ništa ne potpisuje.</p>
<div id="app"><p>Učitavam…</p></div>
<noscript><p class="bad">Stranica treba JavaScript.</p></noscript>
</main>
<script type="application/json" id="setup-config">${jsonForScript(ctx)}</script>
<script src="/admin/setup/client.js?v=${CLIENT_VERSION}" defer></script>
</body>
</html>`;
}

/// Mounted after mountAdminAuth: the page and its API sit behind the admin
/// session like the rest of /admin.
export function mountSetupPages(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/setup/client.js', () =>
    new Response(SETUP_CLIENT_JS, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
    }));

  app.get('/admin/tenants/:id/setup', async (c) => {
    const ctx = await loadSetupContext(c.env, c.req.param('id'));
    if ('error' in ctx) return c.text(ctx.error, 404);
    c.header('x-admin-connect-src', setupConnectSrc(ctx));
    return c.html(renderSetupPage(ctx));
  });

  app.get('/admin/api/tenants/:id/setup', async (c) => {
    const ctx = await loadSetupContext(c.env, c.req.param('id'));
    if ('error' in ctx) return c.json(ctx, 404);
    return c.json(ctx);
  });
}
