ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
CREATE INDEX tasks_deleted ON tasks(deleted_at, created_at DESC, id DESC);
