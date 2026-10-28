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
  {
    version: 4,
    name: 'two-level-category-and-brands',
    sql: `
      -- 两级分类：categories 支持 parent_id 自引用，一级类目 parent_id 为 NULL
      ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE;
      ALTER TABLE categories ADD COLUMN icon      TEXT NOT NULL DEFAULT '';
      ALTER TABLE categories ADD COLUMN desc      TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);

      -- 商品归属到二级类目（冗余 parent category_id，便于「按一级类目聚合」与「按二级筛选」都快）
      ALTER TABLE products ADD COLUMN sub_category_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_products_subcat ON products(sub_category_id);

      -- 品牌维度（从一个个商品里派生出来，支撑品牌筛选与「按品牌逛」）
      CREATE TABLE IF NOT EXISTS brands (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        category_id TEXT NOT NULL DEFAULT '',   -- 主营类目
        logo_color  TEXT NOT NULL DEFAULT '',   -- 程序化 logo 底色
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_brands_cat ON brands(category_id);
    `,
  },
  {
    version: 5,
    name: 'product-image-url',
    sql: `
      -- 真实商品图 URL（来自合规开放数据源：Open Food Facts / 开源商品 API 等）。
      -- 为空时前端回退到程序化 SVG 封面，保证离线或图床不可达时仍有图可显示。
      ALTER TABLE products ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 6,
    name: 'review-image-followup-vote',
    sql: `
      -- 追评：parent_id 指向被追评的主评价（NULL 表示主评价本身），级联删除避免孤儿追评
      ALTER TABLE reviews ADD COLUMN parent_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE;
      -- 买家秀：JSON 数组，元素为网关可访问的图片 URL（如 /api/uploads/xxx.webp）
      ALTER TABLE reviews ADD COLUMN images    TEXT NOT NULL DEFAULT '[]';
      -- 购买规格快照：写评价时选定的 SKU 文案，避免后续 SKU 改名失真
      ALTER TABLE reviews ADD COLUMN sku_spec  TEXT NOT NULL DEFAULT '';
      -- 来源：seed（导入数据）/ user（用户真实发布）
      ALTER TABLE reviews ADD COLUMN source    TEXT NOT NULL DEFAULT 'seed';
      CREATE INDEX IF NOT EXISTS idx_reviews_parent ON reviews(parent_id);

      -- 有用投票：主键为 (评价, 用户)，天然幂等——重复点击由「插入/删除」表达，无需额外计数纠偏
      CREATE TABLE IF NOT EXISTS review_votes (
        review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (review_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rv_review ON review_votes(review_id);
    `,
  },
  {
    version: 7,
    name: 'auth-refresh-tokens',
    sql: `
      -- 刷新令牌服务端存储：库里只存 token 的 sha256 哈希，明文只在签发时返回给客户端一次。
      -- 轮换：每次刷新都作废旧记录并签发新记录（family 相同）；检测到已作废令牌被重放时整族撤销。
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,                 -- 令牌记录 ID（UUID）
        user_id     TEXT NOT NULL,
        token_hash  TEXT NOT NULL,                    -- sha256(明文令牌) 的十六进制
        family_id   TEXT NOT NULL,                    -- 轮换家族，重放时整族撤销
        issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,                    -- UTC 'YYYY-MM-DD HH:MM:SS'
        revoked_at  TEXT,                             -- 非空表示已作废（轮换/登出/重放）
        replaced_by TEXT,                             -- 轮换后的新记录 ID，便于审计链路
        user_agent  TEXT NOT NULL DEFAULT '',
        ip          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family_id);
      CREATE INDEX IF NOT EXISTS idx_rt_exp ON refresh_tokens(expires_at);
    `,
  },
  {
    version: 8,
    name: 'addresses-cross-device',
    sql: `
      -- 地址跨设备：补齐前端地址簿的完整字段，避免「存服务端再拉回来」丢 province/city/postal。
      -- 老数据只有 region（"省 市"拼串），下面按空格回填 province/city，postal 留空。
      ALTER TABLE addresses ADD COLUMN province TEXT NOT NULL DEFAULT '';
      ALTER TABLE addresses ADD COLUMN city     TEXT NOT NULL DEFAULT '';
      ALTER TABLE addresses ADD COLUMN postal   TEXT NOT NULL DEFAULT '';
      ALTER TABLE addresses ADD COLUMN updated_at TEXT;

      UPDATE addresses
         SET province = CASE WHEN instr(region, ' ') > 0
                             THEN substr(region, 1, instr(region, ' ') - 1)
                             ELSE region END,
             city     = CASE WHEN instr(region, ' ') > 0
                             THEN substr(region, instr(region, ' ') + 1)
                             ELSE '' END
       WHERE province = '';

      UPDATE addresses SET updated_at = datetime('now') WHERE updated_at IS NULL;

      -- 一个用户至多一条默认地址：先归零多余默认，再由应用层保证始终有且仅有一条
      UPDATE addresses
         SET is_default = 0
       WHERE is_default = 1
         AND rowid NOT IN (
           SELECT MIN(rowid) FROM addresses WHERE is_default = 1 GROUP BY user_id
         );

      CREATE INDEX IF NOT EXISTS idx_addr_default ON addresses(user_id, is_default);
    `,
  },
  {
    version: 9,
    name: 'addresses-soft-delete',
    sql: `
      -- 地址改软删除：订单的 address_id 外键指向 addresses，
      -- 硬删会被外键挡下（删过一次地址的用户永远删不掉），而历史订单又需要这条记录做追溯。
      -- 于是删除只打时间戳，列表查询过滤掉即可。
      ALTER TABLE addresses ADD COLUMN deleted_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_addr_alive ON addresses(user_id, deleted_at);
    `,
  },
  {
    version: 10,
    name: 'coupon-wallet-sync',
    sql: `
      -- 券目录补「适用范围」：券中心卡片要展示，跨设备同步时一处定义处处一致
      ALTER TABLE coupons ADD COLUMN scope_text TEXT NOT NULL DEFAULT '全场通用';

      -- 券实例补到期时间与顺延次数。
      -- expires_at 落库而不是各端用 claimed_at + expire_days 各算一遍：
      -- 取消订单返还时要顺延有效期，只有落库才有唯一真源可改，
      -- 否则「网页按顺延算、App 按原到期算」，同一张券两副面孔。
      ALTER TABLE user_coupons ADD COLUMN expires_at TEXT;
      ALTER TABLE user_coupons ADD COLUMN extension_count INTEGER NOT NULL DEFAULT 0;
      UPDATE user_coupons SET expires_at = (
        SELECT datetime(user_coupons.claimed_at, '+' || coupons.expire_days || ' days')
        FROM coupons WHERE coupons.id = user_coupons.coupon_id
      ) WHERE expires_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_uc_coupon ON user_coupons(user_id, coupon_id);

      -- 券模板 id 与前端券目录对齐：两端用不同 id 的话，
      -- 同一张券在「券中心」和「网关卡包」里是两只券，同步必然重复。
      -- 旧的演示券（cp_new / cp_100 / cp_500 / cp_1000 / cp_vip / cp_2000）作废，
      -- 外键级联会带走它们的卡包实例，下面统一按新目录补发体验券。
      DELETE FROM coupons WHERE id IN ('cp_new', 'cp_100', 'cp_500', 'cp_1000', 'cp_vip', 'cp_2000');
      INSERT OR REPLACE INTO coupons (id, title, kind, threshold, amount, expire_days, scope_text) VALUES
        ('demo-c30',   '新人礼 · 满 99 减 30',      'cash',     99,   30,  30, '全场通用'),
        ('demo-c80',   '会员日 · 满 599 减 80',     'cash',    599,   80,  15, '全场通用'),
        ('demo-c90',   '尊享 9 折 · 满 199 可用',   'discount', 199,  10,  30, '全场通用'),
        ('cp-home50',  '家居专场 · 满 399 减 50',   'cash',    399,   50,  20, '家居生活类商品'),
        ('cp-bag20',   '箱包配饰 · 满 259 减 20',   'cash',    259,   20,  45, '箱包配饰类商品'),
        ('cp-big150',  '尊享大额 · 满 1299 减 150', 'cash',   1299,  150,   7, '全场通用');

      -- 存量用户补发三张体验券：旧券被级联删掉后卡包会空，
      -- 而 ensureUser 只在「首次建档」时发券，老账号永远等不到补发。
      INSERT INTO user_coupons (user_id, coupon_id, status, claimed_at, expires_at)
      SELECT u.id, c.id, 'unused', datetime('now'), datetime('now', '+' || c.expire_days || ' days')
      FROM users u
      JOIN coupons c ON c.id IN ('demo-c30', 'demo-c80', 'demo-c90')
      WHERE NOT EXISTS (
        SELECT 1 FROM user_coupons uc
        WHERE uc.user_id = u.id AND uc.coupon_id = c.id AND uc.status = 'unused'
      );
    `,
  },
  {
    version: 11,
    name: 'runtime-settings-and-order-shipping',
    sql: `
      -- 运营可配参数：运费/配送方式、券返还顺延规则等以前写死在前后端两处常量里，
      -- 改一个数字要发一次版，还容易两边改漏。改存一张键值表，接口读写、进程内缓存。
      -- 表空时用代码里的 DEFAULT_SETTINGS 兜底，不在迁移里插数据——
      -- 默认值只有一份来源，避免「迁移插的旧默认值」与「代码新默认值」打架。
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,              -- JSON 文本
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by TEXT
      );

      -- 订单补配送/支付方式：原来只在库里存金额，前端订单详情全靠本地快照，
      -- 换台设备就看不出这单是「加急」还是「货到付款」。
      -- 运费也不再由服务端按「满 99 包邮」硬算，而是按 settings 里的配送方式定价，
      -- 于是服务端与结算页展示的运费必然同源。
      ALTER TABLE orders ADD COLUMN shipping_method_id TEXT;
      ALTER TABLE orders ADD COLUMN payment_method_id TEXT;
      ALTER TABLE orders ADD COLUMN shipping_eta TEXT;
    `,
  },
  {
    version: 12,
    name: 'order-items-spec',
    sql: `
      -- 订单明细单独存规格：原来只把规格拼进 name（「商品名（0.5mm / 灰）」），
      -- 前端拿不到结构化字段，换设备看订单就只剩「SKU：默认规格」这种废话。
      -- 已有行留空即可，前端 spec 为空时按「见商品名」处理，不做数据回填猜测。
      ALTER TABLE order_items ADD COLUMN spec TEXT;
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
