import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Vite/Vitest 的模块解析会把 "node:sqlite" 的前缀去掉导致找不到,所以用 require 加载
const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSync;

/** 迁移按顺序执行,只增不改。user_version 记录已执行到哪一步。 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_url TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    authorization TEXT NOT NULL,
    allowed_domains TEXT NOT NULL DEFAULT '[]',
    allow_ai INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    plan_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (project_id, url)
  );

  CREATE TABLE captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    final_url TEXT,
    page_title TEXT NOT NULL DEFAULT '',
    state_label TEXT NOT NULL DEFAULT '',
    interaction TEXT,
    viewport_w INTEGER NOT NULL,
    viewport_h INTEGER NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    error TEXT,
    notes TEXT NOT NULL DEFAULT '[]',
    browser TEXT NOT NULL DEFAULT '',
    wait TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    screenshot_path TEXT,
    dom_path TEXT,
    structure_path TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, code)
  );

  CREATE TABLE features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'accepted',
    category TEXT,
    acceptance TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE feature_pages (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY (feature_id, page_id)
  );

  CREATE TABLE feature_evidence (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    PRIMARY KEY (feature_id, evidence_id)
  );

  CREATE TABLE gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    capture_id INTEGER REFERENCES captures(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_pages_project ON pages(project_id);
  CREATE INDEX idx_captures_page ON captures(page_id);
  CREATE INDEX idx_features_project ON features(project_id);
  CREATE INDEX idx_gaps_project ON gaps(project_id);
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSyncImpl(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = row.user_version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i] as string);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const depth = new WeakMap<Db, number>();

/** 可重入的事务:最外层用 BEGIN,嵌套时用 SAVEPOINT,内层失败只回滚内层 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const begin = level === 0 ? 'BEGIN' : `SAVEPOINT sp${level}`;
  const commit = level === 0 ? 'COMMIT' : `RELEASE sp${level}`;
  const rollback = level === 0 ? 'ROLLBACK' : `ROLLBACK TO sp${level}; RELEASE sp${level}`;
  db.exec(begin);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(commit);
    return result;
  } catch (err) {
    db.exec(rollback);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export const now = (): string => new Date().toISOString();
