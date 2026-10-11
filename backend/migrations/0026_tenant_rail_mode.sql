-- How a tenant's rail settles an intent (docs/2026-10-11-funding-po-projektu.md).
--
-- 'forward' (default, ADR 0017): Monerium mints into the tenant's receiving
--   Safe and the rail forwards EURe on through Zodiac Roles.
-- 'direct': the payer's reference `<chain>:0x<project Safe> sid:<sid>` makes
--   Monerium mint straight into the project Safe. The rail only matches the
--   order to its intent; it never signs, so no Roles, role key or cap.
--
-- Additive; every existing row keeps 'forward'.
ALTER TABLE tenant_rail ADD COLUMN mode TEXT NOT NULL DEFAULT 'forward';
