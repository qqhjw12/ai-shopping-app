// SQLite 连接（Node 22 内置 node:sqlite，零依赖零编译）。
// 单例 + WAL：读写并发更友好，且进程异常退出后数据文件仍一致。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

let db = null;

/** 获取（并懒初始化）数据库连接 */
export function getDb() {
  if (db) return db;
  const file = resolve(process.cwd(), config.dbFile);
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  // WAL 提升并发读；外键约束必须显式开启（SQLite 默认关闭）
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

/** 事务包装：回调内抛错自动回滚 */
export function tx(fn) {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const out = fn(conn);
    conn.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 回滚失败不掩盖原始异常 */
    }
    throw e;
  }
}
