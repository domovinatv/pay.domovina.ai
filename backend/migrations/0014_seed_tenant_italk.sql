-- Seed the first tenant (ITalk d.o.o. — the entity that holds the Monerium KYB
-- and whose IBAN the SEPA leg lands on) and snapshot every payout address that
-- is legitimately in circulation on 2026-08-01, so switching the forward path
-- to fail-closed breaks nothing that already works.
--
-- Snapshot method (NOT invented — read out of the production D1 before the
-- migration was written):
--   SELECT lower(target_address) FROM payment_intents
--   UNION SELECT lower(target_address) FROM monerium_forwards
--   UNION SELECT lower(safe_address)   FROM wallet_registry
--   UNION SELECT lower(safe_address)   FROM wallet_accounts
-- 52 distinct addresses (+2 explicitly authorised below = 53 seeded); the MPT
-- Safe itself
-- (0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e) is deliberately NOT seeded —
-- a memo pointing at the Safe is the self-target no-op branch, which never
-- moves value and therefore needs no payout permission.
--
-- Most of these are DOMOVINA Wallet Safes that the "wallet_registry" dynamic
-- source would allow anyway; they are snapshotted here as well so the static
-- table alone is a complete, auditable record of what was live at cutover.
--
-- Verified at write time: 0 pending intents, so no in-flight payment can be
-- orphaned by the cutover.

INSERT OR IGNORE INTO tenants
  (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at)
VALUES (
  'italk',
  'ITalk d.o.o.',
  'active',
  -- Self-registered DOMOVINA Wallet Safes stay allowed without an admin step.
  '["wallet_registry"]',
  -- SEPA collection leg. This is ITalk's DEFAULT Monerium account — the one
  -- that passed KYB — and every QR this tenant issues must collect on it.
  -- Canonical form, no spaces; surfaced grouped (EE70 7777 0001 6292 1128).
  'ITalk d.o.o.',
  'EE707777000162921128',
  'LHVBEE22',
  strftime('%s','now'),
  strftime('%s','now')
);

-- Every intent that predates tenants belongs to the first tenant.
UPDATE payment_intents SET tenant_id = 'italk' WHERE tenant_id IS NULL;

INSERT OR IGNORE INTO tenant_payout_addresses
  (tenant_id, address, label, source, created_at, created_by)
VALUES
  ('italk', '0x005b9547a491525e9f6baa37d40629620c33491e', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x081d73b712de81cfa3a74f64ace62115a7bad834', 'seed 2026-08-01: forward', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x0fe72f49936158936820198d8b0af0ef509559f3', 'seed 2026-08-01: forward+intent', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x13bb7e412838bf6b1cfc0648c594f05082f011a3', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x18ada77af0b7bb00f241debcba443c86c94da01c', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x1b4b0b8cdba9bd84a3732bba78a9f88e82d17ff2', 'seed 2026-08-01: intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x1be2639aa9f82fd15191676fec5d1c7fa269aaa0', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x1f3932975f6290d25790718bbba38569b72275ff', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x36d0605c35357674a8c6bdef78976d1e90fdd27d', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x402e779011f91f6c7427e7d0575eb3080d8abad2', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x404e089237338e94f413be9e2c589fd17fbf6a61', 'seed 2026-08-01: forward+intent+wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x45268cac7df75dfb6f9277ae785d87297e571d7a', 'seed 2026-08-01: intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x4e0c1b53440cfff53ff9ec92eabfc3decf7dc6ea', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x513b3d7658b3fd9891bcc5f3a8c0c1da7492e129', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x51c1c10519667e92d11caf5458a7a485942369c4', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x575fe66a0533fa2a237fdcbd9a2d35288fac1f7b', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x5d7eea89b23ff0128034ea5bed2d1ee18dc0b91f', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x5e79bfc14d980b94ed7017e238be9a754e6ea84c', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e', 'ITalk payout Safe (odobrio Matija 2026-08-01); seed: forward+intent', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x6c6734fe750aa9f0a11db784958aaf9bcc2d3ded', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x6e4218f80b9ecf78c3fa8068cefc4072b7ad936f', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x711df0353e9f4e692e7d7e6518e5905182ab20c9', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x7830323e496b3c8f20cc4bc8ae3d0c01314aaac0', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x791f8cd4e0722009801d7ea1aa968235575ca17e', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x79928d07acff583e3f5c958c450dcd77411d0833', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x80ee57e9ee6334f0398ad16505b1e7e7cb915d32', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x82dc7d633abcefc990688c0ee61b709e23c067bd', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x851ffe320c1c0cefc6fbaa9f69f4dac82b362610', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x86a5623de35fda327ded5e766d5a1f64138b4565', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x95a34dfb0b2bcdf1f24e3c7583a7e259d4d39d60', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x95b8a4ecda0272abef219954a06566c892eeece5', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x96a3018ca2836cd43b85ca9685fa5d0e9f1ae024', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x982ae56bf88bd81db6435e2b668658b5f31dc92a', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x9ba868cbecc5ed12d651b61374ea4deb8b52d372', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x9cb6d2b072550b778998af11ddb9d549921b26fa', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xa34f2f2115117f6d31f3411e2a9afd0eaafa1ff1', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xa827393cd885ba5db0388df76880f1bd3f52fc38', 'seed 2026-08-01: intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xace7901d3816fbdc80c8bbc4c450bfd27ee508ee', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xb20d9e88ea88a82f1006e9d5064d5639a89af7f5', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xb563f6cefbfbf5b1a4e1663e3e79f3eb9526a1d5', 'seed 2026-08-01: intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xb5af5e1bdf394220168849dc103d79c15890fe31', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xb64bbe4876b70a77bb4b4173cd03cbb4ea3c3292', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xcd11210e33f1af09f5ce4127c357f7451dc79587', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xd3a5a795a2b5d804f80f9aa4396a7a4d7231a24e', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xe4bf41522dddaf46bcdaafdca79ce60d0a26f49b', 'seed 2026-08-01: intent', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xee89ed7b817169d6293a77ffcb9fedc5176fc456', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xeef5f5d03422ca34576b142be76a0f14745cfae4', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xf03242cfe86531c3d113b650bd504af0ab28cfce', 'seed 2026-08-01: forward+intent+wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xf4c2d36bcd5464fcf528a213380e18fc05bf92d1', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xfafbb0d92af418e6b2fc89dc1e8ed4ad88814764', 'seed 2026-08-01: wallet_registry', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xff8fc72e081b22a706aefcb5c43d2f7b61c3fcff', 'seed 2026-08-01: wallet_account', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0xb2af1dc5a6290c3b9c69c486014203c823bd7a9c', 'ITalk payout Safe (odobrio Matija 2026-08-01)', 'seed', strftime('%s','now'), 'migration:0014'),
  ('italk', '0x7582f6f5f876e294627934ade3e5b7d1d231b030', 'ITalk payout Safe (odobrio Matija 2026-08-01)', 'seed', strftime('%s','now'), 'migration:0014');
