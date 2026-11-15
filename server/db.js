import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company            TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  type               TEXT CHECK (type IN ('Тендер','ЗЦП')),
  number             TEXT NOT NULL DEFAULT '',
  deadline_date      TEXT,
  deadline_time      TEXT,
  deadline_tz        TEXT NOT NULL DEFAULT '',
  deadline_raw       TEXT NOT NULL DEFAULT '',
  url                TEXT NOT NULL DEFAULT '',
  url_status         TEXT NOT NULL DEFAULT 'none',
  url_note           TEXT NOT NULL DEFAULT '',
  review_flags       TEXT NOT NULL DEFAULT '{}',
  is_draft           INTEGER NOT NULL DEFAULT 1,
  needs_requirements INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tender_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id   INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_files_tender ON tender_files(tender_id);

CREATE TABLE IF NOT EXISTS checklist_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id      INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  required       TEXT NOT NULL DEFAULT 'unclear' CHECK (required IN ('yes','no','unclear')),
  source_type    TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('link','screenshot','manual')),
  source_file_id INTEGER REFERENCES tender_files(id) ON DELETE SET NULL,
  excerpt        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  assignee       TEXT NOT NULL DEFAULT '',
  comment        TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_items_tender ON checklist_items(tender_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
