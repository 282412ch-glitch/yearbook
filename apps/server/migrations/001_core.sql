CREATE TABLE records (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  occurred_on TEXT,
  location TEXT NOT NULL DEFAULT '',
  is_first INTEGER NOT NULL DEFAULT 0 CHECK (is_first IN (0, 1)),
  include_in_yearbook INTEGER NOT NULL DEFAULT 1 CHECK (include_in_yearbook IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX records_date ON records(deleted_at, occurred_on DESC, created_at DESC);
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  suggested_date TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE record_media (
  record_id TEXT NOT NULL REFERENCES records(id),
  media_id TEXT NOT NULL REFERENCES media(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  caption TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (record_id, media_id),
  UNIQUE (record_id, position)
);
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE record_people (
  record_id TEXT NOT NULL REFERENCES records(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (record_id, person_id)
);
CREATE TABLE record_tags (
  record_id TEXT NOT NULL REFERENCES records(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (record_id, tag_id)
);
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX reflections_record ON reflections(record_id, created_at);
CREATE TABLE memory_history (
  record_id TEXT PRIMARY KEY REFERENCES records(id),
  shown_at TEXT NOT NULL
);
