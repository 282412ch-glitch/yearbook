CREATE TABLE ai_task_inputs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  scope_record_ids_json TEXT NOT NULL,
  scope_media_ids_json TEXT NOT NULL,
  source_snapshots_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tools', 'fixed')),
  warnings_json TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT,
  scope_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE ai_task_stages (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  label TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, stage_key)
);
CREATE TABLE ai_drafts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('title', 'polish', 'questions', 'monthly', 'chapter', 'yearbook', 'agent')),
  mode TEXT NOT NULL CHECK (mode IN ('tools', 'fixed')),
  year INTEGER,
  month INTEGER,
  scope_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  content_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'adopted')),
  adopted_yearbook_id TEXT REFERENCES yearbooks(id) ON DELETE SET NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, version_no)
);
CREATE INDEX ai_drafts_scope ON ai_drafts(scope_key, version_no DESC);
CREATE INDEX ai_drafts_created ON ai_drafts(created_at DESC);
CREATE TABLE ai_draft_sources (
  draft_id TEXT NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(id),
  PRIMARY KEY (draft_id, source_path, record_id)
);
CREATE TABLE ai_draft_media (
  draft_id TEXT NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id),
  PRIMARY KEY (draft_id, media_id)
);
CREATE TABLE ai_draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source TEXT NOT NULL CHECK (source IN ('generated', 'manual')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, revision)
);
