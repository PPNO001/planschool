CREATE TABLE IF NOT EXISTS activity_reports (
  report_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_reports_updated_at
  ON activity_reports(updated_at);

CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
