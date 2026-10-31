// 购物车仓储：服务端持久化（替代纯 localStorage），换设备/清缓存不丢。
// 同一 (user, product, sku) 唯一，重复加购累加数量而非产生多行。
import { getDb } from '../db/connection.js';

const SELECT = `
  SELECT ci.id, ci.user_id, ci.product_id, ci.sku_id, ci.qty, ci.created_at,
         p.name, p.brand, p.price AS base_price, p.cover_color, p.tags, p.highlight,
         s.spec, s.price AS sku_price, s.stock AS sku_stock
  FROM cart_items ci
  JOIN products p ON p.id = ci.product_id
  LEFT JOIN product_skus s ON s.id = ci.sku_id
`;

function mapItem(row) {
  const unitPrice = row.sku_price ?? row.base_price;
  const stock = row.sku_stock ?? 0;
  return {
    id: row.id,
    productId: row.product_id,
    skuId: row.sku_id,
    spec: row.spec || '',
    name: row.name,
    brand: row.brand,
    price: unitPrice,
    qty: row.qty,
    stock,
    coverColor: row.cover_color || '',
    highlight: row.highlight || '',
    // 数量超过可用库存时标记，前端据此提示而非静默下单失败
    insufficient: stock < row.qty,
    subtotal: unitPrice * row.qty,
  };
}

export function listCart(userId) {
  const rows = getDb().prepare(`${SELECT} WHERE ci.user_id = ? ORDER BY ci.id DESC`).all(userId);
  const items = rows.map(mapItem);
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const totalAmount = items.reduce((s, i) => s + i.subtotal, 0);
  return { items, totalQty, totalAmount };
}

/** 加购：已存在则累加，超过库存则截断；无 sku 时取该商品第一个 SKU */
export function addToCart({ userId, productId, skuId = null, qty = 1 }) {
  const db = getDb();
  const product = db.prepare("SELECT id FROM products WHERE id = ? AND review_status = 'approved'").get(productId);
  if (!product) throw Object.assign(new Error('商品不存在'), { status: 404 });

  let sid = skuId;
  if (!sid) {
    const first = db
      .prepare('SELECT id FROM product_skus WHERE product_id = ? ORDER BY id LIMIT 1')
      .get(productId);
    sid = first ? first.id : null;
  }
  const sku = sid
    ? db.prepare('SELECT id, stock FROM product_skus WHERE id = ? AND product_id = ?').get(sid, productId)
    : null;
  if (sid && !sku) throw Object.assign(new Error('规格不存在'), { status: 400 });

  const exist = db
    .prepare('SELECT id, qty FROM cart_items WHERE user_id = ? AND product_id = ? AND IFNULL(sku_id, ?) = ?')
    .get(userId, productId, sid ?? '', sid ?? '');

  let next = Number(qty) || 1;
  if (exist) next += exist.qty;
  if (sku) next = Math.min(next, sku.stock);
  if (next <= 0) throw Object.assign(new Error('该规格暂时无货'), { status: 409 });

  if (exist) {
    db.prepare('UPDATE cart_items SET qty = ?, updated_at = datetime(\'now\') WHERE id = ?').run(next, exist.id);
    return { itemId: exist.id, qty: next };
  }
  const info = db
    .prepare('INSERT INTO cart_items (user_id, product_id, sku_id, qty) VALUES (?, ?, ?, ?)')
    .run(userId, productId, sid, next);
  return { itemId: Number(info.lastInsertRowid), qty: next };
}

/** 改数量：qty <= 0 视为移除 */
export function updateQty(userId, itemId, qty) {
  const db = getDb();
  const row = db.prepare('SELECT id, sku_id FROM cart_items WHERE id = ? AND user_id = ?').get(itemId, userId);
  if (!row) throw Object.assign(new Error('购物车项不存在'), { status: 404 });
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return removeItem(userId, itemId);
  if (row.sku_id) {
    const sku = db.prepare('SELECT stock FROM product_skus WHERE id = ?').get(row.sku_id);
    if (sku) return db.prepare('UPDATE cart_items SET qty = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(Math.min(n, sku.stock), row.id).changes;
  }
  return db.prepare('UPDATE cart_items SET qty = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(n, row.id).changes;
}

export function removeItem(userId, itemId) {
  return getDb().prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(itemId, userId).changes;
}

/** 清空（下单成功后调用；仅清已购项时用 productIds 过滤） */
export function clearCart(userId, productIds = null) {
  const db = getDb();
  if (productIds && productIds.length) {
    const ph = productIds.map(() => '?').join(',');
    return db.prepare(`DELETE FROM cart_items WHERE user_id = ? AND product_id IN (${ph})`)
      .run(userId, ...productIds).changes;
  }
  return db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId).changes;
}
