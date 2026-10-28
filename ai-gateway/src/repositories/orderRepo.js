// 订单仓储：售后 / 物流问答的数据来源（SQLite）。
import { getDb } from '../db/connection.js';

// 状态文案与前端 orderStore.ORDER_STATUS_TEXT 保持一致：
// 同一笔订单在「AI 客服说」和「订单详情页显示」里必须是同一个词，
// 否则用户会以为客服说的是另一笔单。
export const STATUS_LABEL = {
  pending: '待付款',
  paid: '待发货',
  shipped: '已发货',
  completed: '已完成',
  refunding: '售后中',
  closed: '已取消',
};

function mapOrder(row, items) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    totalAmount: row.total_amount,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    logisticsCompany: row.logistics_company || '',
    trackingNo: row.tracking_no || '',
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.name,
      price: i.price,
      qty: i.qty,
    })),
    // 兼容旧字段（aftersale 文案直接用到）
    productName: items.map((i) => i.name).join('、'),
    qty: items.reduce((s, i) => s + i.qty, 0),
    price: row.total_amount,
    logistics: row.logistics_company
      ? `${row.logistics_company} ${row.tracking_no}`
      : '暂无物流信息（尚未发货）',
  };
}

export function listOrdersByUser(userId, limit = 10) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(userId || ''), limit);
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  return rows.map((r) => mapOrder(r, itemStmt.all(r.id)));
}

/** 没有历史订单的访客（前端 userId 是随机生成的）→ 返回演示订单，保证售后可体验 */
export function listOrdersForDemo(userId, limit = 10) {
  const own = listOrdersByUser(userId, limit);
  if (own.length) return own;
  const demo = listOrdersByUser('u_demo', limit);
  return demo.map((o) => ({ ...o, isSample: true }));
}

export function getOrderById(orderId) {
  if (!orderId) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId).trim());
  if (!row) return null;
  return mapOrder(row, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id));
}

/** 最近一笔订单（用户说「我买的什么时候到」时用） */
export function latestOrder(userId) {
  return listOrdersForDemo(userId, 1)[0] || null;
}

export function countOrders() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM orders').get().n;
}
