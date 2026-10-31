// 通知模板仓储：只存**覆盖项**（运营改过的那些），默认模板在服务层。
//
// 这个「只存差异」的设计决定了三件事，都写在这里免得后人改错：
//   1) 表里没有某个 id 就不是错误，而是「用默认值」——读的时候永远不抛错；
//   2) 「恢复默认」= 删行，而不是把默认值抄回表里。抄回去的话，今后默认文案升级，
//      那些恢复过默认的行会默默停在旧版本上，看起来像是「改了但没生效」；
//   3) 新增结果类型（比如 withdrawn）不需要迁移：默认模板一加，行就自然出现。
import { getDb } from '../db/connection.js';

function toTemplate(row) {
  return {
    id: row.id,
    status: row.status,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    enabled: Boolean(row.enabled),
    updatedBy: row.updated_by || '',
    updatedAt: row.updated_at || null,
  };
}

export function listTemplates() {
  return getDb()
    .prepare('SELECT * FROM merchant_notice_templates ORDER BY status ASC, channel ASC')
    .all()
    .map(toTemplate);
}

export function findTemplate(id) {
  const row = getDb()
    .prepare('SELECT * FROM merchant_notice_templates WHERE id = ?')
    .get(String(id || ''));
  return row ? toTemplate(row) : null;
}

/** 写入覆盖项（存在则更新）。幂等：同一个 id 反复保存不会长出多行。 */
export function saveTemplate({ id, status, channel, subject, body, enabled, by = '' }) {
  getDb()
    .prepare(`
      INSERT INTO merchant_notice_templates
        (id, status, channel, subject, body, enabled, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        subject = excluded.subject,
        body = excluded.body,
        enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `)
    .run(id, status, channel, subject || '', body, enabled ? 1 : 0, String(by || '').slice(0, 40));
  return findTemplate(id);
}

/** 恢复默认 = 删掉覆盖行；返回删了几行（0 表示本来就是默认） */
export function deleteTemplate(id) {
  return getDb().prepare('DELETE FROM merchant_notice_templates WHERE id = ?').run(String(id || '')).changes;
}
