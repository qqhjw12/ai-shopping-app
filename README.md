# AI 购物助手 · 全栈 Demo（Route A）

> 一个融合 **6 大 AI 能力** 的电商购物应用：AI 导购、智能客服、商品问答、智能搜索、运营文案、订单售后。
> 前端为**原生零构建**静态站点（HTML + CSS + ES Module），后端 `ai-gateway` 采用「local 降级 / docker 真实服务」双模式。
>
> 🔗 在线演示：<https://qqhjw12.github.io/ai-shopping-app/> （GitHub Pages 自动部署，默认演示模式，可 `?api=` 接入本地网关）

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [数据层与对话引擎](#数据层与对话引擎)
  - [SQLite 数据库（local 模式）](#sqlite-数据库local-模式)
  - [购物交易链路（后端）](#购物交易链路后端)
  - [收货地址跨设备（服务端为准）](#收货地址跨设备服务端为准)
  - [对话引擎（srcserviceschatenginejs）](#对话引擎srcserviceschatenginejs)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
  - [方式 A：本地零依赖演示（推荐先跑这个）](#方式-a本地零依赖演示推荐先跑这个)
  - [方式 B：Docker 真实服务（Qdrant / ES / Ollama / Dify / mall）](#方式-bdocker-真实服务qdrant--es--ollama--dify--mall)
  - [方式 C：HTTPS 反向代理（nginx 一键脚本）](#方式-chttps-反向代理nginx-一键脚本)
- [环境变量](#环境变量)
- [API 一览](#api-一览)
  - [推荐来源埋点（全链路数据闭环）](#推荐来源埋点全链路数据闭环)
- [买家秀对象存储（预签名 URL）](#买家秀对象存储预签名-url)
  - [真实商品数据导入（合规开放数据源）](#真实商品数据导入合规开放数据源)
- [部署演示站点（GitHub Pages + Actions）](#部署演示站点github-pages--actions)
- [商品视觉（程序化 SVG）](#商品视觉程序化-svg)
- [演示模式（前端离线兜底）](#演示模式前端离线兜底)
- [本地自检](#本地自检)
- [安全与配置](#安全与配置)
- [许可证](#许可证)

---

## 项目简介

本仓库是「宏之蓝 / macrozheng mall」生态的一个 AI 增强示例（Route A）：

- **后端 `ai-gateway`**：Node.js（ESM）网关，提供商品检索、AI 导购/客服/问答流式接口，以及对 Dify 中枢的编排。
  - `RUN_MODE=local`：内置 **SQLite 数据库**——示例种子 256 款，经 `db:ingest` + `db:dummyjson` + `db:cleveland` 已灌入真实开放数据商品至 **43757 款 / 46083 SKU / 129077 评价 / 15430 品牌**（图书文娱 21824、食品生鲜 12602、美妆个护 6685、宠物 1777、健康保健 308、母婴玩具 217…）+ 本地哈希嵌入 + 本地对话引擎，**零外部依赖即可演示**。
  - `RUN_MODE=docker`：接入真实 Qdrant（向量）、Elasticsearch（关键词）、Ollama（嵌入）、Dify（智能客服 / 商品问答 / 导购 Agent / 运营文案 / 订单售后），失败自动降级。
- **前端 `web/`**：原生 ES Module 单页应用，hash 路由、购物车服务端持久化（离线回落 localStorage）、AI 浮窗（导购/客服/问答均 SSE 逐字渲染）、商品详情深链分享（含来源埋点）、程序化生成的 SVG 商品图。

适合作为**作品集 / 面试项目**：架构清晰、工程规范、可一键本地演示，也能切换到生产级 docker 栈。

---

## 功能特性

| 模块 | 入口 | 说明 |
|------|------|------|
| 🔍 智能搜索 | 顶栏搜索（`#/search`） | 关键词匹配商品名 / 描述 / 标签 / 品牌类目，多词 AND 语义；空关键词显示「热门搜索词」占位（由真实数据分面生成，点了一定有结果）；搜索结果与商品列表共用同一套筛选与排序 |
| 📦 商品详情 | `#/product/:id` | 真实路由，可深链分享；SKU 规格切换联动价格库存、服务承诺、相关推荐、来源渠道色条与埋点；评价区支持 **写评价 / 买家秀上传 / 追评 / 有用投票**（走网关 API 持久化，断网自动降级 localStorage）、**综合星级与分布条 / 筛选（含「只看有图」）/ 排序 / 分页**、评价空态金色细线插画；**AI 评价摘要卡**（好评焦点 / 差评焦点，标注「AI 生成，仅供参考」）；**商品问答区**（内置问答 + mock 提问，商家自动回复，localStorage 持久化） |
| 🗂️ 分类浏览 | `#/categories` | 16 个一级类目 + 48 个二级类目：**顶部快速导航条**（横向 chips，类目图标 + 金色件数，一键直达）；每个类目用真实商品封面拼图；类目目录本身支持价格区间筛选与排序，条件写进 URL 且点进类目时带进商品列表 |
| 🛒 商品列表 | `#/products` | 共享检索引擎：品类/子类/品牌 **多选**、价格区间多选（档位左闭右开不重不漏）、颜色/规格属性（从 SKU 规格自动归一）、仅看有货；排序「综合 / 价格升降 / 销量 / 上新」下拉；已选条件胶囊行（单个移除 + 清空全部）；结果数、继续浏览分批、无结果安静空态；全部条件走 hash URL，刷新/分享还原；**左栏分类树导航**（一级分类 + 选中展开子类，全部带实时件数徽标，点击即筛，页头大标题联动；移动端随筛选一起收进底部弹层，选完自动收起）；移动端筛选收进底部弹层 |
| 🛒 购物车 | 顶栏抽屉 + `#/cart` | 服务端持久化，换设备/清缓存不丢；数量增减（受库存夹逼，边界置灰）、行内小计、删除后可撤销、库存不足拦截结算；抽屉与整页互通，运费/券统一在结算页确认 |
| 🎟️ 优惠券中心 | `#/coupons` + `#/account?tab=coupons` | 可领取券列表（面额 / 门槛 / 有效期 / 适用范围，票券卡带齿孔虚线），已领取按钮置灰、重复领取被拒；未登录点领取跳登录并回跳。我的券包分**未使用 / 已使用 / 已过期**三 Tab（状态由到期时间实时推导），未使用的可直接「去使用」，已使用的标注订单号。**券包与网关卡包双向同步**：换设备登录同一手机号即看到同一份券，核销/返还顺延以服务端为准，离线领的券联网后补推 |
| 🧾 结算下单 | `#/checkout` | 左右两栏（移动端单栏）：收货地址（**与个人中心共用同一份地址簿，可新增**，未选地址禁提交）+ 配送方式（**运费与时效来自运营配置** `GET /api/config`，默认标准免运费 / 加急 ¥18）+ 支付方式（**来自运营配置** `GET /api/config`，默认在线支付 / 货到付款 mock）+ **优惠券（自动选最优，随金额实时重算；可手动更换/取消，未达门槛显示差额）** + 订单备注 + 商品清单（**行内 −/+ 改数量（库存夹逼）/ 删除**，也可返回购物袋修改）+ 金额汇总（`tabular-nums`，券名与抵扣实时联动）；提交香槟金按钮防重复点击，**下单走 `POST /api/orders` 由服务端事务完成建单与核销**（无网关时降级本地单 + 发件箱补推） |
| 🎉 订单成功 | `#/order-success/:id` | 订单号 + 应付金额 + 订单要素（状态 / 时间 / 配送 / 支付 / 收货），「查看订单」进详情、「继续购物」回商城；刷新不丢（本地订单簿兜底） |
| 📦 我的订单 | `#/orders` + `#/account?tab=orders` | 本地订单簿与网关订单合并展示；**待付款 / 待发货 / 已发货 / 已完成 / 售后中 / 已退款 / 已取消**状态机，演示模式可模拟支付，再次购买、物流信息；点卡片进订单详情 |
| 🚚 订单详情 | `#/account/order/:id` | **状态流转条**（四段细线金节点，阶段由时间戳推导——售后中的订单不会因此丢掉进度；已取消不画进度只留一行说明）+ **物流卡**（快递公司 / 运单号 + 四段式时间线：已揽收 / 运输中 / 派送中 / 已签收，未到达节点灰显「待更新」，未发货显示「待发货」占位）+ 商品清单 / 收货信息 / 金额（`tabular-nums`）+ **售后记录**（类型 / 原因 / 说明 / 凭证文件名 / 处理说明 / 状态胶囊）+ 动作区（去支付为主按钮，申请售后与取消为细线按钮）。**申请售后弹层**：售后类型（仅退款 / 退货退款 / 换货）、原因下拉、问题说明（≤200 字）、凭证占位（只记文件名，最多 5 份）；提交后订单转「售后中」并生成售后单。售后处理完后记录里显示**审核结果**（同意 / 驳回 + 退款金额 + 时间）、审核意见与处理说明。卡片底部有不显眼的「演示用 · 模拟发货 / 模拟签收」文字按钮，仅用于演示状态流转 |
| 🛠 售后审核台 | `#/admin/aftersales`（**不在买家导航内，直接访问进入**） | 运营侧工单台：管理密钥 + 操作人署名双必填门禁（存 sessionStorage，关标签页即失效）、默认停在「待处理」、状态筛选与分页走路由（刷新不丢）、卡片展示订单实付与商品摘要；同意退款要填金额（默认实付、上限实付）、同意换货不带金额、驳回必须写理由。**「处理记录」标签**按处理时间倒序展示已处理工单，卡片署名处理人，顶部总览是全库数字（不随筛选变）。审核结果是**服务端事务**：同意退款 → 订单「已退款」，同意换货 → 订单回到「已发货」并换新运单号，驳回 → 退回申请时的状态 |
| 🤝 商家入驻 | 顶栏 / 页脚「商家入驻」（`#/merchant/join`） | 招商落地页：首屏价值主张（主 CTA 进申请页，次 CTA `scrollIntoView` 到流程区——hash 是路由，锚点不能写 `#xxx`）+ **深色平台数据面板**（实时取 `/api/stats`，静态演示站退化为本地演示库现算并如实标注）+ 四张安静的文字优势卡 + 五步入驻流程步骤条（移动端转纵向时间轴）+ 适合入驻的商家类型自筛清单；**吸底 CTA** 常驻（AI 浮窗自动抬高避让，`body.has-merchant-bar`）；移动端导航入口是 44px 高的金色胶囊（触控热区达标） |
| 📝 入驻申请 | `#/merchant/apply`（招商页主 CTA / 吸底 CTA 进入） | **分四步真表单**（主体资质 → 品牌商品 → 结算售后 → 确认提交）：步内校验不过不跳步、错误挂到具体字段并标红；服务端是权威校验，返回字段级错误时**自动跳回出错的那一步**。草稿存本机 localStorage（防抖写入、恢复时提示、可一键清空），提交成功即清空。**幂等**：submitKey 只在「结果未知」（5xx/断网）时复用，4xx 换新——既不会重复建单，也不会把改过的资料吞回旧单。**银行账号只存前 4 后 4**（`bank_no_masked`，完整卡号不落库不进日志）；查询凭证 queryKey 由服务端密钥 HMAC 派生、库里只存 sha256。提交成功跳状态页（`?id&key` 双要素回看，刷新/收藏夹都在），展示申请编号（可复制）、审核时间线与打码联系方式。**审核中可自助修改与撤回**：修改弹层只提交真正改过的字段（手机/邮箱/银行卡号默认留空 = 不修改，完整卡号不回显所以必须重输才能改），改动进审核轨迹并在状态页显示「修改过 N 次」；撤回是二次确认弹层，撤回后状态置「已撤回」（不是删除）、时间线标成「停下」并发一条回执通知。**静态演示站如实降级**：无网关时提示「申请没有提交」并保留草稿，绝不做假成功页 |
| 🏢 商家入驻审核台 | `#/admin/merchants`（**不在买家导航内，直接访问进入**；与售后台共用钥匙与署名，顶部标签互相切换） | 运营侧审核台：卡片一屏呈现**判断依据**（信用代码、主体类型、品牌来源、主营类目、SKU 与价格带、开户名/开户行/打码账号、售后与发货承诺）；通过与驳回共用弹层，**驳回理由必填**且原样进入给商家的通知；审核是**服务端事务**（改状态 + 写轨迹 + 排通知），终态再审 409。商家在审核期改过资料的卡片会标**「商家修改过 N 次」**（按最新一版重新看再下结论）；「已撤回」筛选下卡片说明是商家自己停的、不再进入审核。已处理卡片署名处理人、展示意见与**通知状态**（短信/邮件 已发送 · 待发送 · 未配置通道 · 发送失败）；头部总览含全库计数与**通知队列状态**，可手动「立即投递通知」，并可**按当前筛选导出 CSV**（UTF-8 BOM、公式注入转义、导出留痕、撞上限如实提示只导了前 N 条）。结果通知走出站队列（`merchant_notices`）：配了 `NOTIFY_WEBHOOK_URL` 就 POST（幂等可重试、3 次失败进死信），没配就如实标「未配置通道」——审核结果在商家状态页永远可见，不依赖通道 |
| 📮 通知模板 | `#/admin/notice-templates`（**不在买家导航内，直接访问进入**；与两个审核台共用钥匙，顶部第三个标签） | 审核结果 / 撤回回执发出的**原话在这里改**：默认模板开箱可用，表里只存覆盖项，「恢复默认」就是删行（默认文案今后升级不会被旧值顶住）。变量用**可点胶囊插入**（6 个：公司 / 编号 / 品牌 / 联系人 / 审核意见 / 状态），保存前做**变量白名单校验**——写错一个变量名直接 400，绝不给全体商家发「{{conpany}} 已通过」；**预览用编辑框里的未保存内容**渲染（可用真实申请或内置样例），保存是有副作用的动作，不该被当成「看效果」的必经步骤。短信/邮件通道可**单独关闭**（关了就不再排队，不是整条通知停掉）。模板在「排通知」那一刻渲染：改完只影响此后新排队的通知，已发出的不会变 |
| ❤️ 我的收藏 | 顶栏心形 + `#/favorites` | **本地优先**收藏夹（按用户/匿名身份分桶隔离，刷新与离线都不丢）：商品卡与详情页都有心形按钮（细线描边、金色选中态），支持取消收藏与一键加入购物袋；网关可用时与服务端收藏镜像**双向收敛**——增删走显式 `action=add/remove`（幂等），离线操作进待重放队列，联网后先补推再并回，弱网下不会把删除反转成新增 |
| 🕘 最近浏览 | 首页「最近浏览」轨道 | 进详情页自动记录（同款去重、最新置顶），首页横向滚动卡片展示最近 8 件（无记录时不占位），可一键清空，按用户隔离 |
| 🖼️ 图片搜索（色彩检索） | 搜索栏相机图标 | 图片**只在本机缩样提取主色签名**（原图永不上传），POST `/api/ai/image-search` 按色彩特征对在售商品做最近邻匹配；服务端不可用时退化为按文件名散列的演示结果，弹窗与结果区全程标注能力边界（色彩特征 ≠ 语义识别） |
| 🎨 商品视觉 | 全局 | **程序化 SVG 商品图**：按商品数据生成「渐变底 + 类目线稿」，零外部依赖、离线可用 |
| 📊 选购洞察 | 顶栏「选购洞察」 | 只读的**分析报告**（渠道占比 / 行为分布 / Top 商品 / 最近事件流，按渠道着色，数据来自埋点聚合）；标题与说明均点明「分析报告」，与 AI 工坊的生成工具区分 |
| 🤖 AI 导购 | 搜索栏 ✦ 按钮 / 首页 hero / 浮窗「导购」 | 搜索栏旁的 **AI 导购抽屉**（玻璃背景 + 顶部微光）：输入需求返回推荐商品卡（直接复用商品卡样式）。服务端优先——`/api/ai/recommend` 检索引擎直出（配了 `LLM_API_KEY` 时导购语由真实模型撰写），失败/超时/静态站回落本地关键词 + 预算规则；结果区按来源如实标注（模型撰写 / 网关检索 / 演示数据） |
| 💬 智能客服 | 浮窗「客服」 | 多轮对话（SSE 逐字），可接 Dify 知识库 |
| ❓ 商品问答 | 浮窗「问答」/ 详情页「问我这件商品」 | 按商品聚焦问答，SSE 逐字 + 关联商品卡片 |
| ✍️ 运营文案 | AI 工具箱 | 多版本标题 / 详情 / 种草文案（多平台语气） |
| 🛠️ 订单售后 | AI 工具箱 | 按用户 ID / 订单号查单 + 退换货指引 |

---

## 数据层与对话引擎

### SQLite 数据库（local 模式）

用 Node 22 内置的 `node:sqlite`，**零依赖、零安装、单文件持久化**（`ai-gateway/data/shop.db`），开启 WAL 与外键约束，结构通过版本化迁移管理（`PRAGMA user_version`）。

| 表 | 用途 |
|---|---|
| `categories` | **两级类目树**：16 个一级（手机数码 / 电脑办公 / 音频耳机 / 家用电器 / 服饰鞋包 / 食品生鲜 / 家居家具 / 运动户外 / 美妆个护 / 母婴玩具 / 图书文娱 / 厨具餐具 / 宠物用品 / 车载出行 / 健康保健 / 办公文具）+ 48 个二级（自引用 `parent_id`） |
| `brands` | 品牌（23 个，从商品派生，带主营类目与程序化 logo 色） |
| `products` | 商品主数据（256 款示例；可经 `db:ingest` 追加真实开放数据商品，含品牌 / 现价 / 原价 / 标签 / 评分 / 销量 / 封面渐变色 / 一句话卖点 / 服务承诺 / **二级类目** / 真实商品图 URL `image_url`） |
| `product_skus` | 规格变体与库存（150 个 SKU，按阶梯定价） |
| `users` / `addresses` | 演示用户与收货地址（下单时自动为新用户建档 + **三张体验优惠券**，避免新访客卡包为空导致优惠券区永远显示「暂无可用」）。地址按 `user_id` 隔离存在服务端，同一账号换设备登录即跟随；迁移 v8 补齐 `province` / `city` / `postal` / `updated_at`，老数据按 `region` 空格自动回填省市 |
| `orders` / `order_items` | 订单与订单项（含物流公司、运单号、状态机、金额拆分、配送/支付方式快照、`shipped_at` / `completed_at` 履约时间戳；`idempotency_key` + `(user_id, idempotency_key)` 部分唯一索引防重复下单） |
| `order_logistics_events` | 物流事件流水（`code` / `title` / `detail` / `happened_at` / `seq`，一次揽收、一次中转、一次派送、一次签收各一行）。时间线靠它渲染；`seq` 单独存是因为 mock 时同一分钟可能发生两件事，只按时间排会颠倒 |
| `aftersales` | 售后单（`type` 仅退款/退货退款/换货、`reason`、`note`、`evidence` 凭证 JSON（`{name,size,key}`，`key` 是对象存储键，旧数据只有文件名）、`status` 待处理/已同意/已驳回、`handle_note` 处理说明、`origin_status` 申请时的订单状态、`refund_amount` 退款金额（换货为 NULL）、`review_note` / `reviewer` / `reviewed_at` 审核留痕）。`(order_id) WHERE status='reviewing'` 部分唯一索引保证同一订单只有一条待处理申请 |
| `order_ledger` | 资金流水（`kind` payment/refund、`amount`、`channel`、`status` pending/settled、`aftersale_id` 关联工单、`settled_at` / `settled_by` 打款确认）。收款在支付时落、退款在审核同意时落（pending），运营点「确认已打款」才转 settled——承诺（该退）与事实（退了）是两条记录 |
| `reviews` | 商品评价（**768 条，覆盖全部 256 款**，每款 3 条带作者与星级，供问答引用口碑）。迁移 v6 起支持 `parent_id`（追评）/ `images`（买家秀）/ `sku_spec` / `source` |
| `review_votes` | 有用投票：主键 `(review_id, user_id)`，天然幂等——同一用户重复请求在「赞 / 取消」间切换 |
| `cart_items` | 购物车（服务端持久化，按 user+sku 唯一，重复加购累加） |
| `favorites` | 收藏夹 |
| `app_settings` | 运营配置（`shipping` 配送方式与运费 / `payment` 支付方式 / `coupon` 券顺延规则），JSON 文本 + 更新时间与操作人。迁移 v11 建表；表空则用代码里的默认值 |
| `coupons` / `user_coupons` | 优惠券模板与用户卡包（满减 / 折扣，领用核销）。迁移 v10 给券实例补了 `expires_at`（落库而不是各端现算，返还顺延才有唯一真源）与 `extension_count`；券模板补 `scope_text`，并把 id 与前端券目录对齐 |
| `faqs` / `policies` | 客服 FAQ 与退换货 / 物流 / 质保 / 发票 / 支付政策 |
| `conversations` / `messages` | 会话与消息（多轮上下文、可回放，重启不丢） |
| `track_events` | 埋点事件（替代原内存环形缓冲，聚合走 SQL） |

种子规模：**256 商品（示例）/ 556 SKU / 16 一级类目 / 48 二级类目 / 23 品牌 / 768 评价 / 7 订单 / 8 FAQ / 5 政策 / 6 张券**。执行 `db:ingest`（+ `db:dummyjson` + `db:cleveland`）后可扩至 **43757 商品 / 46083 SKU / 15430 品牌 / 129077 评价**——Free-Ecommerce 50 + Open Food Facts 家族 21449 + Open Library 19808 + DummyJSON 194 + 克利夫兰 CC0 藏品 2000，母婴 / 健康 / 文创等原先的空档品类均由开放数据填实。
`npm run db:seed` 幂等灌数据，`npm run db:reset` 清空重灌；两端都在启动时自动执行迁移 + 缺数据才种子。

### 购物交易链路（后端）

`/api/cart` → `/api/orders/preview` → `/api/orders` → `/api/orders/:id/pay`，全流程落在 SQLite：

- **下单在一个事务里完成**：校验库存 → 算钱（商品小计 / 运费 / 优惠）→ 扣 SKU 库存 → 建订单与订单项 → 清空已购购物车项 → 核销优惠券。任一环节失败全部回滚。
- **运费规则与 FAQ 政策一致**：满 99 包邮，否则 10 元（券前/券后金额以商品小计减优惠后判定）。
- **库存不足返回 409** 并提示剩余件数，而非静默失败；重复支付返回 409，订单按 `userId` 隔离（查他人订单 404）。。

### 收货地址跨设备（服务端为准）

同一个手机号/邮箱登录出来的 `userId` 是稳定的（由标识哈希得出），地址簿按 `userId` 存在服务端 `addresses` 表，所以**同一账号换设备登录，地址自动跟随**。

前端的读写策略是「缓存先出、服务端校准」：

| 时机 | 行为 |
|---|---|
| 进入个人中心 / 结算页 | 先用 localStorage 缓存秒开（不闪骨架），同时 `GET /api/addresses` 拉服务端覆盖缓存 |
| 新增 / 编辑 / 设默认 / 删除 | 乐观写缓存 → 调 API → 用服务端返回的清单覆盖；业务错误（400/404/409）回滚本地并提示 |
| 网关不可达 | 保留本地结果并标记 `pending: true`（卡片显示「仅本机」），下次进入页面自动逐条补推 |

几条不显眼但必要的约束：

- **默认地址有且仅有一条**：新增/更新/删除后由服务端 `settleDefault` 收敛（删掉默认项时剩余第一条接任），不靠前端自觉。
- **删除是软删除**：`orders.address_id` 外键指向 `addresses`，硬删会被外键挡下（下过单的用户永远删不掉那条地址）。迁移 v9 起改为打 `deleted_at` 时间戳、列表查询过滤——用户视角就是「已删除」，历史订单仍能追溯，软删除的条目也不占 20 条上限。
- **越权改不到别人的地址**：更新/删除都是 `WHERE id = ? AND user_id = ?` 双条件，拿别人地址 id 请求返回 404。
- **只传 `region` 也能存**：结算页的地区是单个输入框，服务端会按空格拆出 `province` / `city`，否则回个人中心编辑时省份下拉选不中、再保存一次就把地区写丢。
- **`ensureUser` 不再自动塞示例地址**：否则每次登录都会凭空多一条「游客 · 示例路 1 号」，跨设备后尤其刺眼。兜底只在「结算时地址簿为空」这一处发生。
- **结算页与个人中心共用一份存储**：`loadAddresses` 直接委托地址簿模块，不再各自维护一份，避免「个人中心加了地址、结算页看不到」。

### 交易闭环（购物袋 → 结算 → 下单 → 成功页）

前端在「静态可演示」与「网关在线」两种形态下都成立：

| 路由 | 作用 |
|---|---|
| `#/cart` | 购物袋整页（抽屉保留，两入口互通）：清单 + 金额小计 + 去结算 |
| `#/checkout` | 结算页：地址 / 配送 / 支付 / 备注 / 清单 / 金额汇总，未登录跳登录（带 `redirect`），未选地址禁提交 |
| `#/order-success/:id` | 订单成功页，按 id 从本地订单簿复原，刷新不丢 |
| `#/account/order/:id` | 订单详情：本地订单优先，查不到再问网关 |

几条关键约定：

- **订单落在 localStorage，按 `userId` 分区**（键 `maison_orders::<userId>`）：换了账号就是换了键，天然隔离；每个账户最多保留 60 条，防止无限膨胀。订单结构为 `id / userId / items[] / address / shippingMethod / paymentMethod / remark / amounts / status / createdAt`。
- **订单号 `MS + 年月日 + 4 位序号`**：序号按当天已有订单数推进，纯随机会让同一秒的两次下单撞号。
- **金额只算一次**：`store/orderStore.js` 的 `computeAmounts` 是唯一入口（商品总额 + 运费 − 券抵扣 = 应付），页面不另写一份；券抵扣额由 `couponStore.decorate` 按当前商品总额实时算，改数量/删件立即重算，无需重新请求。
- **配送方式是 mock**：标准配送免运费（3–5 个工作日）、加急配送 ¥18（次日达）；支付方式仅记录选择。购物袋抽屉因此只报商品小计，运费统一在结算页按配送方式确认，避免两处数字打架。
- **提交后只清已结算的商品**：结算期间在别处新加购的东西不会被顺手清掉。
- **本地下单与网关订单合并展示**：个人中心订单 Tab 与 `#/orders` 用 `mergeOrders` 按订单号去重、按时间倒序；演示模式的「去支付」直接把状态推进到已付款，让状态机在纯静态站点也看得见。
- **静态托管没有 `/api/*`**：首个 404 会话级记住（`maison_no_backend`），后续请求直接本地降级，控制台不再刷 404；显式 `?api=` 指定网关时不受影响（404 是真错误）。

### 优惠券（领取 → 券包 → 抵扣 → 核销 → 返还顺延）

券域全部收敛在 `web/js/store/couponStore.js`（前端）与 `ai-gateway/src/services/couponRules.js`（服务端），页面只负责渲染。**规则值只有服务端一份真源**（`app_settings` → `GET /api/config` → 前端 `store/config.js` 缓存），前端那份只是离线兜底，不再靠「记得两边同时改」：

| 环节 | 实现 |
|---|---|
| 券目录 | 内置 `COUPON_CATALOG` 做离线兜底，联网时用 `GET /api/coupons/catalog` 覆盖（运营改面额/文案不用发版）。**id 与网关 `coupons` 表严格一致**——两端 id 不同步，同一张券会在券中心和网关卡包里变成两只券 |
| 领取 | `claimCoupon` 先写本地再 `POST /api/coupons`，成功后用服务端返回的实例 id 与 `expiresAt` 回填（各设备到期日必须一致）；静态站 404 时本地成功，靠 `syncWallet` 的补推把离线领的券补上云 |
| 状态 | 落盘只存事实（`couponId / claimedAt / expiresAt / usedOrderId / extensionCount`），`unused / used / expired` 由到期时间推导——不需要定时任务把券「跑成过期」；服务端 `expires_at` 落库，不再各端用 `claimed_at + expire_days` 各算一遍 |
| 可用性 | `decorateMine(list, productAmount)` 同时给出 `usable`、可省金额 `worth`、门槛差额 `gap` 与人话原因 `reason`；不可用券在结算页原样展示原因而不是隐藏 |
| 最优 | `bestCouponId` 按省得最多排序、平手取门槛高的；结算页首次进入自动选中，改数量后若用户没手动干预过就按新金额重选，手动点选即接管 |
| 核销 | **在服务端下单事务里做**：`POST /api/orders` 的 `createOrder` 依次校验 → 扣库存 → 建单 → 核销券，任一失败全回滚。前端不再发核销请求，只在下单成功后 `syncWallet` 拉回服务端状态；无网关时降级本地核销 + 发件箱（`keepalive` 让请求活过跳转） |
| 返还 | **在服务端取消事务里做**：`POST /api/orders/:id/cancel` 一个事务里置 closed + 退券 + 顺延，幂等（已关闭再取消不会重复顺延）。顺延从 `max(原到期, 现在)` 起算——券在订单占用期间过期了也能退回来立刻可用 |
| 顺延规则 | 顺延天数与次数上限是**运营可配**的（`GET/PUT /api/config`，默认 7 天 / 3 次），不再写死；前端经 `store/config.js` 读同一份配置，服务端才是唯一真源 |

**跨设备同步**（`syncWallet` + 纯函数 `mergeWallet`）：

- **同号同账户**：`userIdOf(identifier)` 把手机号/邮箱哈希成稳定 userId，两台设备登录同一手机号即同一个网关卡包。
- **服务端是核销/顺延的真源**：另一台设备用掉的券、返还顺延后的到期时间，本地同步时一律接受服务端的值。
- **本地是离线缓冲**：离线领的券、离线下单核销的券记进发件箱（`maison_coupon_ops::<uid>`），`syncWallet` 开头先重放；重放不成功就留着下次再试，不丢券。
- **本地已用 vs 服务端未用** 靠发件箱区分：还有未确认的 `use` → 是离线核销没推上去，补推；发件箱是空的 → 核销早送达了，服务端现在未使用只能是因为订单被取消返还了，本地跟着退回。
- **只增不删**：任一侧独有的券都保留，宁可多一张也不让用户觉得券消失了。

- **金额永不为负**：`computeAmounts` 对商品总额、运费、抵扣各做 `max(0, …)`，抵扣再 `min(…, 商品总额)` —— 券抵运费、抵成负数在结构上不可能出现。
- **键 `maison_coupons::<userId>`**：换账号即换键；券包只存已领取的实例，券模板永远从目录读，改文案不用迁移数据。
- **开户只送 3 张体验券**（`STARTER_COUPON_IDS`），其余要用户到券中心自己领——全量自动发放会让「领取」在服务端根本不存在，跨设备同步也就没有可同步的东西。

### 券目录运营写入（`PUT /api/coupons/catalog`）

券目录是「模板」，改一个数字会立刻改变**已经发出去**的券能抵扣多少——`worth` 是按目录现算的，不冻结在领取时。所以写入接口比读接口严得多：

| 规则 | 原因 |
|---|---|
| 只 upsert，不删除 | 删一张券会让已发出的实例变孤儿（外键级联会连带删掉用户卡包里的券），运营点错一下就是用户券消失。要下线一张券，改成 `amount: 0` 或换 title 说明停用，可追溯 |
| 整批校验通过才写 | 不做「部分成功」，否则运营拿到 200 却不知道哪几张没进去 |
| 改 `kind / threshold / amount` 且该券有未使用实例 → 409 | 这三项决定用户实际能抵多少钱。响应里写明每张券影响了多少张，确认后带 `force: true` 重试 |
| 改 `title / scopeText / expireDays` 不拦 | 前两个是话术；`expireDays` 只作用于之后领取的新券（`expires_at` 在领取时就落库了） |
| 需要 `X-Admin-Key` | 与 `/api/config` 同一把钥匙；未配置 `ADMIN_API_KEY` 时一律 403——「忘了配环境变量」不该变成「谁都能改券面额」 |

```bash
# 新增/修改一张券（不需要 force：文案与有效天数随便改）
curl -s -X PUT localhost:8080/api/coupons/catalog \
  -H 'content-type: application/json' -H "x-admin-key: $ADMIN_API_KEY" \
  -d '{"coupon":{"id":"cp-summer","title":"夏日专场 · 满 299 减 40","kind":"cash","threshold":299,"amount":40,"expireDays":20,"scopeText":"全场通用"}}'

# 改已发出券的面额：先被 409 拦一次，看清楚影响面再 force
curl -s -X PUT localhost:8080/api/coupons/catalog \
  -H 'content-type: application/json' -H "x-admin-key: $ADMIN_API_KEY" \
  -d '{"coupon":{"id":"cp-summer","title":"夏日专场 · 满 299 减 40","kind":"cash","threshold":299,"amount":50},"force":true}'
```

折扣券的 `amount` 是**减免百分比**（`10` = 减 10% = 9 折），与 `worth = floor(商品额 × amount / 100)` 和前端 `10 - amount/10 折` 的展示口径一致；写接口对两类券分别校验区间（满减 1–100000，折扣 1–95），混在一起校验会放过「折扣券直减 300 元」这种一眼错的配置。


### 运营配置（运费 / 配送方式 / 支付方式 / 券顺延规则）

这些参数以前写死在代码里（服务端一份、前端一份），改一个数字要发版，还必然出现「服务端改了前端没改」的错位——同一张券在两台设备上显示不同到期日。现在收敛成一张表 + 一个接口：

| 配置项 | 默认值 | 约束 |
|---|---|---|
| `shipping.methods[]` | 标准配送 ¥0（全场包邮）/ 加急配送 ¥18 | 1–5 项；`id` 小写字母开头且唯一；`fee` 0–999 整数；`freeOver` 为 `null` 或 0–100000 |
| `shipping.fallbackId` | `standard` | 必须是某个配送方式的 `id` |
| `payment.methods[]` | 在线支付 / 货到付款 | 1–5 项；`id` 规则同上；`name` ≤20 字、`note` ≤40 字。**不参与算钱**，只决定结算页选项与订单快照 |
| `payment.fallbackId` | `online` | 必须是某个支付方式的 `id` |
| `coupon.refundGraceDays` | `7` | 0–90 整数（配 0 = 返还但不顺延） |
| `coupon.maxExtensions` | `3` | 0–10 整数（0 = 不允许顺延） |

```bash
# 读（公开，未登录的结算页也要显示运费）
curl -s localhost:8080/api/config

# 写（需要 X-Admin-Key = ADMIN_API_KEY，留空则只读）
curl -s -X PUT localhost:8080/api/config \
  -H 'content-type: application/json' -H "x-admin-key: $ADMIN_API_KEY" \
  -d '{"coupon":{"refundGraceDays":10,"maxExtensions":2}}'

# 大促只保留在线支付
curl -s -X PUT localhost:8080/api/config \
  -H 'content-type: application/json' -H "x-admin-key: $ADMIN_API_KEY" \
  -d '{"payment":{"methods":[{"id":"online","name":"在线支付"}]}}'
```

设计要点：

- **默认值只有一份来源**：`settingsService.DEFAULT_SETTINGS`，表里没有就用它，迁移不插默认数据（否则「迁移插的旧默认值」会和「代码新默认值」长期打架）。前端 `store/config.js` 的 `DEFAULT_CONFIG` 是**离线兜底**，不是第二份真源。
- **写接口只收白名单字段并逐项校验**：`refundGraceDay`（少个 s）会直接报错而不是静默忽略——配置错了一样能算出负运费、零元订单。
- **读路径缓存 30 秒 + 写后失效**：本进程立刻看到新值，多实例部署最多等一个 TTL。库里某一项被手工改坏时只降级那一项并告警，不让结算页 500（收不了钱比算错钱更糟）。
- **结算页强制刷新配置**（`loadRuntimeConfig({ force: true })`）：这一页是「按下单金额收钱」的地方，多一个 GET 换「展示的运费就是实收的运费」很值——缓存里的旧运费会让用户看到 104、实际被收 114。
- **配置变了要无条件重绘**：配送方式与支付方式两块列表在拿到新配置后都重绘，而不是「只修选中项失效」。运营**新增**一个支付方式时选中项仍然有效，只修失效项的话页面还显示旧选项——「配置改了页面没变」和「配置没生效」在用户眼里是同一件事。
- **服务端与前端同公式**：`shippingFeeOf` 在两侧实现一致，包邮门槛按**券后商品金额**判断（先看商品总额会让用券把总额压到门槛以下的订单仍免运费，等于券抵了两次）。


### 订单事务：建单与核销同生共死

`POST /api/orders` 的 `createOrder` 在一个事务里完成：**校验库存 → 扣库存 → 建单 → 清购物车 → 核销优惠券**。任何一步失败整单回滚——不会出现「单建成了券还在手里」（用户白嫖一张券）或「券花掉了单没建成」（用户丢一张券）。

`POST /api/orders/:id/cancel` 同理：**置 closed + 券返还并顺延**在一个事务里，幂等（已关闭再取消不会重复顺延，否则「取消两次」就能把有效期刷长）。已发货订单返回 409，必须走售后。

前端因此不再自己发核销请求：结算页只调 `POST /api/orders`，成功后落一份本地镜像（编号/金额/状态全用服务端返回值）并 `syncWallet` 拉回券状态。`e2e-order-tx.mjs` 专门断言「全程没有 `POST /api/coupons/use`」——只要还能看到这条请求，就说明又退回两条腿走路了。

**降级路径**：无网关（纯静态托管 / 离线）时本地下单 + 券核销进发件箱补推；业务拒绝（库存不足 409、券不可用 400）必须如实显示，不偷偷改成本地单——否则用户以为下了一单，服务端其实没有。

### 下单幂等：同一次结算只可能生成一单

服务端事务保住了「建单与核销原子」，但保不住「响应丢包」。网络在「服务端已提交、响应没回到浏览器」的瞬间断掉时，用户看到的是失败，再点一次就是**第二张真实订单**，库存也扣两次。

`POST /api/orders` 因此接受幂等键：

- 客户端进结算页时生成一个键（`crypto.randomUUID` 去掉短横，退化为时间戳 + 随机），**整次结算会话恒定**，随请求体 `idempotencyKey` 或标准头 `Idempotency-Key` 提交。
- 服务端在事务内先查 `(user_id, idempotency_key)`：命中就把那一单原样返回并标 `replayed: true`，不再扣库存、不再清购物车、不再核销券。
- 并发抢跑撞唯一索引（两人几乎同时提交同一个键）→ 回滚后重查，返回先插进去的那一单。用户视角这就是「同一次提交」。
- 键不合法（太短/含非法字符）当作**没传**，退化成原有行为而不是报错——老客户端不传键不该直接下不了单。

```sql
-- 迁移 v13：部分唯一索引，历史订单 key 为 NULL 不参与约束
CREATE UNIQUE INDEX idx_orders_idem ON orders(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

前端对失败的处置也随之改了：**网络异常（可能已到达服务端）不再降级本地单**，而是带同一个键自动重放一次；重放仍失败才提示「订单可能已提交成功，请到『我的订单』确认」。只有 404/405/501（这个部署没有后端）与真离线才走本地降级——这两种情况下请求肯定没发出去，不会重复。`e2e-idempotency.mjs` 用 `page.route` 掐断第一次请求，断言两次提交携带同一个键且服务端只有一单。


### 订单履约与售后（状态流转 / 物流时间线 / 售后单）

订单状态机：`pending`（待付款）→ `paid`（待发货）→ `shipped`（已发货）→ `completed`（已完成）；`closed`（已取消）与 `refunding`（售后中）是两条侧枝，售后审完再落到 `refunded`（已退款）或退回原状态。

**阶段不看 status，看时间戳**。详情页那条四段流转条由 `created_at / paid_at / shipped_at / completed_at` 推导，`status` 只负责右上角那个胶囊：

- 售后中的订单 status 只剩「售后中」一个词，拿它当阶段会让整条进度消失——用户看不到自己走到了哪一步；
- 已取消的订单干脆不画进度（走到一半停了，画出来反而误导「停在哪」），只留一行「订单已取消」。

**物流是事件流水，不是一行快照**。原先只有 `logistics_company` + `tracking_no` + 一句描述，画不出过程；现在 `order_logistics_events` 一行一条（揽收 / 运输 / 派送 / 签收），详情页固定画四段，**未到达的节点灰显「待更新」**——空白时间线看起来像数据没加载出来，灰节点至少告诉用户还剩几步。

- 时间戳刻意错开一分钟：一次「模拟发货」同时产生「已揽收」和「运输中」两条，同秒像重复记录，放到未来又自相矛盾。
- 未发货不画时间线，显示「待发货」占位 + 一句说明（付款后 / 打包中两种文案）。
- 历史订单（迁移前就有快递单号、却没有事件行）在启动时**幂等回填**：按 `created_at` 推一个合理的过去时间，且只在该单没有任何事件时写，重复启动不会重复插入。前端另有一层兜底：`status` 是已发货/已完成但没有事件时，按时间戳合成节点。

**售后单**（`aftersales`）：

| 规则 | 取值 | 为什么 |
|---|---|---|
| 可申请状态 | `shipped` / `completed` | 没发货的单直接取消就行，取消路径已经会退券 |
| 类型 | 仅退款 / 退货退款 / 换货 | 三种的终态不同：前两种退钱，换货换成货 |
| 原因 | 质量问题 / 与描述不符 / 运输破损 / 不合适 / 其他 | 固定枚举，客服才能按原因分流 |
| 说明 | ≤200 字 | |
| 凭证 | 最多 5 份，**只存文件名** | 演示站没有对象存储与审核后台，假装上传只会让人以为图真到了客服那边；表单里直接写明这一点 |
| 同一订单待处理申请 | 最多 1 条（`WHERE status='reviewing'` 部分唯一索引） | 连点几次提交会堆出一串重复工单 |

提交走 `POST /api/orders/:id/aftersale`，**一个事务里落售后单 + 把订单置 `refunding`**：只落单不改状态，顶部胶囊还显示「已完成」，用户以为申请没生效；只改状态不落单，售后入口就变成一颗只改标签的按钮。业务拒绝（已有待处理申请 409、状态不支持 400）如实显示，不偷偷降级成本地记录——否则用户以为提交成功了，客服那边根本没有这条工单。

#### 售后审核（`PATCH /api/aftersales/:id`）

审核把 `approved` / `rejected` 从两个词变成真的会搬动订单的流程，**改工单与改订单在同一个事务里**：

| 动作 | 工单 → | 订单 → | 退款金额 |
|---|---|---|---|
| 同意（仅退款 / 退货退款） | `approved` | `refunded`（已退款，终态） | 必填，默认订单实付，**上限实付**（手滑多打一个 0 就是真实损失，没有资金流兜） |
| 同意（换货） | `approved` | `shipped`（重新发一趟） | 不产生，存 `NULL` 而不是 0（0 会被当成「全额用券抵扣」） |
| 驳回 | `rejected` | 退回 `origin_status` | — |

- `origin_status` 在**提交申请那一刻**存下来：等审核时订单已经是 `refunding`，原状态在库里查不到了，不单独存一列就只能靠猜「它之前大概到哪了」，猜错就是把已签收的单退回在途。迁移 v15 给存量工单按 `completed_at` 补过，没有的兜 `completed`。
- 换货同意会换新运单号、更新 `shipped_at`、清空 `completed_at`，并**追加**两条物流事件：新货确实从仓库重新发出，而上一趟的物流是既成事实，擦掉它等于篡改历史。
- 驳回的理由**必填**，且会作为处理说明展示给用户：「已驳回」三个字没有信息量，只会招来下一通投诉。
- 三道守卫：工单非 `reviewing` → 409（连点两次同意不该产生两条审核记录）；订单非 `refunding` → 409（说明有人绕过工单直接改了订单，此时审核就不是处理申请而是覆盖别人的结果）；金额不合法 → 400。
- 读也要鉴权：工单里有收货地址、电话和用户原话，匿名可读等于把投诉内容挂在公网上。

运营侧审核台在 `#/admin/aftersales`（**不在买家导航里出现**，直接访问地址进入）：

- 门禁收两样：服务端的管理密钥（`X-Admin-Key`）+ **操作人署名**，都必填。一条没有署名的处理记录等于没记，出了事谁都能说不是自己干的。两者都存在 **sessionStorage** 而不是 localStorage——写进 localStorage 的凭据会一直躺在硬盘上，谁打开这台电脑谁就是管理员；
- 默认停在「待处理」，筛选与分页都走路由（`?status=&page=`），刷新与前进后退都停在同一处；
- 「处理记录」标签只看已处理的工单，且**按处理时间倒序**：操作记录要回答的是「最近处理了什么」，按提交时间排会把一早提交、下午才处理的工单混在三天前那批里；
- 顶部总览（待处理 / 已同意 / 已驳回 / 退款合计）是**全库**的，不跟着筛选变——切标签是换视角，不是换账本。当前视图的条数单独写作「当前 N 条」，免得和旁边的全库数字打架；
- 卡片上能看到**凭证原图**（点开放大）与**打款状态**：审核同意只是「该退」，点「确认已打款」才在账本上记「退了」——两件事在账本上是两条记录，界面上也分开两行；
- 网关不可达 / 密钥被拒时给空态与重试，或退回密钥门，不白屏。

三条曾经的遗留在这里闭环：

- **资金流**：`order_ledger` 流水表。支付落收款、审核同意落退款（pending），运营确认打款才转 settled。退款上限是**剩余可退额度**（实付 − 已退合计）而不是实付——换货同意会让订单回到可申请售后的状态，按实付夹就能退两遍。演示站没有真实支付渠道，这本账是记账性质的，但账是真的、可对账（每单实付/已退/可退一目了然）；
- **凭证入对象存储**：售后弹层真上传（压缩 → `POST /api/aftersale/evidence` → 对象键），与买家秀共用 `reviews|evidence` 双前缀的存储门面与孤儿清理；工单与详情页都渲染缩略图，旧工单（升级前只有文件名）照旧显示文件名，不假装有图；
- **快递 webhook**：`POST /api/webhooks/logistics`，HMAC-SHA256 每渠道一密钥 + 时间戳防重放，事件去重靠库层唯一索引。签收推进 `completed`，时间取快递给的而不是服务器收包时间。坏数据（签收早于下单、事件在未来）**收下 200 但不落地**——返回 4xx 快递会无限重推，重推一万次坏数据还是坏的。

**署名的边界要说清楚**：`X-Admin-Actor` 是客户端自报的，能发请求的人就能把它写成任何名字，所以它回答的只是「谁说自己做的」。服务端另外按钥匙本身算了 sha256 短指纹写进日志（`aftersale.reviewed` 的 `keyFp` 字段），这个改不动——能追责的是它。想让名字变得可信，正确做法是给每个运营发一把不同的 `ADMIN_API_KEY`，而不是继续在这个自报字段上加校验。

另外这个名字**必须 URL 编码后才能进 HTTP 头**：头值只吃可打印 ASCII，中文名直接放进去会让 `fetch` 在构造 `Request` 时就抛 `TypeError`，连请求都发不出去（页面只会看到一句「网络异常」）。用 ASCII 名字测试发现不了这个问题——而真实运营用的偏偏是中文名，所以 e2e 里两条路径刻意都用中文。

**演示按钮**（模拟发货 / 模拟签收）只在「这一步确实可推进」时出现，样式是卡片底部最低对比的小号下划线文字。`DEMO_ACTIONS=false` 时整组端点关掉（服务端 403，不是只把按钮藏起来——藏起来只防手滑，防不了直接调接口的人）；支付、取消、售后这些真实路径不受影响。纯静态站点没有服务端可以推进状态，前端对本地单（`MS…`）用同一套规则本地生成事件，保证离线演示也能走完整条路。

### 对话引擎（`src/services/chatEngine.js`）

**先检索真实数据，再组织语言**——价格、库存、物流、政策一律查 SQLite，绝不交给模型编造。

```
用户输入 → 意图识别 → SQLite 检索 → 事实草稿 ─┬─ 未配 LLM：直接作为答案（规则模板）
                                              └─ 配了 LLM：连同商品/政策/订单上下文喂给模型润色
```

| 意图 | 触发示例 | 数据来源 |
|---|---|---|
| `greeting` / `thanks` | 你好 / 谢谢 | 类目与商品统计 |
| `recommend` | 预算1500的降噪耳机、送礼500以内 | 预算 + 类目 + 标签多条件 SQL |
| `price` / `stock` | 声海耳机多少钱 / 有货吗 | `products` + `product_skus` |
| `compare` | 这两款哪个好 | 双商品对比（价格/评分/销量/标签） |
| `logistics` | SO2026… 到哪了、我买的笔记本到哪了 | `orders` + `order_items`（按商品名匹配订单） |
| `aftersale` | 七天无理由怎么退、保修多久、开发票 | `policies` + `faqs` + 订单状态 |
| `product-detail` | 详情页「问我这件商品」 | 商品详情 + SKU + 真实评价 |

要点：

- **中文关键词匹配**：没有分词器，就用「商品标签 + 品牌 + 类目 + 常见名词」组词表做最长匹配，`预算1500的降噪耳机` 能正确命中「降噪」而不是整句 LIKE。
- **多轮上下文**：预算 / 类目 / 上次商品写入 `conversations.context`，所以「有货吗」「那便宜点的呢」能承接上文。
- **LLM 可选且可降级**：配 `LLM_API_KEY` 走 OpenAI 兼容协议（支持 SSE 流式）；模型调用失败自动回退本地引擎，服务不会因此不可用。商品卡片始终由网关检索产出，不依赖模型。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器（web/ 原生 ES Module 单页应用）                       │
│   hash 路由 · 购物车(服务端+离线镜像) · AI 浮窗(SSE 逐字)   │
│   程序化 SVG 商品图 · 结算/订单/收藏 · hash 来源埋点          │
└───────────────┬─────────────────────────────────────────────┘
                │  fetch /api/*（同源 或 ?api= 覆盖）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  ai-gateway (Node.js ESM)                                    │
│  ├─ /api/products · /api/products/:id · /api/search          │
│  ├─ /api/cart · /api/orders · /api/favorites · /api/coupons   │
│  ├─ /api/ai/{guide,chat,qa,copywrite,aftersale}  (SSE 流式)  │
│  ├─ 混合检索: vectorStore(Qdrant) + searchStore(ES)          │
│  ├─ SQLite: 商品/SKU/订单/购物车/收藏/券/会话/埋点            │
│  ├─ 对话引擎: 意图识别 + SQL 检索 (+ 可选 LLM 润色)          │
│  └─ Dify 编排: 客服 / 问答 / 导购 Agent / 文案 / 售后         │
└───────┬───────────────────────┬──────────────────────────────┘
        │ (docker 模式)          │ (可选) HTTPS 终止 + 注入 API Key
        ▼                        ▼
 Qdrant · ES · Ollama      nginx 反代 (TLS, X-API-Key 注入)
        │
     Dify（智能体 / 知识库 / 工作流）
        │
     mall（macrozheng/mall 商品 & 订单，mall-ai 模块回调）
```

**设计要点**

- 前端零构建、后端分层（控制器 / 服务 / 仓储），配置全部来自环境变量并在启动时校验。
- 双模式契约：`local` 保证任何环境都能跑起来；`docker` 接真实向量/搜索/LLM 与 Dify，未就绪时自动降级。
- 流式统一用 `text/event-stream`：网关逐段回传 `data: {"text":"…"}`，末事件携带结构化数据，最后 `data: [DONE]`；未启用流式时回退为普通 JSON（前端 `streamApi` 自动兼容）。

---

## 技术栈

- **前端**：原生 HTML + CSS + ES Module（无框架、无打包器）；hash 路由、Fetch + SSE。
- **后端**：Node.js 20+（ESM，仅用内置模块 + 少量依赖）；`http` 自建服务，分层架构。
- **本地数据**：SQLite（Node 22 内置 `node:sqlite`，零依赖零安装，单文件持久化 + 版本化迁移）。
- **对话**：内置意图识别 + SQL 检索引擎；可选接 OpenAI 兼容大模型（DeepSeek / 通义 / Kimi / OpenAI）。
- **检索 / 模型**：Qdrant（向量）、Elasticsearch（关键词）、Ollama（嵌入，可换 `local` 哈希嵌入）。
- **AI 中枢**：Dify（智能客服 / 商品问答 / 导购 Agent / 运营文案 / 订单售后 工作流）。
- **电商底座**：macrozheng/mall（商品 & 订单）+ `mall-ai` 自定义模块。
- **运维**：Docker Compose（网关 / Qdrant / ES / Ollama / Dify / mall）、nginx 反代一键脚本（TLS 终止 + API Key 注入）。
- **部署**：GitHub Pages + GitHub Actions（自动发布 `web/`）。

---

## 目录结构

```
.
├── web/                     # 原生零构建前端（静态站点，可直托 GitHub Pages）
│   ├── index.html
│   ├── styles.css
│   └── js/                  # api / state / ui / router / views / assistant / tools / app
│       ├── art.js           # 程序化商品图：双色渐变 + 16 类目线稿（SVG）
│       ├── categories.js    # 分类浏览页（两级类目 + 商品封面拼图）
│       ├── checkout.js      # 结算页：地址 + 优惠券 + 金额明细 + 提交 + 支付
│       ├── coupons.js       # 优惠券中心（领券 / 券包摘要 / 领取状态回显）
│       ├── orderDetail.js   # 订单详情：状态流转 / 物流时间线 / 售后申请与记录
│       ├── adminAftersales.js # 运营售后审核台（#/admin/aftersales，管理密钥门禁）
│       ├── account.js       # 我的订单 / 我的收藏
│       ├── track.js         # 埋点上报（fire-and-forget）+ stats 拉取
│       ├── analytics.js     # 分析看板（渠道占比 / 行为分布 / Top 商品 / 事件流）
│       ├── demo.js          # 演示模式标志（网关不可达时置位）
│       ├── demo-data.js     # 内置示例商品库（离线兜底，由 catalog 生成，256 款）
│       ├── demo-real-data.js # 真实开放数据商品（离线兜底，由 ingest-real-data.mjs 生成）
│       └── store/           # 领域服务层：cart / address / order / coupon / catalog / qa / config(运营配置)
│                            #          logistics(物流阶段词表·时间线推导) / aftersale(售后单本地仓)
├── ai-gateway/              # Node.js 后端网关（local / docker 双模式）
│   ├── src/
│   │   ├── db/              # SQLite：connection / schema(版本迁移 v1-v16) / seedDb(种子)
│   │   ├── repositories/    # 仓储层：product / order / conversation / track
│   │   │                    #          cart(购物车) / user(收藏·券·地址)
│   │   ├── storage/         # 买家秀对象存储：s3Client(SigV4 手写) / index(驱动门面+签名解析)
│   │   ├── services/        # chatEngine(对话引擎) / llmClient(可选大模型)
│   │   │                    #          orderService(下单事务·金额·库存·取消)
│   │   │                    #          settingsService(运营配置) / couponRules(券状态·顺延)
│   │   │                    #          couponCatalogService(券目录运营写入·影响面校验)
│   │   │                    #          logisticsService(物流事件·运单号·时间线回填)
│   │   │                    #          aftersaleService(售后单：类型/原因/唯一待处理约束/审核事务)
│   │   ├── data/catalog.js  # 商品目录种子（256 款 / 16 一级类目 / 48 二级 / 556 SKU / 768 评价）
│   │   └── server / config / middleware / search / copywrite / aftersale …
│   ├── data/shop.db         # 本地数据库（gitignore，可 db:reset 重建）
│   ├── Dockerfile
│   └── dify-workflows/      # Dify 工作流 spec（售后 / 文案）
├── mall-ai/                 # macrozheng/mall 的 AI 增强模块（Java）
├── nginx/                   # 反代模板（envsubst，密钥不入库）
├── scripts/                 # dev-local.sh(一键起前后端) / dev-storage.sh(本地 S3 替身)
│                            #   / dev_server.py·static-server.mjs(静态开发服务)
│                            #   / check-web.mjs(前端自检) / setup-https-proxy.sh / setup-mall-ai-env.sh
├── docker-compose*.yml      # 网关 / nginx / dify / 全家桶
├── docs/                    # 实施记录与方案文档
├── .env.example             # 环境变量模板（真实密钥勿提交）
├── .gitattributes           # 统一换行符（eol=lf）
├── LICENSE                  # MIT
└── README.md                # 本文件
```

---

## 快速开始

### 方式 A：本地零依赖演示（推荐先跑这个）

无需 Docker、无需安装数据库：网关内置 **SQLite**（Node 22 自带 `node:sqlite`）与**本地对话引擎**，首次启动自动建表并灌入 256 款商品。

**一键启动（推荐）**：

```bash
bash scripts/dev-local.sh
# 网关 :8080 + 前端 :5500 一起起，就绪后打印访问地址；Ctrl+C 一并停止
```

脚本做的事：起网关 → 轮询 `/health` 直到就绪（最多 20s，失败直接报错并给出日志位置）→
起静态前端 → 轮询 `index.html` 确认能访问 → 打印横幅。端口被占用时会直接告诉你怎么换端口/查占用进程。

可调环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 网关端口 |
| `WEB_PORT` | `5500` | 前端端口 |
| `WEB_BIND` | `127.0.0.1` | 前端绑定地址（局域网调试可设 `0.0.0.0`） |
| `SKIP_GATEWAY` | `0` | 设 `1` 只起前端（网关已在跑或连远程网关时用） |

```bash
PORT=9090 WEB_PORT=5501 bash scripts/dev-local.sh   # 换端口
SKIP_GATEWAY=1 bash scripts/dev-local.sh            # 只起前端
```

手动分两步：

```bash
# 1) 启动后端网关（local 模式，默认 :8080）
cd ai-gateway
npm start            # 等价于 node --disable-warning=ExperimentalWarning src/server.js
#    首次启动会自动建库 + 种子：data/shop.db（256 商品 / 556 SKU / 48 二级类目 / 订单 / 评价 / FAQ）

# 2) 另开终端，启动静态前端（任意静态服务器均可）
python scripts/dev_server.py --port 5500 --directory web   # 有 Python 用它（推荐）
node scripts/static-server.mjs --port 5500 --root web      # 没 Python 的等价实现

# 3) 打开浏览器
#    同源时直接访问 http://localhost:5500
#    跨端口时显式指定网关：http://localhost:5500/?api=http://localhost:8080
```

> 为什么不用 `python -m http.server`：它依赖系统 mimetypes，Windows 上常把 `.js` 报成
> `text/plain`，ES Module 会被浏览器以严格 MIME 检查拒绝执行；也不会发 `no-store`，
> 改完 CSS/JS 容易拿到缓存旧版。`scripts/dev_server.py` 与 `scripts/static-server.mjs`
> 都强制 `text/javascript` + `Cache-Control: no-store`，并拦截 `.git`/`.env` 等隐藏路径。
> `dev-local.sh` 优先用 Python，Python 缺失或启动失败会自动降级到 Node 版本。

数据库维护命令：

```bash
npm run db:seed      # 幂等：缺数据才灌
npm run db:reset     # 清空业务表后重灌（商品/订单/评价/FAQ/会话/埋点）
```

冒烟测试：

```bash
curl -s http://localhost:8080/api/products | head
curl -s -X POST http://localhost:8080/api/search -H 'Content-Type: application/json' \
  -d '{"query":"降噪耳机","topK":3}'
curl -s -N -X POST http://localhost:8080/api/ai/guide -H 'Content-Type: application/json' \
  -d '{"message":"预算1500的降噪耳机","userId":"demo","stream":true}'
# 多轮：把上一轮返回的 conversationId 带上，即可承接上下文
curl -s -N -X POST http://localhost:8080/api/ai/chat -H 'Content-Type: application/json' \
  -d '{"message":"有货吗","userId":"demo","conversationId":"<上一步的 id>","stream":true}'
```

**想让 AI 更聪明？** 在 `.env` 里填三行即可从「内置引擎」升级为真大模型（OpenAI 兼容，DeepSeek / 通义 / Kimi / OpenAI 均可）：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=deepseek-chat
```

### 方式 B：Docker 真实服务（Qdrant / ES / Ollama / Dify / mall）

```bash
# 复制并填写 .env（至少配置 Dify 相关 App Key 才会切换真实流式）
cp .env.example .env
# 编辑 .env：RUN_MODE=docker，填入 DIFY_*_API_KEY 等

# 启动全家桶（网关 + Qdrant + ES + Ollama + Dify + mall）
docker compose -f docker-compose.yml up -d
# 仅网关 + 依赖（不含 Dify/mall）：
docker compose -f docker-compose.yml up -d ai-gateway qdrant elasticsearch ollama
```

> 未配置 Dify Key 时，网关自动从真实检索降级为本地模拟，保证可用。

### 方式 C：HTTPS 反向代理（nginx 一键脚本）

脚本会读取 `.env` → 生成自签名证书 → 启动 nginx（TLS 终止）并在网关侧**注入 API Key**（覆盖客户端自带头，防伪造），自动设置 `TRUST_PROXY` 与 `CORS_ORIGINS`：

```bash
bash scripts/setup-https-proxy.sh
# 浏览器打开 https://localhost:8443/  （自签名证书，首次需手动信任）
```

---

## 环境变量

所有配置来自环境变量，模板见 [`.env.example`](.env.example)。关键项：

| 变量 | 说明 |
|------|------|
| `RUN_MODE` | `local`（降级演示） / `docker`（真实服务） |
| `DB_FILE` | SQLite 数据文件路径，默认 `data/shop.db`（相对 `ai-gateway/`） |
| `LLM_API_KEY` | 可选。填写后启用 OpenAI 兼容大模型；留空走内置对话引擎 |
| `LLM_BASE_URL` / `LLM_MODEL` | 大模型地址与模型名（默认 DeepSeek） |
| `EMBEDDING_PROVIDER` | `local`（哈希嵌入，零依赖） / `ollama` |
| `DIFY_*_API_KEY` | 各 AI 模块的 Dify App Key（配置后启用真实流式） |
| `CORS_ORIGINS` | 显式允许来源，**生产严禁 `*`**；留空仅放行本地演示来源 |
| `AI_GATEWAY_API_KEY` | 设置后所有业务接口需 `X-API-Key`；留空则对外开放（仅限演示） |
| `ADMIN_API_KEY` | 管理写接口的 `X-Admin-Key`：`PUT /api/config`（运费/支付方式/券顺延）与 `PUT /api/coupons/catalog`（券目录）；**留空则两个写接口一律 403**。生产务必设置，勿用示例值 |
| `DEMO_ACTIONS` | 演示端点点开关。默认开：`POST /api/orders/:id/ship`、`/complete` 可用，详情页底部出现「模拟发货 / 模拟签收」。**生产必须设 `false`**，否则任何人都能推进订单状态；关掉后这两个端点返回 403，而支付 / 取消 / 售后等真实路径不受影响。`/health` 的 `demo` 字段可核对当前取值 |
| `RATE_LIMIT_PER_MIN` | 每 IP 每分钟限流（0 = 不限流） |
| `UPLOAD_MAX_BYTES` / `UPLOAD_RATE_PER_MIN` / `UPLOAD_DAILY_QUOTA` / `UPLOAD_MAX_CONCURRENT` | 上传加固：单张字节上限 / 每用户每分钟次数 / 每用户 24h 配额 / 全局并发上限 |
| `AUTH_JWT_SECRET` | 访问令牌 HS256 密钥，**生产必须配置**；local 留空会生成临时密钥（重启后令牌失效） |
| `AUTH_ACCESS_TTL_SEC` / `AUTH_REFRESH_TTL_SEC` | 访问令牌（默认 900s）/ 刷新令牌（默认 14 天）有效期 |
| `AUTH_REQUIRED` / `AUTH_COOKIE_SECURE` | 是否强制业务接口带令牌 / 刷新 Cookie 是否加 `Secure`（生产 HTTPS 置 true） |
| `HTTPS_PORT` / `DOMAIN` | nginx 反代对外端口与域名 |

---

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/products` | 商品列表（含封面色 / 卖点 / 评分 / 销量）；筛选 `category`/`sub`/`brand`/`minPrice`/`maxPrice`/`sort`(default·sales·price_asc·price_desc·rating·new)/`limit`/`offset`，返回 `{ total, count, products }` |
| GET  | `/api/products/:id` | 商品详情（含 SKU、评价、相关推荐） |
| GET  | `/api/products/:id/reviews` | 评价列表：`userId`/`filter`(all·good·mid·bad)/`sort`(latest·helpful)/`limit`/`offset`，返回 `{ reviews, summary, hasMore }`，追评嵌套在主评价的 `followUps` 内 |
| POST | `/api/reviews` | 发布评价；带 `parentId` 即追评。`{ productId|parentId, userId?, author?, rating?, content, skuSpec?, images? }` |
| POST | `/api/reviews/:id/helpful` | 有用投票 `{ userId }`，幂等：再请求一次即取消，返回 `{ voted, helpful }` |
| DELETE | `/api/reviews/:id` | 删除**本人**评价（校验归属，种子数据不可删）：级联删追评与投票、回滚商品评分，并回收图片对象，返回 `{ deleted, followUpsDeleted, imagesRemoved }` |
| POST | `/api/reviews/upload` | 买家秀上传 `{ data: base64, userId? }`，≤`UPLOAD_MAX_BYTES`（默认 6MB），返回 `{ key, url, expiresIn }`；类型 JPG/PNG/WebP/GIF（文件头校验）；受「每用户频率 + 每日配额 + 全局并发」保护，超限返回 429/503 |
| POST | `/api/auth/login` | 登录（演示项目无密码，`userId` 即身份）：`{ userId?, nickname? }` → `{ accessToken, expiresIn, user }`，刷新令牌写入 **HttpOnly Cookie** |
| POST | `/api/auth/refresh` | 用 Cookie 内刷新令牌换新访问令牌；**每次刷新轮换**，旧令牌作废，重放已用令牌则整族撤销（401） |
| POST | `/api/auth/logout` | 作废当前刷新令牌并清 Cookie |
| GET  | `/api/auth/me` | 携带 `Authorization: Bearer <accessToken>` 返回当前用户 |
| GET  | `/api/uploads/:name` | 读取**历史**买家秀（`STORAGE_DRIVER=local` 时的落盘位置；文件名 UUID + 白名单扩展名） |
| GET  | `/api/categories` | 类目列表（带商品数）；加 `?tree=1` 返回两级树与各类目商品数 |
| GET  | `/api/brands` | 品牌列表（可按 `category` 过滤，带商品数） |
| GET  | `/api/stats` | 站点规模概览：商品 / SKU / 类目 / 二级类目 / 品牌 / 评价数 |
| POST | `/api/search` | 混合检索 `{ query, topK }` |
| GET  | `/api/cart?userId=` | 购物车（服务端持久化） |
| POST | `/api/cart` | 加购 `{ userId, productId, skuId?, qty }`，返回最新购物车 |
| PATCH | `/api/cart` | 改数量 `{ userId, itemId, qty }`（≤0 视为移除） |
| DELETE | `/api/cart` | 带 `itemId` 删单项，否则清空 |
| POST | `/api/orders/preview` | 结算预览（不算钱不写库）：商品小计 / 运费 / 优惠 / 实付 |
| POST | `/api/orders` | 下单（**单事务**：校验库存→扣库存→建单→清购物车→核销券，任一失败全回滚）。接受 `idempotencyKey`（或 `Idempotency-Key` 头）：同键只建一单，命中返回原单并标 `replayed:true` |
| GET  | `/api/orders?userId=` | 我的订单列表 |
| GET  | `/api/orders/:id?userId=` | 订单详情（按用户隔离）：含 `logistics`（公司 / 运单号 / `shippedAt` / `completedAt` / `events[]`）与 `aftersales[]`。列表接口刻意不带这两块（避免 50 笔订单各查两次的 N+1） |
| POST | `/api/orders/:id/pay?userId=` | 支付（演示：pending → paid，幂等） |
| POST | `/api/orders/:id/cancel?userId=` | 取消订单（**单事务**：置 closed + 券返还并顺延有效期），幂等；已发货返回 409 |
| POST | `/api/orders/:id/ship?userId=` | **演示**：模拟发货 `paid → shipped`，生成快递公司与运单号 + 揽收/运输两条事件，幂等（重复调用不重新生成运单号）。`DEMO_ACTIONS=false` 时 403 |
| POST | `/api/orders/:id/complete?userId=` | **演示**：模拟签收 `shipped → completed`，追加派送中/已签收两条事件，幂等。`DEMO_ACTIONS=false` 时 403 |
| POST | `/api/orders/:id/aftersale` | 申请售后 `{ userId, type, reason, note?, evidence? }`（**单事务**：落售后单 + 订单置 `refunding`）。仅已发货 / 已完成可申请，同一订单已有待处理申请返回 409 |
| GET  | `/api/aftersales?status=&reviewed=&page=&size=` | **运营侧**工单列表（需 `X-Admin-Key`）。待处理排最前，组内按 `COALESCE(reviewed_at, created_at)` 倒序（待处理用提交时间、已处理用处理时间）；带订单实付与商品摘要（一次 IN 查询取回，不做 N+1）。`reviewed=1` 只看已处理、`=0` 只看待处理。`total` / `page` / `size` 用于分页，size 上限 50；另返回全库 `summary`（待处理 / 已同意 / 已驳回 / 退款合计与笔数），**不随筛选变化** |
| PATCH | `/api/aftersales/:id` | **运营侧审核**（需 `X-Admin-Key`）`{ action: approve\|reject, note, refundAmount? }`。**单事务**：工单改状态 + 订单落位 + 退款落账本。同意退款 → `refunded`（金额上限是**剩余可退额度** = 实付 − 已退合计，不是实付）；同意换货 → `shipped`（换新运单号并**追加**事件、清空签收时间，新事件下限 = 最后一条事件 + 1 分钟，同日换货不倒流也不撞去重索引）；驳回 → 退回申请时的状态。已处理过 409、订单不在售后中 409、驳回不写理由 400 |
| POST | `/api/aftersale/evidence` | 售后凭证上传 `{ data(dataURL) }`，真入对象存储（local 落 `data/uploads/`，s3 走桶），返回 `evidence/YYYY/MM/<uuid>.<ext>` 对象键。魔数嗅探只收图片，与买家秀同一套频控 |
| GET  | `/api/ledger/pending?page=&size=` | **运营侧**待打款退款清单（需 `X-Admin-Key`），带全库 summary（待打款笔数与合计） |
| POST | `/api/ledger/refunds/:id/settle` | **运营侧**确认已打款（需 `X-Admin-Key`）：pending → settled，记操作人与时间；重复确认 409 |
| POST | `/api/webhooks/logistics` | **快递回调**（HMAC-SHA256 验签：`X-Carrier` / `X-Timestamp` / `X-Signature`，密钥按渠道配在 `LOGISTICS_WEBHOOK_KEYS`）。时间戳超容差 401 防重放；事件去重靠 `(order_id, code, happened_at)` 唯一索引；签收早于下单/未来时间的坏事件**收下 200 但不落地**（返回 4xx 快递会无限重推）；签收推进 `completed`，时间取快递给的 |
| GET  | `/api/config` | 运营配置（配送方式与运费、支付方式、券返还顺延规则），公开读，未登录的结算页也要用 |
| PUT  | `/api/config` | 改运营配置，需请求头 `X-Admin-Key`（`ADMIN_API_KEY`，留空则 403）；只接受白名单字段并逐项校验范围 |
| GET  | `/api/favorites?userId=` | 收藏列表 |
| POST | `/api/favorites` | 收藏变更 `{ userId, productId, action? }`：`add` / `remove` 显式幂等（前端离线队列重放靠它），缺省 `toggle` 兼容旧调用；返回 `favorited` |
| DELETE | `/api/favorites` | 取消收藏 `?userId=&productId=` |
| POST | `/api/ai/recommend` | 导购推荐 `{ query, limit? }`：检索引擎直出 + 可选 LLM 导购语（`LLM_API_KEY` 配置时），不落会话、永远带商品卡，返回 `{ intro, products, source }` |
| POST | `/api/ai/image-search` | 色彩特征检索 `{ colors: [{h,s,l,weight}] }`：对商品调色板做环形色相最近邻，原图不上传，返回 `{ products, source:'color-feature', matched }` |
| GET  | `/api/coupons/catalog` | 券目录（`couponId / title / kind / threshold / amount / validDays / scopeText`），前端离线时用内置同构目录兜底 |
| PUT  | `/api/coupons/catalog` | 券目录写入 `{ coupon \| coupons, force? }`，需 `X-Admin-Key`；按 id upsert、不删除；改面额/门槛/类型且券有持券人时返回 409，带 `force: true` 才通过 |
| GET  | `/api/coupons?userId=&amount=&all=1` | 卡券包（标注可用性与可省金额）；`all=1` 返回全部状态含已用/已过期，跨设备同步要靠它 |
| POST | `/api/coupons` | 领券 `{ userId, couponId }`，重复领取 409，返回服务端实例（含 `expiresAt`） |
| POST | `/api/coupons/use` | 核销 `{ userId, couponId, orderId }`，幂等（同单重复调用返回 `already:true`） |
| POST | `/api/coupons/refund` | 取消订单返还 `{ userId, orderId }`，退回未使用并顺延有效期（天数/次数取运营配置；订单取消已走 `/api/orders/:id/cancel`，此接口留给无订单的补退场景） |
| GET  | `/api/addresses?userId=` | 收货地址列表（默认地址排首位，含 `province` / `city` / `region` / `postal`） |
| POST | `/api/addresses` | 新增/更新地址 `{ userId, id?, receiver, phone, province, city, detail, postal?, isDefault? }`；带 `id` 即更新，返回 `{ id, created, addresses }` |
| POST | `/api/addresses/:id/default?userId=` | 设为默认（幂等，默认地址始终有且仅有一条） |
| DELETE | `/api/addresses/:id?userId=` | 删除地址（软删除，历史订单仍可追溯）；删掉默认地址后由剩余第一条接任，返回最新清单 |
| POST | `/api/merchant/applications` | 商家入驻申请 `{ entityKind, company, creditCode, contact, phone, brand, brandSource, categories, skuRange, priceRange, bankAccount, bankNo, returnPolicy, shipWithin, submitKey }`。服务端权威校验并返回**字段级** `fields` 错误；幂等（同 `userId + submitKey` 返回既有申请与同一 queryKey）；**银行账号只存前 4 后 4**，完整卡号不落库；限流按 IP 30 次/时 + 已登录用户 6 次/时 |
| GET  | `/api/merchant/applications/:id?key=` | 商家凭「编号 + 查询凭证」自查进度（双要素，缺一或不对统一 404，不给枚举留口子）；返回打码联系方式 + **通知状态**（结果是否已经发到手机/邮箱） |
| GET  | `/api/merchant/applications?status=&page=&size=` | **运营侧**申请列表 + 全库状态计数 + 每条的**通知状态**（需 `X-Admin-Key`，审核工作台的数据源） |
| GET  | `/api/merchant/applications/:id` | 带 `X-Admin-Key` 时返回**运营详情**：申请 + 审核轨迹（`events`）+ 通知队列（`notices`）；不带钥匙则只认「编号 + 查询凭证」 |
| PATCH | `/api/merchant/applications/:id` | **运营侧审核**（需 `X-Admin-Key`）`{ action: approve\|reject, note? }`。**单事务**：改状态 + 写轨迹 + 排通知队列。驳回必须写理由（会原样进入给商家的通知）；终态再审 409（不覆盖别人的结论）；`note` 上限 200 字。操作人自报（`X-Admin-Actor`）+ 钥匙指纹一起留痕 |
| POST | `/api/merchant/notices/flush` | 手动投递一轮通知队列（需 `X-Admin-Key`）：平时由后台 worker 每 45 秒扫一次，这个端点给「刚配好通道想立刻验证」和排障用 |
| GET  | `/api/merchant/notices/stats` | 通知队列计数（待发 / 已发 / 跳过 / 失败）+ 通道就绪状态（需 `X-Admin-Key`） |
| POST | `/api/merchant/applications/:id/revise?key=` | 商家**审核前改资料**（查询凭证鉴权）：只传要改的字段，未知字段 400、值没变 400、非 reviewing 409；银行卡号必须重输完整卡号（打码串不可回填）；改动写轨迹（`revised` 事件 + diff 摘要），revision_count 随之 +1 |
| POST | `/api/merchant/applications/:id/withdraw?key=` | 商家**撤回申请** `{reason?}`：状态置 `withdrawn`（不删除，运营列表可见）、写 `withdrawn` 轨迹、排一条撤回回执通知；重复撤回 / 非 reviewing 409 |
| GET  | `/api/merchant/applications/export?status=` | **批量导出 CSV**（需 `X-Admin-Key`）：UTF-8 BOM、RFC 4180 转义、`=+-@` 开头的单元格前置 `'` 防公式注入、时间转本地时区、完整银行卡号永远不出现在导出里；响应头 `X-Export-Total/Count/Truncated`，单次上限 5000 条且导出动作留痕（操作人 + 密钥指纹） |
| GET  | `/api/merchant/notice-templates` | 通知模板列表：默认值 + 覆盖项合并视图、`customized` 标记、可用变量白名单与长度上限（需 `X-Admin-Key`） |
| PUT  | `/api/merchant/notice-templates/:id` | 保存模板 `{subject?, body?, enabled?}`：变量白名单校验（未知变量 400 并给出可用列表）、正文/主题非空与长度校验、短信超长只警告不阻断 |
| POST | `/api/merchant/notice-templates/:id/reset` | 恢复默认 = 删除覆盖行（返回是否真的删过），需 `X-Admin-Key` |
| POST | `/api/merchant/notice-templates/:id/preview` | 预览渲染 `{body?, subject?, applicationId?, note?}`：不传申请用内置样例，body/subject 可覆盖已保存版本（改完先看再存），不写库 |
| POST | `/api/ai/guide` | AI 导购（SSE）`{ message, userId, stream }` |
| POST | `/api/ai/chat` | 智能客服（SSE）`{ message, userId, conversationId, stream }` |
| POST | `/api/ai/qa` | 商品问答（SSE）`{ query, userId, productId, stream }` |
| POST | `/api/ai/copywrite` | 运营文案 `{ product, sellingPoints, tone, platform, count }` |
| POST | `/api/ai/aftersale` | 订单售后 `{ userId, orderId, query }` |
| POST | `/api/track` | 推荐来源埋点 `{ event, source?, productId?, userId?, meta? }`（202 异步落库） |
| GET  | `/api/track/stats` | 多维聚合 `?productId=&source=`，返回 `{ total, byEvent, bySource, byProduct, recent }` |
| GET  | `/health` · `/ready` | 健康检查 / 依赖探针 |

> 流式响应格式：`data: {"text":"…"}` 逐段 → `data: {"products"/"results"/"conversationId", mode}` 结构化 → `data: [DONE]`。

### 推荐来源埋点（全链路数据闭环）

详情页支持深链 `#/product/:id?from=<渠道>`，进入即**自动上报** `view_product` 事件，并渲染一条按渠道区分颜色的**来源色条**；详情页还会 best-effort 展示「共 N 次浏览，最多来自 X」的渠道分析。顶栏「📊 分析」进入 `#/analytics` 看板，可看全站渠道占比、行为分布、Top 商品与最近事件流。

**事件（全链路 6 类）**

| 事件 | 触发点 | 携带 source |
|------|--------|-------------|
| `view_product` | 进入商品详情页 | 首页 / 列表 / 搜索 / 导购 / 相关推荐 / 分析看板 |
| `search` | 搜索页产出结果 | `search`（meta 带 query + 命中数） |
| `add_to_cart` | 商品卡片 / 详情页加购 | 该商品所在渠道 |
| `guide_recommend_click` | 点击 AI 导购推荐卡 | `guide` |
| `qa_recommend_click` | 点击商品问答推荐卡 | `qa` |
| `share` | 复制分享链接 | 当前详情页来源 |

**渠道与配色**（`SOURCE_META`，前端色条 / 看板 / 归因共用一套）

| 渠道 | 文案 | 色值 |
|------|------|------|
| `home` | 首页精选 | `#2e7d32` |
| `list` | 商品列表 | `#1565c0` |
| `search` | 智能搜索 | `#ef6c00` |
| `guide` | AI 导购推荐 | `#6a1b9a` |
| `rec` | 相关推荐 | `#00838f` |
| `qa` | AI 问答推荐 | `#ad1457` |
| `analytics` | 分析看板 | `#455a64` |

**实现要点**

- **前端**：`web/js/track.js` 为 fire-and-forget 上报（`retries:0`，失败静默，同 `event+source+productId` 2s 内去重）；`web/js/analytics.js` 渲染看板，网关不可达时显示友好空状态而非报错。
- **后端**：`POST /api/track` 返回 `202` 后异步落库——`docker` 模式写 **Elasticsearch**（索引 `<esIndex>_events`，默认 `products_events`，启动时 best-effort 预建 keyword/date 映射模板）；`local` 模式写**内存环形缓冲**（上限 1000，演示用，重启清空）。`GET /api/track/stats` 提供聚合，`docker` 模式走 ES `terms` + `top_hits`，`local` 模式走 JS 聚合。
- **安全**：埋点失败不影响浏览；ES 写入带 2s 超时与 best-effort 容错，绝不阻塞主请求；埋点内容仅含事件名/渠道/商品 ID/匿名 userId，不含密码与令牌。

---

## 买家秀对象存储（预签名 URL）

评价图片不直接暴露存储，走「入库存键、读取现签」：

```
浏览器 ──base64──▶ 网关校验(6MB/文件头/扩展名) ──▶ 对象存储(S3)
                                                    │
浏览器 ◀── <img src=预签名URL> ◀── 评价接口现签 ◀── key(库里只有这个)
```

**为什么库里只存 key 不存 URL**：预签名 URL 有有效期（默认 900s），存下来第二天就是一堆死链。
键形如 `reviews/2026/10/<uuid>.jpg`，每次列表/详情返回时现签一次，有效期由 `MEDIA_URL_TTL_SECONDS` 控制。

### 本地怎么跑（不需要 Docker）

```bash
bash scripts/dev-storage.sh      # 起 S3 兼容替身（SeaweedFS all-in-one，单文件二进制）
                                 # 首次运行自动下载；默认 :8333，开鉴权（匿名访问 403）
```

脚本会把该用的环境变量打印出来，写进 `ai-gateway/.env` 即可（`dev-local.sh` 会自动加载）：

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
S3_BUCKET=review-media
S3_ACCESS_KEY_ID=shopdevaccess
S3_SECRET_ACCESS_KEY=shopdevsecret1234567890
S3_FORCE_PATH_STYLE=1
MEDIA_URL_TTL_SECONDS=900
```

不想接对象存储就不用配：`STORAGE_DRIVER=local`（默认）继续落 `ai-gateway/data/uploads`，
代码路径一致，只是渲染地址从「预签名 URL」变成 `/api/uploads/<uuid>.<ext>`。

### 一键拉起（对象存储 + 前后端）

不想分三步起服务时，用 `WITH_STORAGE=1` 让 `dev-local.sh` 顺便把 S3 替身也拉起来：

```bash
WITH_STORAGE=1 bash scripts/dev-local.sh
```

脚本会：后台启动 SeaweedFS（`scripts/dev-storage.sh`，端口就绪才继续）→ 自动注入
`STORAGE_DRIVER=s3` 与 7 个 `S3_*` 环境变量 → 再启动网关与静态前端；退出时统一回收
（网关、静态服务、S3 替身一起停）。不加 `WITH_STORAGE` 时保持原来的 local 驱动。

### 删除评价与对象回收

删除评价不只删库，还要把该评价（含追评）的图片对象一并回收，否则桶里会越积越多：

```http
DELETE /api/reviews/:id?userId=<本人>
```

- 归属校验：只有 `source=user` 且 `user_id` 匹配才能删，种子数据与别人的评价返回 403/404
- 级联：主评价删除时，DB 层 `ON DELETE CASCADE` 自动清掉追评与「有用」投票
- 统计回滚：删除后重算该商品评分/评价数/好评率（`syncProductStats`），不会留下脏计数
- 对象回收：收集主评价 + 所有追评的图片键，逐键 `DeleteObject`/删本地文件；
  单张失败不影响评价删除本身（best-effort），返回 `imagesRemoved` 反映实际回收数

### 孤儿对象清理

上传成功但最终没发布、或删除后残留的图片，会由后台定时任务清掉：

- **启动时**跑一次；之后每 `STORAGE_SWEEP_INTERVAL_SEC`（默认 1800s，0 关闭）跑一次
- 做法：读出 `reviews.images` 里所有被引用的对象键 → 与存储中 `reviews/` 前缀下的实际对象比对
  - `s3` 驱动：`ListObjectsV2`（同样走 SigV4 签名）列举后比对
  - `local` 驱动：`readdir(data/uploads)` 按 basename 比对
- 只删「没有出现在任何评价里」的对象；清理结果写结构化日志 `storage.sweep_done`，失败只告警不阻断
- 多实例部署时各实例都会扫，删除操作幂等（对象不存在不报错），可安全并发

### 生产接真 S3 / OSS / R2

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com   # OSS: https://oss-cn-hangzhou.aliyuncs.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=0                            # 真 AWS 用 vhost；OSS/R2/MinIO 视情况
```

要点：

- **桶保持私有**，只通过预签名 URL 读；不要在桶上开公共读
- 启动时 `HEAD bucket`，不存在则自动创建（失败只告警，不阻断启动）
- 签名 URL 可缓存到过期为止；接口返回的 `expiresIn` 可用于提前刷新
- 多实例部署必须用 s3：`local` 驱动下各实例只认自己磁盘上的文件
- 换存储不用迁移数据（key 与驱动无关）；历史记录里的 `/api/uploads/...` 仍由本地路由兜底

签名是手写的 SigV4（`ai-gateway/src/storage/s3Client.js`，约 200 行，零依赖），
覆盖 `PutObject / 预签名 GET / DeleteObject / HeadBucket / CreateBucket`；
已验证「过期 URL」与「篡改签名」均返回 403。

## 真实商品数据导入（合规开放数据源）

为了让数据库「更完整、更真实」，项目内置一条**合规的抓取/导入管线**，从明确可商用的开放数据源拉取真实商品、价格与图片——**绝不爬取受 ToS / 版权保护的商业站点**：

- **Free-Ecommerce-Products-Api**（GitHub 开源，开放使用）：含真实商品图（GitHub Pages 图床）与美元标价，覆盖美妆 / 电子 / 服饰 / 家居 / 健康 5 大类。
- **Open Food Facts**（ODbL 开放数据库，CC-BY 商品图）：覆盖「食品生鲜」及合规的非食品类目（美妆个护 / 宠物粮 / 母婴 / 营养补剂），按 `categories_tags` 自动分流到对应一级类目，体量可达数十万款。
- **Open Library**（开放图书元数据，封面为 Open Library 开放图）：覆盖「图书文娱」一级类目，按 subject 分流到二级类目（畅销图书 / 文创手作 / 乐器音像），只保留「有书名 + 有封面图」的真实书目，体量可达数万款。
- **DummyJSON**（公开演示 API，无 ToS 限制）：约 200 件带图合成商品，补齐手机数码 / 服饰鞋包 / 家用电器 / 车载出行等「无开放数据源可爬」的核心品类的空档，统一「海外直邮」叙事（`npm run db:dummyjson`）。
- **克利夫兰艺术博物馆 Open Access**（CC0，免 API Key）：4 万余件开放藏品，取「有图有标题」者映射为「文创手作 / 乐器音像」的艺术复刻商品，图片为博物馆 CDN 直链（`npm run db:cleveland`）。曾尝试 Art Institute of Chicago API，被 Cloudflare 人机校验硬拦后改用本源。

导入后每张商品图存为 `products.image_url`，前端在「图片不可达（离线 / 图床 404）」时**自动回退**到程序化 SVG 封面，绝不出现破图。

```bash
cd ai-gateway

# 1) 先确保基础库（256 款示例 + 表结构，含 image_url 列 v5）
npm run db:seed

# 2) 导入真实商品（默认离线：用 .cache 快照；仓库已内置 Free-Ecommerce 50 款 + OFF 快照）
npm run db:ingest

# 实时抓取最新数据并写入缓存后再导入（需联网；OFF 可能限流，失败自动回退本地快照）
npm run db:ingest -- --fetch

# 快速验证：仅抓 5000 条
npm run db:ingest -- --fetch --limit 5000

# 把库做大：环境变量控制 Open Food Facts 抓取上限（默认 40000，可上不封顶）
OFF_CAP=60000 npm run db:ingest -- --fetch

# 只实时抓取指定家族（避开不可达库，其余从已提交缓存载入，不覆盖既有缓存）
INGEST_FAMILIES=obf,opf npm run db:ingest -- --fetch

# 只实时抓取图书（Open Library），其余从已提交缓存载入
INGEST_FAMILIES=ol npm run db:ingest -- --fetch

# 控制 Open Library 图书抓取上限（默认 25000）
OL_CAP=30000 npm run db:ingest -- --fetch

# DummyJSON 合成商品（补核心品类空档，幂等可重复执行）
npm run db:dummyjson

# 克利夫兰艺术博物馆 CC0 藏品 → 文创手作 / 乐器音像（幂等；CMA_CAP 控制上限，默认 2000）
npm run db:cleveland

# 清空已导入的真实商品后重灌
npm run db:ingest -- --reset
```

要点：

- **幂等**：真实商品以 `fe_` / `off_` / `dj_` / `cma_` 等前缀独立 ID，与示例商品互不覆盖；重复运行安全（先清旧前缀再 `INSERT OR REPLACE` + 事务批量写入，`reviews` 为纯 INSERT 故入库前必先 DELETE 防翻倍）。
- **母婴 / 补剂分流**：主 OFF 库的 `baby-foods / infant-formulas / diapers / baby-wipes` 等标签分流到「母婴玩具」（奶粉辅食 → baby_milk，尿裤湿巾 → baby_care，diaper/nappy 字样按字面识别不依赖 baby 关键词）；`dietary-supplements / vitamins / sports-nutrition` 等标签分流到「健康保健」——`world.openproductfacts.org` 在部分网络下不可达，同名类目从主库取。
- **高吞吐 + 多类目**：Open Food Facts 走 v2 搜索 API 分页抓取、按 `code` 去重、只保留「有商品名 + 有封面图」的真实条目；覆盖食品生鲜及合规非食品类目（美妆个护 / 宠物粮 / 母婴 / 营养补剂），按 `categories_tags` 自动分流到对应一级与二级类目；每个类目**增量落盘**，超时中断可续跑不丢进度。Open Library 另按 subject 翻页抓取真实书目（只留带封面图者），覆盖「图书文娱」一级类目下的畅销图书 / 文创手作 / 乐器音像二级类目。
- **演示包限幅**：数据库可以无限大，但 `web/js/demo-real-data.js` 默认按固定步长抽样至 `DEMO_CAP`（默认 3000）款，保证 GitHub Pages 首屏不被大文件拖慢；且每次导入**全量同步** fe_/off_ 商品（先清后插），重复运行不会产生重复评价。
- **容错**：限流（429/5xx）自动重试退避；断网时 `--fetch` 回退到本地快照；实时抓取与已提交缓存**合并（按 `code` 去重、只增不减）**，主食品库间歇 503 部分失败时也不会回退已抓数据，多次运行可累积增量。
- **避开不可达库**：OFF 未认证搜索每页最多返回约 100 条、深层分页（约第 11 页起）直接 401，故采用「多细分类目 `categories_tags` 浅分页」扩量；若某家族库临时不可达（如主食品库限流 503、商品事实库离线），用 `INGEST_FAMILIES=obf,opf` 只实时抓取在线家族、其余从已提交缓存载入，不拖慢整轮也不覆盖既有缓存。
- **价格**：Free-Ecommerce 为美元，按演示汇率（USD→CNY 7.1）统一为人民币；Open Food Facts 价格稀疏时按品类合理区间生成（明确为演示用途）。
- **图片版权**：均来自开放许可源；Open Food Facts 图片为 CC-BY，使用即视为遵循其署名要求。
- **离线可复现**：导入同时生成 `web/js/demo-real-data.js`，让 GitHub Pages 纯静态演示站也能展示真实商品与图片（网关不可达时回退）。

> 数据源明细与许可证见 [脚本注释](ai-gateway/scripts/ingest-real-data.mjs)。如改用自有商品库，只需替换该脚本里的两个 `map*()` 映射函数即可。

---

## 部署演示站点（GitHub Pages + Actions）

`web/` 是零构建静态站点，已通过 GitHub Actions 自动发布到 GitHub Pages。

**工作流**：[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
（push 到 `main` 即触发，将 `web/` 作为站点根目录上传并部署）。

**首次启用（仓库设置一次性操作）**：

1. 进入仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
2. 推送任意改动到 `main`，Actions 会自动构建并发布。
3. 访问 `https://<user>.github.io/ai-shopping-app/`。

**让演示站点接入真实 AI（可选）**：

- 在能访问的公网/内网启动 `ai-gateway`，并在其 `.env` 设置 `CORS_ORIGINS=https://<user>.github.io`。
- 打开演示站点时追加 `?api=https://<你的网关地址>`，即可让静态前端调用真实后端。

---

---

## 商品视觉（程序化 SVG + 真实图回退）

项目以**程序化 SVG 商品图**为兜底（`web/js/art.js`），同时支持 `products.image_url` **真实商品图**：前端优先展示真实图，加载失败时（离线 / 图床 404）自动回退到 SVG 封面，绝不出现破图。真实图来自合规开放数据源（见下一节），避免爬取受版权保护的商业站点。本地 `local` 模式的示例商品默认走 SVG，导入真实数据后自动带图。

```
商品数据 → coverColor（双色） + categoryId（线稿） + id（光斑微调） → SVG
```

- **双色渐变**：`coverColor` 由类目基准色相加商品级色相偏移生成（±13°），同类目成体系、每款又不同。
- **类目线稿**：16 套简约 line-art（手机 / 笔记本 / 耳机 / 家电 / T恤 / 碗 / 椅子 / 帐篷 / 化妆瓶 / 奶瓶 / 书 / 锅 / 爪印 / 汽车 / 心电图 / 铅笔），白色描边叠在渐变上。
- **零外部请求**：纯 SVG 字符串，GitHub Pages 离线可用；悬浮时整图轻微放大。

同一商品封面永远一致，因为颜色来自数据库字段而非随机数。

---

## 演示模式（前端离线兜底）

为让 GitHub Pages 这类**未连接后端**的纯静态站点也能展示完整店面，前端做了优雅降级：

- 商品列表 / 详情 / 搜索 / 相关推荐：网关不可达时，自动回退到内置示例商品库（`web/js/demo-data.js` 由 `catalog.js` 生成的 256 款示例 + `web/js/demo-real-data.js` 由 `ingest-real-data.mjs` 生成的真实开放数据商品），页面顶部显示「演示模式」提示条。
- 购物车：服务端不可用时回落到 localStorage，恢复连接后自动补传。
- **结算页**：拿不到服务端报价时按**与服务端一致的规则本地估算**（满 ¥99 包邮，否则 ¥10 运费），金额明细与「提交订单」按钮照常渲染，可走完「提交 → 模拟订单 → 购物车清空」的完整闭环，页面注明「本地估算、不产生真实交易」。这样演示站不会卡在「商品有价但看不到合计、也没有下单按钮」的死路上。
- 订单 / 收藏：演示模式下给出明确空状态与重试入口，不会报错堆栈。
- AI 导购 / 客服 / 问答 / 文案 / 售后：演示模式下给出友好提示，引导本地启动网关后体验。
- 分析看板 `#/analytics`：演示模式下用**内置示例统计**兜底（顶部明确标注「示例数据」，不冒充真实埋点）；埋点上报本身静默失败，不影响浏览。
- **未知路由**：渲染 404 兜底页（含首页 / 分类 / 全部商品 / 我的订单 四个入口），不再静默显示首页。
- 接入真实网关后（同源或 `?api=`），自动切换为实时数据，提示条消失。

---

## 本地自检

改完代码想快速确认「没把东西改坏」，按这三步走：

```bash
# 1) 前端模块真实加载（不只是语法解析）
#    能抓到浏览器白屏级错误：重复 import、导入不存在的导出、顶层执行期异常
node scripts/check-web.mjs

# 2) 后端语法
find ai-gateway/src -name '*.js' -exec node --check {} \;

# 3) 网关冒烟（另开终端，起服务后）
cd ai-gateway && npm start
curl -s localhost:8080/health
curl -s "localhost:8080/api/products?category=audio&sort=price_asc&limit=3"
curl -s -N -X POST localhost:8080/api/ai/guide \
  -H 'Content-Type: application/json' \
  -d '{"message":"预算1500的降噪耳机","userId":"demo","stream":true}'
```

> `node --check` 只做语法解析，**看不到**模块链接期错误（例如同名绑定重复 import 会让整个应用入口加载失败、页面白屏）。`check-web.mjs` 用极简 DOM 垫片把 16 个模块逐个 `import()` 一遍，并断言首屏能渲染、404 兜底可用。

真实浏览器验收（playwright-core + 本机 Edge 无头，脚本自己拉起静态站/网关，退出码即结论）：

```bash
node scripts/e2e-coupons.mjs    # 券中心 → 券包 → 结算抵扣 → 核销 → 返还（纯静态）
node scripts/e2e-sync.mjs       # 跨设备同步：两套独立 context 同号登录 + 真网关（券 + 收藏双向收敛/离线补推 + 推荐与图搜端点冒烟）
node scripts/e2e-checkout.mjs   # 交易闭环
node scripts/e2e-search.mjs     # 搜索 / 筛选 / 排序 / URL 往返
node scripts/e2e-pdp.mjs        # 详情页评价与问答
node scripts/e2e-order-tx.mjs   # 下单事务核销 + 取消返还 + 运营配置生效（真网关）
node scripts/e2e-idempotency.mjs # 下单幂等键 + 支付方式配置 + 券目录写入（真网关，独立临时库）
node scripts/e2e-fulfillment.mjs # 付款→发货→签收→售后全链路 + 演示开关（真网关，独立临时库）
node scripts/e2e-aftersale-review.mjs # 售后审核闭环：同意退款/换货 + 驳回 + 鉴权守卫（真网关，独立临时库）
node scripts/e2e-ledger.mjs # 资金流水账本：收款/退款落账、可退额度守卫、打款确认 + 凭证真上传（真网关 + 浏览器）
node scripts/e2e-logistics-webhook.mjs # 快递 webhook：HMAC 验签、防重放、事件去重、签收推进 + 时区口径（真网关）
node scripts/e2e-discovery.mjs # 收藏/最近浏览/AI 导购抽屉/图片搜索：刷新不丢、按用户隔离、演示标识、移动端入口（纯静态）
node scripts/e2e-merchant.mjs # 商家入驻：桌面/移动入口、44px 触控热区、区块齐全、吸底 CTA 避让 AI 浮窗、无横向滚动（纯静态）
node scripts/e2e-merchant-apply.mjs # 入驻申请表单：分步校验拦截、真落库、幂等键、刷新回看、草稿恢复、演示站如实降级（真网关）
node scripts/e2e-merchant-review.mjs # 入驻审核台：钥匙门禁、筛选走路由、通过与驳回、终态 409、轨迹留痕、通知真投递到本地 webhook（真网关 + 独立临时库）
node scripts/e2e-merchant-selfservice.mjs # 商家自助：字段级修订 / 撤回、通知模板校验与预览、CSV 导出（BOM + 公式注入防护），桌面/移动 UI 全链路（真网关 + 独立临时库）
```

> `e2e-sync.mjs` 与 `e2e-order-tx.mjs` 会拉起真网关（其余跑纯静态模式）。`e2e-sync` 验「另一台设备也认账」：
> 领券上云、核销同步、取消后返还顺延、离线领券补推。两个 context 的 localStorage 完全隔离，
> 只共享「同一手机号 → 同一 userId → 同一网关卡包」这一条链路。
>
> `e2e-order-tx.mjs` 验的是「钱与券不会再分家」：下单走 `POST /api/orders` 且**全程没有
> `POST /api/coupons/use`**（核销在服务端事务里）、取消订单服务端事务关单+顺延、
> 改 `PUT /api/config` 后页面运费与实收一起变、下单失败（库存不足/券已用）不落单也不动券。
>
> `e2e-idempotency.mjs` 用 `--db` 独立的临时库（跑完删库），因此可以放心往券目录里写测试券——
> 券目录只做 upsert、不提供删除，跑在开发库上会永久留一张「探针券」在券中心里。
> 它用 `page.route` 掐断第一次下单请求，断言前端**带着同一个幂等键重放**且服务端只有一单。
>
> `e2e-fulfillment.mjs` 验的是「状态真的在动」：付款 → 模拟发货 → 时间线与运单号 → 刷新后仍在
> （服务端持久化，不是前端临时状态）→ 模拟签收 → 申请售后 → 订单变售后中且记录可见 →
> 重复申请被服务端 409 拒绝。它还另起一个 `DEMO_ACTIONS=false` 的网关，断言模拟端点 403
> 而查单 / 售后路径照常——「演示按钮不影响正常用户路径」只有这样才证明得了。
>
> `e2e-aftersale-review.mjs` 验的是「审核真的搬动了订单」：四笔订单各提一条工单，
> 分别走同意退款（入 `refunded` + 金额夹到实付上限）、同意换货（回 `shipped` + 换新运单号 +
> 旧事件保留）、驳回（退回 `completed` + 理由必填）、页面同意（金额默认带出实付）。
> 鉴权那几项刻意直接用 `fetch` 打接口：没钥匙 / 错钥匙都要 401，工单里有地址和电话，
> 匿名可读等于把隐私挂在公网上。
>
> 处理记录那部分验的是「署名是真的、排序是按处理时间」：接口侧与页面侧用**两个不同的中文名**
> （李审核 / 张小满），既证明页面真的把自报的操作人发了出去，也顺便挡住 HTTP 头编码那个坑——
> 名叫 `e2e-ops` 时无论前端有没有编码都能跑通。三次处理之间刻意 `sleep(1100)` 把时间戳错到
> 不同秒：时间戳只精确到秒，三条同秒的工单排序不稳定，那条断言就会时灵时不灵。

---

## 安全与配置

- **密钥不入库**：`.env`、nginx 证书、mall-fork 等均在 `.gitignore`；仓库仅含 `.env.example` 模板。
- **CORS 显式来源**：生产必须列明来源，绝不开放 `*`。
- **网关鉴权**：设置 `AI_GATEWAY_API_KEY` 后，业务接口需携带 `X-API-Key`（nginx 侧注入，覆盖客户端自带头）。
- **限流**：默认每 IP 每分钟 60 次，可按需调整。
- **HTTPS**：反代脚本负责 TLS 终止与证书管理，后端只跑明文（同网络内）。
- **日志**：结构化 JSON 日志携带请求 ID，不记录密码 / 令牌 / 隐私数据。

---

## 许可证

[MIT](LICENSE) © 2026 qqhjw12
