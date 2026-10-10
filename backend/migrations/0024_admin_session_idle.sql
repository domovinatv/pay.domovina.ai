-- Fable 5.1 r2 AD-04: admin session idle timeout. A session unused for
-- SESSION_IDLE_SECONDS (2 h) ends even inside its 12 h lifetime. Updated at
-- most every 5 min per session. NULL (older rows) = fall back to created_at.
ALTER TABLE admin_sessions ADD COLUMN last_seen_at TEXT;
