// 埋点仓储：local 模式落 SQLite（替代原内存环形缓冲，重启不丢），聚合走 SQL。
import { getDb } from '../db/connection.js';

export function recordEvent({ event, source, productId, userId, meta }) {
  getDb()
    .prepare(
      'INSERT INTO track_events (event, source, product_id, user_id, meta, ts) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      String(event || 'unknown').slice(0, 64),
      String(source || 'unknown').slice(0, 64),
      productId ? String(productId) : null,
      String(userId || 'anonymous').slice(0, 64),
      JSON.stringify(meta && typeof meta === 'object' ? meta : {}),
      new Date().toISOString(),
    );
}

function rowsToMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.k, r.n]));
}

export function stats({ productId, source } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (productId) {
    where.push('product_id = ?');
    args.push(productId);
  }
  if (source) {
    where.push('source = ?');
    args.push(source);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM track_events${whereSql}`).get(...args).n;
  const byEvent = rowsToMap(
    db.prepare(`SELECT event AS k, COUNT(*) AS n FROM track_events${whereSql} GROUP BY event ORDER BY n DESC`).all(...args),
  );
  const bySource = rowsToMap(
    db.prepare(`SELECT source AS k, COUNT(*) AS n FROM track_events${whereSql} GROUP BY source ORDER BY n DESC`).all(...args),
  );
  const byProduct = rowsToMap(
    db
      .prepare(
        `SELECT product_id AS k, COUNT(*) AS n FROM track_events${whereSql}
         ${whereSql ? 'AND' : 'WHERE'} product_id IS NOT NULL GROUP BY product_id ORDER BY n DESC LIMIT 20`,
      )
      .all(...args),
  );
  const recent = db
    .prepare(
      `SELECT event, source, product_id AS productId, user_id AS userId, ts
       FROM track_events${whereSql} ORDER BY id DESC LIMIT 50`,
    )
    .all(...args);

  return { total, byEvent, bySource, byProduct, recent };
}
