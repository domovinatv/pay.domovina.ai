-- Fable 5.1 r2 OF-01: one manual 2/3 batch can pay out several parked orders.
-- A resolved_offrail row now names the exact transfer (log index in the tx)
-- it consumed, so each leg closes exactly one order and no leg twice.
-- NULL on every older row (whole-tx claim).
ALTER TABLE monerium_forwards ADD COLUMN tx_log_index INTEGER;
