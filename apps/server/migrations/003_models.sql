CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('responses', 'chat-completions')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 600000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 131072),
  stream_enabled INTEGER NOT NULL DEFAULT 0 CHECK (stream_enabled IN (0, 1)),
  credential_mode TEXT NOT NULL CHECK (credential_mode IN ('windows', 'session', 'none')),
  credential_ref TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX model_profiles_one_active ON model_profiles(is_active) WHERE is_active = 1;
