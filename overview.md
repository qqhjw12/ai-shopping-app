# 虚拟展厅 + AR 试穿/试妆 — 交付总览

> **本步范围**：新增「虚拟展厅」（`#/showroom`、`#/showroom/:id`，网格/展厅双视图）与
> 「AR 试穿/试妆演示态」（分类门控入口 → 桌面提示 / 移动全屏演示层 → 静态示意降级）。
> **明确不动**：拼团（`groupBuy*.js` / `wishlist*.js`）、商品对比（`compare.js` / `outfit.js`）、
> AI 盲盒（`blindbox.js`）——源码零改动，两侧都有断言守着。
> **设计语言**：沿用 Deep Space Command 深空令牌，未引入任何新色系、未引入任何 3D/AR 库。

---

## 一、架构决策

| # | 决策 | 一句话理由 |
|---|---|---|
| 1 | 「AR 预览」与「AR 试穿」是**两个入口**：前者（上一步交付）看空间摆放、全类目可用；后者穿在身上/脸上，只对服饰/鞋靴/美妆/珠宝/钟表/眼镜出现 | 合并成一个按钮会让买手机的人看到「试穿手机」；分开后旧功能与旧断言都不动 |
| 2 | 分区氛围图**程序化 SVG 现画**（`showroomArt.js`），不引外链摄影图 | 这站商品图本来就是确定性 SVG；外链大图在离线/图床抖动时一片破图 + 控制台报错，前几轮踩过 |
| 3 | 展厅景深 = `perspective + rotateY + translateY + scale` 的**纯 CSS transform**，无 WebGL | 「3D 感」不需要 3D 库；`prefers-reduced-motion` 时整块 transform 一起收掉 |
| 4 | 懒加载是**真懒**：`IntersectionObserver`（rootMargin 240px）进视口才构建贴图，骨架占位防跳动 | 商品图是 data-URI SVG 虽零请求，但 DOM 构建本身有开销；换成真图床时同一套机制直接生效 |
| 5 | 类目门控 = **一级类目映射 + 关键词兜底**（`tryOnConfig.js`） | 商品池（16 老类目）与分类树（25 新类目）并存，写死任一套都会漏；「钟表眼镜」合并一级必须按关键词二次分叉，否则太阳镜会拿到「AR 试戴手表」 |
| 6 | AR 演示层 `arTryOn.js` **只在点击入口后动态 import**；桌面端连 import 都不发生 | 规格硬性要求首屏零 AR 请求；e2e 在网络面板上盯这一条 |
| 7 | 摄像头**默认不申请**：演示层用 CSS 模拟画面，「启用摄像头背景」需用户主动点击并授权，被拒/无设备静默回落 | 进页面就弹权限框是最快流失方式；拒绝授权必须优雅降级，不能看起来像 bug |
| 8 | 展厅**不自动轮播**：横向轨道是原生 `overflow-x + scroll-snap`，JS 里没有任何定时器与程序化滚动 | 规格明确禁止；也让 reduced-motion 语义天然成立 |
| 9 | 视图偏好（网格/展厅）按 `scopeId()` 分桶存 localStorage，脏值收敛到网格 | 换账号不串视野；localStorage 损坏不能白屏，回落默认视图即可 |

## 二、文件清单

### 新增（7 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/js/store/showroomConfig.js` | 116 | 5 个主题分区（类目映射/色调/文案）、视图模式与偏好键、`zoneById/zoneHash` |
| `web/js/store/showroomStore.js` | 74 | 按 categoryId 取货（销量降序确定性）、上限、视图偏好按 scope 读写 |
| `web/js/showroomArt.js` | 148 | 宽幅氛围图 SVG（渐变/地平线/展台/巨型编号），确定性、零外链 |
| `web/js/showroom.js` | 297 | 大厅 + 分区详情：双视图切换、懒加载、加购/进详情、空分区兜底 |
| `web/js/store/tryOnConfig.js` | 158 | 六类门控（类目映射 + 关键词规则）、文案、截图尺寸、色名词表、贴图落点 |
| `web/js/pdpTryOn.js` | 87 | 入口按钮（不支持的类目返回 null）、桌面提示、能力检测、动态 import |
| `web/js/arTryOn.js` | 380 | 全屏演示层：模拟画面/真实背景、拖动贴图、SKU 换色、canvas 截图、mock 分享 |

### 改动（5 个）

| 文件 | 改动 |
|---|---|
| `web/js/app.js` | +2 import、`#/showroom` 两条路由、`/showroom` 归入 products 导航桶 |
| `web/js/views.js` | +1 import、`.pdp-secondary-actions` 里插 `tryOnButton(p, 'ghost')`（其他类目为 null 不占位） |
| `web/index.html` | 页脚「探索」列加 `<a href="#/showroom">虚拟展厅</a>` |
| `web/styles.css` | +约 500 行 `.sr-*` / `.try-*`（含移动端与两套 reduced-motion 块） |
| `scripts/check-web.mjs` | 新增「虚拟展厅与 AR 试穿」断言块 14 条 |

## 三、关键代码

**1) 分类门控的核心——「钟表眼镜」合并一级必须二次分叉：**

```js
export function tryOnKindOf(product) {
  const cat = String(product.categoryId || '');
  const base = TRYON_CATEGORY_KIND[cat] || null;      // 两套类目 id 的映射表
  const hay = [product.subCategory, product.subCategoryId, product.category,
    product.name, (product.tags || []).join(' ')].filter(Boolean).join(' ');
  const hit = TRYON_RULES.find(([re]) => re.test(hay));
  const byKeyword = hit ? hit[1] : null;
  if (base === 'watch') {                              // watches 一级 = 钟表 + 眼镜
    if (byKeyword === 'glasses') return TRYON_KIND.GLASSES;
    return TRYON_KIND.WATCH;
  }
  if (base === 'apparel' && byKeyword === 'shoes') return TRYON_KIND.SHOES; // 老池「服饰鞋包」里混着鞋
  return base || byKeyword;
}
```

**2) 首屏零 AR 请求——只有入口在首屏，演示层在点击后：**

```js
// pdpTryOn.js（随首屏加载，但自己绝不 import arTryOn.js）
if (!isCoarsePointer()) { openModal(...桌面提示...); return; }   // 桌面连 import 都不发生
const mode = cameraSupported() ? 'camera' : 'static';           // 无 getUserMedia → 静态示意
const { mountTryOn } = await import('./arTryOn.js');            // 此刻才请求演示层
mountTryOn({ product, kind, mode });
```

**3) 展厅视图的景深全部是平面变换（无 3D 库）：**

```css
.sr-rail { perspective: 1400px; scroll-snap-type: x proximity; }
.sr-hall-card {
  transform: translateY(calc(var(--lift) * 1px)) rotateY(calc(var(--tilt) * 1deg)) scale(var(--scale));
  transition: transform 320ms var(--ease), box-shadow 320ms var(--ease);
}
html.reduced-fx .sr-hall-card { transform: none; transition: none; }
```

**4) 懒加载：进视口才挂载，节点被路由摘掉就放弃：**

```js
const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    io.unobserve(entry.target);
    if (!host.isConnected) return;          // 路由已切走：不再构建
    host.appendChild(build());
    host.classList.add('is-loaded');
  });
}, { rootMargin: '240px 0px' });
```

**5) SKU 换色：色名词表优先，哈希只做兜底**（「黑 / M」不该泛绿光）：

```js
export const TRYON_COLOR_WORDS = [
  [/米白|燕麦|奶油|象牙|cream|ivory|oat/i, 'hsl(38 46% 84% / 0.5)'],
  /* …14 组… */
  [/黑|black/i, 'hsl(220 10% 10% / 0.6)'],
];
export function tryOnTintOf(spec) {
  const hit = TRYON_COLOR_WORDS.find(([re]) => re.test(String(spec)));
  return hit ? hit[1] : `hsl(${tryOnHueOf(spec)} 62% 58% / 0.34)`;
}
```

## 四、访问路径

| 路径 | 内容 |
|---|---|
| `#/showroom` | 展厅大厅：5 张大幅氛围图分区卡（春日衣橱 17 件 / 数码前线 49 件 / 香氛实验室 492 件 / 静境家居 32 件 / 雪线装备 32 件） |
| `#/showroom/spring-wardrobe` 等 | 分区详情：网格 ↔ 展厅切换，展厅视图横向大卡 + CSS 景深，卡上加购/进详情 |
| `#/product/p065`（服饰） | 详情页次要操作区「AR 试穿」；桌面点击 → 提示弹层（零脚本加载） |
| `#/product/p135`（美妆） | 入口文案为「AR 试妆」 |
| `#/product/p001`（手机） | 无 AR 试穿入口（门控生效） |
| 移动端 PDP → AR 试穿 | 全屏演示层：模拟摄像头画面 + 商品贴图（可拖动）+ SKU 换色 + 截图/分享/退出 +「启用摄像头背景」（授权后才用真背景） |
| 页脚「探索 → 虚拟展厅」 | 全站入口 |

## 五、验收自检（对照规格第五节）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 展厅列表和详情可访问，商品可加购/看详情 | ✅ | e2e 1–3 节：5 分区卡、进详情、`shop_cart` 0→1、跳 `#/product/:id` |
| 展厅/网格视图可切换 | ✅ | `aria-pressed` 互斥切换；**刷新后偏好保留**（scope 分桶落盘） |
| 服饰美妆等分类有 AR 入口，桌面与移动端都有明确降级提示 | ✅ | 桌面：`请在移动设备上体验 AR 试穿`；移动无摄像头：`静态试穿示意`；拒绝授权：`摄像头未授权，已切回模拟画面` |
| AR 演示层可切换 SKU、可关闭 | ✅ | 规格读数变化 + 选中态转移 + 贴图换色（色名词表）；`×`/Esc/退出按钮三种关法，关闭后解锁 `no-scroll` |
| 首屏无 AR 相关脚本请求 | ✅ | e2e 在桌面与移动两个网络面板断言 `arTryOn.js` 请求数为 0，点击后才出现 |
| 控制台无错误 | ✅ | 四个页面 context 全程零 console error / pageerror |

规格第三节逐条：氛围图与商品贴图懒加载 ✅（IO + 骨架）；3D 感只用 CSS transform ✅（e2e 断言轨道 `perspective` 有值且无 three/glb 请求）；不支持/拒绝摄像头优雅降级不报错 ✅（两条独立 e2e 路径）；`prefers-reduced-motion` 关闭景深动效 ✅（`@media` 与 `html.reduced-fx` 双保险 + 断言）。

规格第四节逐条：首屏零 AR 脚本 ✅；无人脸识别（不调任何模型，真背景仅当背景、不上传）✅；无自动轮播 ✅（JS 零定时器、零程序化滚动，断言守着）；AR 不是假按钮——演示层全功能可用 ✅。

## 六、验证与回归

- `check-web.mjs`：83 → **90 模块**（+7）全绿；新增 14 条断言块（分区配置/取货确定性/视图偏好隔离/六类门控含钟表眼镜分叉/文案分型/能力探测/色名词表/氛围图确定性/懒加载与禁轮播/动态 import 唯一性/演示层纪律/接线/样式纪律/零互引）。
- `e2e-showroom-ar.mjs`：**57/57** 通过（列表→详情→双视图→懒加载→偏好持久→加购→门控→桌面降级→移动演示层→SKU 换色→截图/分享→关闭→无摄像头降级→拒绝授权降级→移动端展厅→拼团对比不回归）。
- 全量回归：34 套 e2e（含本地网关 `127.0.0.1:8080` 起来后跑的网关侧套件），结果见交付消息。
- 断言脚本自身两处首轮错误已修：`zoneArtSvg` 含 `xmlns="http://www.w3.org/2000/svg"` 导致「无外链」断言误报（改为放行 w3.org 命名空间）；导航归桶正则漏写一个 `'`。

## 七、已知限制

1. 演示层的「摄像头画面」默认是 CSS 模拟；真实摄像头只在用户点「启用摄像头背景」并授权后作为背景使用，帧不上传、不做任何识别——所以没有人体/人脸追踪，贴图位置要手动拖。
2. 试穿截图是 canvas 合成的占位图（底色 + 网格 + 商品线稿 + 规格），不是真实 AR 合成。
3. 当前演示商品池没有珠宝/钟表/眼镜类目，这三类的入口在真实目录里不会出现——门控逻辑本身由纯函数断言覆盖（含太阳镜→试戴的二次分叉）。
4. 分区 ↔ 类目映射写在 `showroomConfig.js` 配置表里，运营加分区要改配置文件（这是刻意的：分区是内容运营决策，不该藏在视图里）。
5. 展厅视图偏好只存本机 localStorage（跨设备不同步，与全站其他偏好一致）。
6. 展厅商品图是程序化 SVG 封面；接真实图床后 `productThumb` 已自带 `loading="lazy"` 与破图兜底，无需改展厅代码。

## 八、闸门快照

| 项 | 值 |
|---|---|
| 构建 | `node scripts/check-web.mjs` → 90 模块全绿，含 14 条新断言 |
| 新 e2e | `node scripts/e2e-showroom-ar.mjs` → 57/57 |
| 全量回归 | 34 套，详见交付消息 |
| 提交 | `<commit>`（交付消息更新），`main == origin/main` |
| 首屏请求 | 桌面/移动 PDP 与展厅首屏均无 `arTryOn.js` / three / model-viewer / glb |
| 控制台 | 全部页面 context 零 JS 错误 |
