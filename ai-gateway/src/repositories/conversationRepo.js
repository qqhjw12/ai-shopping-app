// 会话仓储：多轮对话上下文与消息历史持久化（重启不丢，可回放）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 取已有会话或新建一个，返回 { id, userId, mode, title, context } */
export function ensureConversation({ id, userId = 'anonymous', mode = 'chat', title = '' } = {}) {
  const db = getDb();
  if (id) {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (row) {
      return {
        id: row.id,
        userId: row.user_id,
        mode: row.mode,
        title: row.title,
        context: safeJson(row.context, {}),
      };
    }
  }
  const newId = id || randomUUID();
  db.prepare(
    'INSERT INTO conversations (id, user_id, mode, title, context) VALUES (?, ?, ?, ?, ?)',
  ).run(newId, String(userId), String(mode), String(title).slice(0, 80), '{}');
  return { id: newId, userId: String(userId), mode, title, context: {} };
}

export function appendMessage(conversationId, role, content, meta = {}) {
  const db = getDb();
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, meta) VALUES (?, ?, ?, ?)',
  ).run(conversationId, role, String(content), JSON.stringify(meta || {}));
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
}

/** 最近 N 轮消息（时间正序返回，便于直接拼 prompt） */
export function history(conversationId, limit = 10) {
  const db = getDb();
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit);
  return rows.reverse();
}

export function getContext(conversationId) {
  const db = getDb();
  const row = db.prepare('SELECT context FROM conversations WHERE id = ?').get(conversationId);
  return row ? safeJson(row.context, {}) : {};
}

/** 合并写入上下文（预算 / 类目 / 上次商品等），用于多轮指代 */
export function patchContext(conversationId, patch) {
  const db = getDb();
  const cur = getContext(conversationId);
  const next = { ...cur, ...(patch || {}) };
  db.prepare("UPDATE conversations SET context = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(next),
    conversationId,
  );
  return next;
}

export function countMessages(conversationId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
    .get(conversationId).n;
}
