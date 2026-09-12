CREATE TABLE yearbooks (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 9999),
  title TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT 'photo' CHECK (template IN ('photo', 'text')),
  cover_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  intro_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX yearbooks_year ON yearbooks(deleted_at, year DESC, updated_at DESC);

CREATE TABLE yearbook_chapters (
  id TEXT PRIMARY KEY,
  yearbook_id TEXT NOT NULL REFERENCES yearbooks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('cover', 'opening', 'month', 'firsts', 'photos', 'letter', 'custom')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (yearbook_id, position)
);
CREATE INDEX yearbook_chapters_book ON yearbook_chapters(yearbook_id, position);

CREATE TABLE yearbook_blocks (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES yearbook_chapters(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('paragraph', 'image', 'quote', 'record')),
  body TEXT NOT NULL DEFAULT '',
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  record_id TEXT REFERENCES records(id) ON DELETE SET NULL,
  caption TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chapter_id, position)
);
CREATE INDEX yearbook_blocks_chapter ON yearbook_blocks(chapter_id, position);
CREATE INDEX yearbook_blocks_record ON yearbook_blocks(record_id);

CREATE TABLE yearbook_sources (
  chapter_id TEXT NOT NULL REFERENCES yearbook_chapters(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  PRIMARY KEY (chapter_id, record_id)
);
CREATE INDEX yearbook_sources_record ON yearbook_sources(record_id);

CREATE TABLE yearbook_versions (
  id TEXT PRIMARY KEY,
  yearbook_id TEXT NOT NULL REFERENCES yearbooks(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  source TEXT NOT NULL CHECK (source IN ('manual', 'ai')),
  label TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (yearbook_id, version_no)
);
CREATE INDEX yearbook_versions_book ON yearbook_versions(yearbook_id, version_no DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  yearbook_id TEXT REFERENCES yearbooks(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  output_path TEXT,
  error_message TEXT,
  max_duration_ms INTEGER NOT NULL DEFAULT 120000 CHECK (max_duration_ms > 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, idempotency_key)
);
CREATE INDEX tasks_status ON tasks(status, updated_at DESC);
CREATE INDEX tasks_yearbook ON tasks(yearbook_id, created_at DESC);
