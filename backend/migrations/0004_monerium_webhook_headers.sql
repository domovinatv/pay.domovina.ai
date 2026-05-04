-- Add headers JSON to webhook events log so we can replay/debug signature
-- verification offline against any past event.
ALTER TABLE monerium_webhook_events ADD COLUMN headers_json TEXT;
