CREATE TABLE future_letters (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  unlock_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sealed_at TEXT,
  read_at TEXT,
  deleted_at TEXT,
  CHECK (sealed_at IS NULL OR unlock_on IS NOT NULL),
  CHECK (read_at IS NULL OR sealed_at IS NOT NULL)
);
CREATE INDEX future_letters_due ON future_letters(deleted_at, unlock_on, read_at);
CREATE TABLE future_letter_media (
  letter_id TEXT NOT NULL REFERENCES future_letters(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  caption TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (letter_id, media_id),
  UNIQUE (letter_id, position)
);
CREATE INDEX future_letter_media_lookup ON future_letter_media(media_id);
