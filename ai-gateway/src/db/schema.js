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
  {
    version: 13,
    name: 'order-idempotency',
    sql: `
      -- 下单幂等键：客户端一次结算会话生成一个 key，重试带同一个 key。
      -- 之前没有它，网络在「服务端已建单、响应没回来」的瞬间断掉时，用户重试就会
      -- 变成两张真实订单（前端当时还会降级再落一张本地单，最坏三张）。
      -- 唯一索引落在 (user_id, idempotency_key) 上而不是全局 key 上：
      -- 不同用户偶然生成同一个 key 不该互相顶掉（虽然 uuid 概率极低，约束也要写对）。
      -- 用部分索引，历史订单 key 为 NULL，不参与唯一性约束。
      ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem
        ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 14,
    name: 'order-logistics-and-aftersale',
    sql: `
      -- 发货/完成时间：订单详情要画「待付款 → 待发货 → 已发货 → 已完成」的流转条，
      -- 只靠 status 一个字段画不出来——退款中（refunding）的订单仍然要显示它走到了哪一步。
      -- 阶段一律由时间戳推导，status 只负责顶部那个胶囊标签，两者不互相冒充。
      ALTER TABLE orders ADD COLUMN shipped_at   TEXT;
      ALTER TABLE orders ADD COLUMN completed_at TEXT;

      -- 物流事件：原来是 orders.logistics_company / tracking_no 两个字段 + 一句描述，
      -- 前端只能显示一行字。改成事件流水（一次揽收、一次中转、一次派送、一次签收各一行），
      -- 时间线才有东西可画。seq 单独存而不是靠 happened_at 排序：
      -- mock 时同一分钟可能发生两件事，只按时间排会颠倒。
      CREATE TABLE IF NOT EXISTS order_logistics_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        code        TEXT NOT NULL,               -- picked_up / in_transit / out_for_delivery / signed
        title       TEXT NOT NULL,
        detail      TEXT NOT NULL DEFAULT '',
        happened_at TEXT NOT NULL,
        seq         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_logi_order ON order_logistics_events(order_id, seq);

      -- 售后单：一个订单在同一时刻只允许有一条「待处理」的申请（下面的部分唯一索引保证），
      -- 否则用户连点几次提交就能堆出好几条，客服看到的是一堆重复工单。
      CREATE TABLE IF NOT EXISTS aftersales (
        id          TEXT PRIMARY KEY,            -- AS + 日期 + 序列
        order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id),
        type        TEXT NOT NULL,               -- refund / return
        reason      TEXT NOT NULL,               -- quality / wrong / damaged / not_fit / other
        note        TEXT NOT NULL DEFAULT '',
        evidence    TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：{name,size}，本轮只存凭证文件名
        status      TEXT NOT NULL DEFAULT 'reviewing',  -- reviewing / approved / rejected
        handle_note TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_as_order  ON aftersales(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_as_user   ON aftersales(user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_as_open
        ON aftersales(order_id) WHERE status = 'reviewing';
    `,
  },
  {
    version: 15,
    name: 'aftersale-review',
    sql: `
      -- 售后审核：让 approved / rejected 从词表变成真的会动订单的流程。
      --
      -- origin_status 存提交申请那一刻的订单状态（shipped / completed）。
      -- 驳回要把它退回去，而此时订单已经是 refunding，原状态在库里查不到了——
      -- 不单独存一列就只能靠「猜它之前大概到哪了」，猜错就是把已签收的订单退回在途。

      -- refund_amount 允许 NULL：换货不产生退款，没有就是没有，
      -- 写 0 会和「退款 0 元（全额用券抵扣的订单）」混淆。
      ALTER TABLE aftersales ADD COLUMN origin_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE aftersales ADD COLUMN refund_amount REAL;
      ALTER TABLE aftersales ADD COLUMN review_note  TEXT NOT NULL DEFAULT '';
      ALTER TABLE aftersales ADD COLUMN reviewer     TEXT NOT NULL DEFAULT '';
      ALTER TABLE aftersales ADD COLUMN reviewed_at  TEXT;

      -- 存量工单补 origin_status：订单此刻已经是 refunding，只能从时间戳反推申请前走到哪一步。
      -- 有 completed_at 说明申请前已签收（退到 completed），否则还在途（退到 shipped）。
      UPDATE aftersales SET origin_status = (
        SELECT CASE WHEN o.completed_at IS NOT NULL THEN 'completed' ELSE 'shipped' END
        FROM orders o WHERE o.id = aftersales.order_id
      ) WHERE origin_status = '';

      CREATE INDEX IF NOT EXISTS idx_as_status ON aftersales(status, created_at DESC);
    `,
  },
  {
    version: 16,
    name: 'ledger-evidence-webhook',
    sql: `
      -- 资金流水账本：订单维度的收款 / 退款记录。
      --
      -- 之前退款只是 aftersales 上的一个数字，账算不出来：一笔订单到底收了多少、
      -- 退了多少、还剩多少能退，要翻工单自己加。金额一律存正数，方向由 kind 决定
      -- （payment 入账 / refund 出账），不存负数——负数求和时符号写反就是两倍的账。
      CREATE TABLE IF NOT EXISTS order_ledger (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL,
        kind         TEXT NOT NULL,            -- payment / refund
        amount       REAL NOT NULL,            -- 正数，方向看 kind
        channel      TEXT NOT NULL DEFAULT 'manual',  -- online / cod / manual
        status       TEXT NOT NULL DEFAULT 'settled', -- settled / pending（退款待打款）
        aftersale_id TEXT,                     -- 退款来源工单，收款为 NULL
        note         TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        settled_at   TEXT,
        settled_by   TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_order ON order_ledger(order_id, created_at);
      -- 待打款的退款是运营每天要看的清单，单独建部分索引；全表按状态扫描没必要
      CREATE INDEX IF NOT EXISTS idx_ledger_pending
        ON order_ledger(created_at) WHERE status = 'pending';

      -- 存量补收款流水：迁移前支付的订单在账本上没有入账记录，
      -- 会导致「已退款但从未收款」的对账黑洞（余额算出来是负的）。
      -- 只补有 paid_at 的（真的付过钱），渠道按订单原支付方式，认不出的记 manual。
      INSERT OR IGNORE INTO order_ledger
        (id, order_id, kind, amount, channel, status, note, created_at, settled_at)
      SELECT
        'LG' || lower(hex(randomblob(8))), o.id, 'payment', o.total_amount,
        COALESCE(NULLIF(o.payment_method_id, ''), 'manual'), 'settled',
        '迁移补记', o.paid_at, o.paid_at
      FROM orders o
      WHERE o.paid_at IS NOT NULL AND o.total_amount > 0;

      -- 物流事件去重：webhook 会重推，网络抖动时同一条能到三次。
      -- (order_id, code, happened_at) 三元组唯一 → 重复推送直接 INSERT OR IGNORE，
      -- 不靠「先查一遍再插」（那两步之间有窗口，并发下照样插重）。
      DELETE FROM order_logistics_events WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM order_logistics_events
        GROUP BY order_id, code, happened_at
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evt_dedup
        ON order_logistics_events(order_id, code, happened_at);
    `,
  },
  {
    version: 17,
    name: 'merchant-applications',
    sql: `
      -- 商家入驻申请：商家在 /#/merchant/apply 分四步填完，落到这张表。
      --
      -- 有意的取舍（三条，都是「少存一点反而更对」）：
      --
      -- 1) 银行账号只存打码串（前 4 + 后 4），不存完整账号。
      --    收款账号是强 PII，存明文等于给自己造一个泄露面：表被导出、备份被拷走、
      --    日志里随手 SELECT 一次都会流出。真要做打款，应该由持牌支付通道做代付、
      --    账号托管在对方，或者单独一张加密表 + 独立密钥 + 审计访问。
      --    审核阶段看「开户名 + 后四位」足以判断申请是不是同一家，完整账号等签约时再收。
      --
      -- 2) 草稿不入库。表单草稿存在浏览器 localStorage，服务端只接收「已提交」的申请。
      --    否则运营列表里会漂着一堆填了一半的废单，还得额外区分「真申请」和「手滑点开」。
      --
      -- 3) submit_key 幂等：提交按钮连点、网络在「服务端已写入、响应没回来」时断掉后重试，
      --    都不该变成两条申请（否则同一家会被审核两遍，商家也收到两个编号）。
      --    唯一索引落在 (user_id, submit_key) 上——不同人偶然撞 key 不该互相顶掉，
      --    和 orders 的幂等键是同一套规则。
      CREATE TABLE IF NOT EXISTS merchant_applications (
        id                  TEXT PRIMARY KEY,               -- MA + YYYYMMDD + 4 位当日序号
        user_id             TEXT NOT NULL DEFAULT 'anonymous',

        -- 第一步：主体资质
        entity_kind         TEXT NOT NULL,                  -- brand / factory / studio / food / other
        company             TEXT NOT NULL,
        credit_code         TEXT NOT NULL,                  -- 统一社会信用代码（18 位）
        contact             TEXT NOT NULL,                  -- 联系人
        phone               TEXT NOT NULL,
        email               TEXT NOT NULL DEFAULT '',

        -- 第二步：品牌与商品
        brand               TEXT NOT NULL,
        brand_source        TEXT NOT NULL,                  -- owned / exclusive / authorized
        categories          TEXT NOT NULL DEFAULT '[]',     -- JSON 数组：一级类目 id
        sku_range           TEXT NOT NULL DEFAULT '',       -- lt50 / 50-200 / 200-1000 / gt1000
        price_range         TEXT NOT NULL DEFAULT '',       -- lt100 / 100-500 / 500-2000 / gt2000
        dropship            INTEGER NOT NULL DEFAULT 0,     -- 是否支持一件代发

        -- 第三步：结算与售后
        bank_account        TEXT NOT NULL,                  -- 开户名（不是账号）
        bank_branch         TEXT NOT NULL DEFAULT '',       -- 开户行
        bank_no_masked      TEXT NOT NULL DEFAULT '',       -- 仅前 4 + 后 4，见上方取舍 1
        return_policy       TEXT NOT NULL DEFAULT '7days',  -- 7days / 15days
        ship_within         TEXT NOT NULL DEFAULT '48h',    -- 24h / 48h / 72h
        note                TEXT NOT NULL DEFAULT '',

        -- 流程与凭证
        status              TEXT NOT NULL DEFAULT 'reviewing',  -- reviewing / approved / rejected
        submit_key          TEXT NOT NULL,
        query_key_hash      TEXT NOT NULL,                  -- 查询凭证只存 sha256，明文只在提交响应里出现一次
        review_note         TEXT NOT NULL DEFAULT '',
        reviewed_at         TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_submit
        ON merchant_applications(user_id, submit_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_query
        ON merchant_applications(query_key_hash);
      CREATE INDEX IF NOT EXISTS idx_ma_status
        ON merchant_applications(status, created_at DESC);
    `,
  },
  {
    version: 18,
    name: 'merchant-review',
    sql: `
      -- 入驻审核闭环：谁审的、什么时候审的、审完通知了没有。
      --
      -- 三条取舍：
      --
      -- 1) 审核轨迹单独一张表，而不是只在申请行上留 reviewed_at。
      --    申请行只有一个终态，可「谁在什么时候把它从什么改成什么」是一串事实。
      --    以后要支持「驳回后补充材料重提」「平台主动撤回通过」，只留在行上的
      --    reviewed_at 会被下一次覆盖，历史就没了。轨迹表只追加，不改写。
      --
      -- 2) reviewed_by 是操作人自报的（X-Admin-Actor），review_key_fp 是管理密钥的
      --    指纹。名字方便人读，指纹才是真能追责的那个——自报字段谁都能写成别人的名字。
      --
      -- 3) 通知走「出站队列」（merchant_notices），不在审核请求里同步发。
      --    审核是运营的一次点击，不该被短信服务商的 3 秒超时拖住；服务商挂了也不该
      --    让审核失败（审核已经成立，通知是可重试的副作用）。发送失败进死信，
      --    运营台能看见「这条没发出去」，而不是以为发了。
      ALTER TABLE merchant_applications ADD COLUMN reviewed_by   TEXT NOT NULL DEFAULT '';
      ALTER TABLE merchant_applications ADD COLUMN review_key_fp TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS merchant_application_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id TEXT NOT NULL,
        action         TEXT NOT NULL,                -- submitted / approved / rejected
        from_status    TEXT NOT NULL DEFAULT '',
        to_status      TEXT NOT NULL,
        note           TEXT NOT NULL DEFAULT '',
        actor          TEXT NOT NULL DEFAULT '',     -- 自报操作人；提交事件是 merchant
        key_fp         TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mae_app
        ON merchant_application_events(application_id, id);

      -- 迁移前的申请补一条「提交」事件：否则老单的轨迹从审核那一步才开始，
      -- 看起来像凭空出现的申请。
      INSERT INTO merchant_application_events
        (application_id, action, from_status, to_status, note, actor, created_at)
      SELECT id, 'submitted', '', 'reviewing', '', 'merchant', created_at
      FROM merchant_applications;

      CREATE TABLE IF NOT EXISTS merchant_notices (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id TEXT NOT NULL,
        channel        TEXT NOT NULL,                -- sms / email
        target_masked  TEXT NOT NULL DEFAULT '',     -- 收件人打码（库里不留完整手机号/邮箱）
        subject        TEXT NOT NULL DEFAULT '',
        body           TEXT NOT NULL,
        -- queued 待发 / sent 已发送 / skipped 未配置通道（不是失败）/ failed 重试耗尽（死信）
        status         TEXT NOT NULL DEFAULT 'queued',
        attempts       INTEGER NOT NULL DEFAULT 0,
        last_error     TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mn_app ON merchant_notices(application_id, id);
      CREATE INDEX IF NOT EXISTS idx_mn_status ON merchant_notices(status, id);
    `,
  },
  {
    version: 19,
    name: 'merchant-selfservice',
    sql: `
      -- 商家侧自助：审核前改资料（revise）、不想来了就撤回（withdraw）。
      --
      -- 三条取舍：
      --
      -- 1) 新增 withdrawn 状态，而不是直接物理删除。
      --    撤回是商家的一个动作，运营需要看见「这家自己退了」——列表里少一条
      --    和「这家撤回了」是两件事，后者能解释为什么某个品牌一直没上线。
      --    状态列是 TEXT，没有 CHECK 约束，所以加状态不需要重建表。
      --
      -- 2) revision_count / last_revised_at 冗余在申请行上，而不是每次去 events 表数。
      --    运营列表要显示「商家在提交后改过 2 次」，一页 20 条就是 20 次聚合查询。
      --    轨迹表仍然是权威事实来源，这两个字段只是列表用的缓存，事务里一起写。
      --    改过 2 次以上是个强信号：审核前值得重新看一眼，别拿着旧数据下结论。
      --
      -- 3) 银行账号依旧不可回读：库里只有前 4 后 4。所以「改结算账号」必须重新输完整卡号，
      --    不能把打码串提交回来再当新账号存——那样只会把一份没变的资料伪装成变更。
      ALTER TABLE merchant_applications ADD COLUMN revision_count    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE merchant_applications ADD COLUMN last_revised_at  TEXT;
      ALTER TABLE merchant_applications ADD COLUMN withdrawn_at     TEXT;
      CREATE INDEX IF NOT EXISTS idx_ma_revised
        ON merchant_applications(status, last_revised_at);
    `,
  },
  {
    version: 20,
    name: 'merchant-notice-templates',
    sql: `
      -- 通知模板：审核结果发出去的那段话，运营应该能自己改。
      --
      -- 为什么不在代码里写死文案、也不塞进环境变量：
      --   - 写死在代码里，改一句话要发版、要走评审，法务想加一句免责声明得排期；
      --   - 塞进环境变量，改完全体重启，而且 .env 里塞多行长文本是个灾难。
      -- 落一张表，运营在后台改完立即生效（模板在「排通知」那一刻渲染，不是发送时）。
      --
      -- 表里**只存覆盖项**：默认模板在 services/noticeTemplateService.js 里。
      -- 这样新增一个结果类型（比如 withdrawn）不需要迁移数据；「恢复默认」也
      -- 只是删行，而不是把默认值再抄一遍——抄一遍就意味着今后默认值升级时，
      -- 那些「恢复过默认」的行会停在旧文案上。
      --
      -- 变量白名单在服务层校验：模板是运营写的，但它是拼进外发文案的，
      -- 拼错一个变量名等于给所有商家发一条 {{company}} 字样的短信。
      CREATE TABLE IF NOT EXISTS merchant_notice_templates (
        id          TEXT PRIMARY KEY,              -- <status>:<channel>，如 approved:sms
        status      TEXT NOT NULL,                 -- approved / rejected / withdrawn
        channel     TEXT NOT NULL,                 -- sms / email
        subject     TEXT NOT NULL DEFAULT '',      -- 邮件主题（短信为空）
        body        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,    -- 关掉 = 这个结果不再走这个通道
        updated_by  TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mnt_status
        ON merchant_notice_templates(status, channel);
    `,
  },
  {
    version: 21,
    name: 'merchant-materials',
    sql: `
      -- 资质材料清单：营业执照 / 品牌授权 / 质检报告 / 其他。
      --
      -- 存在这里的是**清单**，不是文件本体：文件名、大小、类型、登记时间。
      -- 为什么不存文件：入驻阶段做文件存储等于开一条无鉴权的公网上传通道，
      -- 而资质证件（营业执照上有完整统一社会信用代码）一旦能被猜 URL 下载，
      -- 泄露的是商家的经营主体信息。线上只收清单，原件在签约环节由运营向商家索取，
      -- 这条口径写进表单提示里，商家才不会以为「上传完就完事」。
      --
      -- 存 JSON 数组而不是开一张 merchant_materials 子表：
      --   1) 材料只在「随申请一起提交」这一个时刻写入，没有单独查询/更新/统计的需求；
      --   2) 子表会引入「几行算完整」的一致性负担，而这里语义就是一份快照；
      --   3) 审核时要看的是「当时提交了什么」，改材料本身是一次修订（revision），
      --      不是逐条增删——用快照反而对得上审计口径。
      -- 代价是不能按材料类型做 SQL 聚合，需要时用 json_each() 即可，不构成阻碍。
      ALTER TABLE merchant_applications ADD COLUMN materials TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 22,
    name: 'merchant-products-and-shop',
    sql: `
      -- 商家商品正式并入平台商品池。
      --
      -- 为什么不另开 merchant_products 表：商品一旦能被下单，它就必须和平台自营商品
      -- 一起被人搜、被人加购、被下单扣库存、被评价。开两张表等于把「售卖」这条链路上
      -- 每一个 JOIN 都写成 UNION，检索、购物车校验、订单明细全部要分叉，
      -- 而这种分叉在半年内一定会漏掉一处（典型症状：商家商品能加购但下单报「商品不存在」）。
      --
      -- 所以归属打在 products 上，审核状态也打在 products 上：
      --   merchant_id 为空 = 平台自营（历史数据与种子数据全部落到这个分支）
      --   review_status 默认 approved，只有商家新增的商品是 pending
      -- 商城侧一律只认 approved（见 productRepo / orderService），未过审商品物理上不可售。
      ALTER TABLE products ADD COLUMN merchant_id   TEXT NOT NULL DEFAULT '';
      ALTER TABLE products ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
      ALTER TABLE products ADD COLUMN review_note   TEXT NOT NULL DEFAULT '';
      ALTER TABLE products ADD COLUMN reviewed_at   TEXT;
      ALTER TABLE products ADD COLUMN reviewed_by   TEXT NOT NULL DEFAULT '';
      -- 库存预警线（商家自己设的）：工作台据此标「库存预警」，平台商品不参与该口径
      ALTER TABLE products ADD COLUMN warn_at       INTEGER NOT NULL DEFAULT 10;
      CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id);
      CREATE INDEX IF NOT EXISTS idx_products_review   ON products(review_status);

      -- 商家商品的状态变更轨迹：谁在什么时候把它审过了、商家什么时候下的架。
      -- 与 merchant_application_events 同一套思路——审核结论必须可追溯，
      -- 否则商家来问「我这件怎么被下架了」，运营只能回一句「系统里没有记录」。
      CREATE TABLE IF NOT EXISTS merchant_product_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id     TEXT NOT NULL,
        application_id TEXT NOT NULL DEFAULT '',
        event          TEXT NOT NULL,              -- submitted/approved/rejected/on/off/stock
        note           TEXT NOT NULL DEFAULT '',
        actor          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mpe_product ON merchant_product_events(product_id, id);

      -- 店铺资料：店名 / 简介 / 字标 / 主色 / Logo 对象键。
      -- Logo 存**对象键**，不存 URL：预签名地址 15 分钟就过期，存下来第二天是死链。
      CREATE TABLE IF NOT EXISTS merchant_shops (
        application_id TEXT PRIMARY KEY REFERENCES merchant_applications(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        intro          TEXT NOT NULL DEFAULT '',
        logo_text      TEXT NOT NULL DEFAULT '',
        logo_color     INTEGER NOT NULL DEFAULT 0,
        logo_key       TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
