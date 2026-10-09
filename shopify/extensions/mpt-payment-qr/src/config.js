/// Worker that owns the Shopify ↔ MPT mapping (shopify/worker).
///
/// Build-time config: scripts/deploy-app.sh rewrites this file from the
/// `application_url` of the app being deployed, then restores it. Committed
/// value = the shared worker, used by `shopify app dev` and plain deploys.
export const API = 'https://mpt-shopify.domovina.ai';
