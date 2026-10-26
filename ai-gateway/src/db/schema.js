// 数据库结构：版本化迁移（PRAGMA user_version 记录版本，逐步叠加）。
// 表覆盖电商主链路：类目 / 商品 / SKU / 用户 / 地址 / 订单 / 订单项 / 评价 / FAQ / 政策 / 会话 / 消息 / 埋点。

const MIGRATIONS = [
  {
    version: 1,
    name: 'init-shopping-schema',
    sql: `
      CREATE TABLE IF NOT EXISTS categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sort        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS products (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        brand          TEXT NOT NULL DEFAULT '',
        category_id    TEXT NOT NULL REFERENCES categories(id),
        price          INTEGER NOT NULL,
        original_price INTEGER,
        description    TEXT NOT NULL DEFAULT '',
        tags           TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
        rating         REAL NOT NULL DEFAULT 4.8,
        reviews_count  INTEGER NOT NULL DEFAULT 0,
        sales          INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'on_sale',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_products_cat   ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
      CREATE INDEX IF NOT EXISTS idx_products_sales ON products(sales DESC);

      CREATE TABLE IF NOT EXISTS product_skus (
        id         TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        spec       TEXT NOT NULL,                    -- 规格描述，如「深空灰 / 12+256G」
        price      INTEGER NOT NULL,
        stock      INTEGER NOT NULL DEFAULT 0,
        status     TEXT NOT NULL DEFAULT 'on_sale'
      );
      CREATE INDEX IF NOT EXISTS idx_skus_product ON product_skus(product_id);

      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        nickname   TEXT NOT NULL DEFAULT '顾客',
        phone      TEXT NOT NULL DEFAULT '',
        level      TEXT NOT NULL DEFAULT 'normal',   -- normal / silver / gold
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS addresses (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver   TEXT NOT NULL,
        phone      TEXT NOT NULL,
        region     TEXT NOT NULL,
        detail     TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_addr_user ON addresses(user_id);

      CREATE TABLE IF NOT EXISTS orders (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id),
        status            TEXT NOT NULL,              -- pending/paid/shipped/completed/refunding/closed
        total_amount      INTEGER NOT NULL,
        address_id        TEXT REFERENCES addresses(id),
        logistics_company TEXT,
        tracking_no       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        paid_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

      CREATE TABLE IF NOT EXISTS order_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id),
        sku_id     TEXT,
        name       TEXT NOT NULL,
        price      INTEGER NOT NULL,
        qty        INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

      CREATE TABLE IF NOT EXISTS reviews (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id    TEXT,
        rating     INTEGER NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);

      CREATE TABLE IF NOT EXISTS faqs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        topic    TEXT NOT NULL,
        question TEXT NOT NULL,
        answer   TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '[]'           -- JSON 数组
      );

      CREATE TABLE IF NOT EXISTS policies (
        id      TEXT PRIMARY KEY,                     -- return / shipping / warranty / invoice / payment
        title   TEXT NOT NULL,
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL DEFAULT 'anonymous',
        mode       TEXT NOT NULL DEFAULT 'chat',       -- chat / product-qa / guide
        title      TEXT NOT NULL DEFAULT '',
        context    TEXT NOT NULL DEFAULT '{}',         -- JSON：预算/类目/上次商品等上下文
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, mode, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,                 -- user / assistant
        content         TEXT NOT NULL,
        meta            TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

      CREATE TABLE IF NOT EXISTS track_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event      TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'unknown',
        product_id TEXT,
        user_id    TEXT NOT NULL DEFAULT 'anonymous',
        meta       TEXT NOT NULL DEFAULT '{}',
        ts         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_track_ts      ON track_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_track_event   ON track_events(event);
      CREATE INDEX IF NOT EXISTS idx_track_product ON track_events(product_id);
    `,
  },
  {
    version: 2,
    name: 'commerce-cart-favorite-coupon',
    sql: `
      -- 商品视觉与卖点补充（v1 起线上已有数据，故用 ADD COLUMN 增量升级）
      ALTER TABLE products ADD COLUMN cover_color TEXT NOT NULL DEFAULT '';
      ALTER TABLE products ADD COLUMN highlight    TEXT NOT NULL DEFAULT '';
      ALTER TABLE products ADD COLUMN highlights   TEXT NOT NULL DEFAULT '[]';  -- JSON 数组：参数亮点

      ALTER TABLE reviews ADD COLUMN author TEXT NOT NULL DEFAULT '';

      -- 购物车：按用户 + SKU 唯一，重复加购累加数量
      CREATE TABLE IF NOT EXISTS cart_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku_id     TEXT,
        qty        INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_user_sku
        ON cart_items(user_id, product_id, IFNULL(sku_id, ''));
      CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);

      -- 收藏夹
      CREATE TABLE IF NOT EXISTS favorites (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_user_product ON favorites(user_id, product_id);
      CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);

      -- 优惠券模板
      CREATE TABLE IF NOT EXISTS coupons (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'amount',   -- amount（满减）/ discount（折扣）
        threshold   INTEGER NOT NULL DEFAULT 0,       -- 使用门槛（分？此处统一为元）
        amount      INTEGER NOT NULL DEFAULT 0,       -- 减免金额（元）或折扣百分数
        expire_days INTEGER NOT NULL DEFAULT 30,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 用户领取的券
      CREATE TABLE IF NOT EXISTS user_coupons (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        coupon_id  TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
        status     TEXT NOT NULL DEFAULT 'unused',     -- unused / used / expired
        order_id   TEXT,
        claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_uc_user ON user_coupons(user_id, status);
    `,
  },
  {
    version: 3,
    name: 'order-amount-breakdown',
    sql: `
      -- 订单金额明细：商品小计 / 运费 / 优惠，便于对账与售后退款计算
      ALTER TABLE orders ADD COLUMN product_amount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN shipping_fee   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN coupon_id      TEXT;
      ALTER TABLE orders ADD COLUMN remark         TEXT NOT NULL DEFAULT '';
    `,
  },
];

/** 执行未应用的迁移，返回当前版本 */
export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${e.message}`);
    }
  }
  return db.prepare('PRAGMA user_version').get().user_version;
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
