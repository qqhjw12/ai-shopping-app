#!/usr/bin/env node
/**
 * mock 商品数据层验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 本步只补商品数据 + 真实计数，不改页面 UI、不换 4 个页面的商品源：
 *   1) 页面上下文 dynamic import products.js：覆盖 / 字段 / 价格 / 子孙查询；
 *   2) 占位图 3:4 data-URI 真能解码（naturalWidth/Height），不破图；
 *   3) 分类页总览计数与 getCategoryProductCount() 真实数据一致；
 *   4) 首页 / 分类 / 甄选 / 搜索四页 UI 零回归、控制台零错误。
 *
 * 用法：node scripts/e2e-products.mjs [--port 4409] [--headed]
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4409'));
const APP = `http://127.0.0.1:${PORT}/index.html`;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: EDGE, headless: !args.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  // 无后端演示站的 /api 404、外部演示图 ERR_CONNECTION_CLOSED 均属已知网络噪音
  if (/Failed to load resource/.test(t)) return;
  consoleErrors.push(t.slice(0, 140));
});

try {
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* ---- 1) 页面上下文真实加载数据层 ---- */
  const info = await page.evaluate(async () => {
    const p = await import('/js/store/products.js');
    const c = await import('/js/store/categoryTree.js');
    const P = p.products;
    const L2 = c.CATEGORY_TREE.flatMap((x) => x.children);
    const perL2 = L2.map((s) => p.getProductsByCategory(s.id).length);
    const perL1 = c.CATEGORY_TREE.map((x) => p.getProductsByCategory(x.id).length);
    const FIELDS = ['id', 'name', 'price', 'originalPrice', 'images', 'categoryId', 'brand',
      'attributes', 'stock', 'sales', 'rating', 'reviewCount', 'createdAt', 'isNew', 'tags'];
    const bands = (id) => p.getProductsByCategory(id).map((x) => x.price);
    return {
      total: P.length,
      uniqueIds: new Set(P.map((x) => x.id)).size,
      minL2: Math.min(...perL2), maxL2: Math.max(...perL2),
      minL1: Math.min(...perL1), maxL1: Math.max(...perL1),
      fieldsOk: P.every((x) => FIELDS.every((f) => f in x)),
      anchorOk: P.every((x) => {
        const n = c.getCategoryById(x.categoryId);
        return n && (n.level === 3 || n.level === 2) && x.name.includes(n.name);
      }),
      priceOk: P.every((x) => x.price > 0 && x.originalPrice > x.price),
      catFood: bands('pet_01'), catMobile: bands('mobile_01'), catPerfume: bands('fragrance_01'),
      l1WithDesc: p.getProductsByCategory('mobile').length,
      l1NoDesc: p.getProductsByCategory('mobile', { includeDescendants: false }).length,
      byId: Boolean(p.getProductById(P[0].id)),
      searchCat: p.searchProducts('猫粮').length,
      searchEmpty: p.searchProducts('').length,
      countsOk: c.CATEGORY_TREE.every((x) => x.productCount === p.getCategoryProductCount(x.id)),
      totalCount: p.getCategoryProductCount(),
      /* 验收复核补强：全树计数 / 25 个一级全覆盖 / 属性语义 / 细分配件价格带 */
      allCountOk: (() => {
        const a = [];
        const w = (ns) => ns.forEach((n) => { a.push(n); w(n.children || []); });
        w(c.CATEGORY_TREE);
        return a.length === 1106 && a.every((n) => n.productCount === p.getCategoryProductCount(n.id));
      })(),
      l1SumOk: c.CATEGORY_TREE.every((x) => p.getProductsByCategory(x.id).length
        === x.children.reduce((s, y) => s + p.getProductsByCategory(y.id).length, 0)),
      accPriceOk: ['mobile_04', 'digital_06', 'music_08', 'bags_08', 'shoes_09', 'sports_02']
        .every((id) => p.getProductsByCategory(id).every((x) => x.price >= 19 && x.price <= 599))
        && p.getProductsByCategory('computer_01').every((x) => x.price >= 2999 && x.price <= 12999),
      groupOk: (() => {
        const MK = {
          apparel: '颜色/尺码', beauty: '规格/香型', food: '规格/口味',
          digital: '规格/颜色', book: '装帧/开本',
        };
        const g = (x) => Object.keys(x.attributes).join('/');
        return c.CATEGORY_TREE.every((x) => {
          const ps = p.getProductsByCategory(x.id);
          return ps.filter((y) => g(y) === MK[p.ATTR_GROUP_BY_L1[x.id]]).length / ps.length >= 0.6;
        }) && P.every((x) => {
          const main = p.ATTR_GROUP_BY_L1[c.getCategoryPath(x.categoryId)[0].id];
          return !(g(x) === '装帧/开本' && (main === 'apparel' || main === 'digital'));
        });
      })(),
      imgPrefix: P.every((x) => /^data:image\/svg\+xml/.test(x.images[0])),
      imgSame: P.every((x) => x.images[0] === p.PLACEHOLDER_IMAGE),
      placeholder: P[0].images[0],
    };
  });

  check(`全站商品 ≥600 且 id 唯一（实际 ${info.total}）`, info.total >= 600 && info.uniqueIds === info.total);
  check(`每个二级 4–8 款（${info.minL2}–${info.maxL2}）`, info.minL2 >= 4 && info.maxL2 <= 8);
  check(`每个一级 30–60 款（${info.minL1}–${info.maxL1}）`, info.minL1 >= 30 && info.maxL1 <= 60);
  check('Product 字段齐全（15 项）', info.fieldsOk);
  check('categoryId 挂二级/三级且商品名含所属分类名（不串类目）', info.anchorOk);
  check('价格合理（price>0、划线价>现价）', info.priceOk);
  check('猫粮 20–300', info.catFood.every((v) => v >= 20 && v <= 300), info.catFood.join(','));
  check('手机 800–8000', info.catMobile.every((v) => v >= 800 && v <= 8000), info.catMobile.join(','));
  check('香水 100–2000', info.catPerfume.every((v) => v >= 100 && v <= 2000), info.catPerfume.join(','));
  check('查一级返回全部子孙商品（含子孙 35 / 不含 0）', info.l1WithDesc === 35 && info.l1NoDesc === 0);
  check('getProductById / searchProducts 可用（搜「猫粮」=5、空词=0）',
    info.byId && info.searchCat === 5 && info.searchEmpty === 0);
  check('getCategoryProductCount 与 25 个一级 productCount 一致', info.countsOk);
  check('全树 1106 个节点计数与真实数据一致（含二级/三级）', info.allCountOk);
  check('25 个一级查询结果 = 各自二级子孙之和', info.l1SumOk);
  check('属性组按一级语义匹配（服饰/数码不得落「装帧/开本」）', info.groupOk);
  check('细分配件 19–599 / 电脑整机 2999–12999（价格不失真）', info.accPriceOk);
  check(`全站计数一致（${info.totalCount} = ${info.total}）`, info.totalCount === info.total);
  check('images 统一 data-URI SVG 占位', info.imgPrefix && info.imgSame);

  /* ---- 2) 占位图真能解码（3:4，不破图） ---- */
  const imgOk = await page.evaluate(async (src) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res(null);
    im.src = src;
  }), info.placeholder);
  check('占位图可解码且比例 3:4（300×400）', Boolean(imgOk) && imgOk.w === 300 && imgOk.h === 400,
    imgOk ? `${imgOk.w}×${imgOk.h}` : 'decode failed');

  /* ---- 3) 分类页总览计数与真实数据一致 ---- */
  await page.goto(`${APP}#/categories`, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const intro = (await page.locator('.intro-count').textContent()) || '';
  const m = intro.match(/收录\s*(\d+)\s*件商品/);
  check('分类页总览读数为真实商品数（非假数字）',
    Boolean(m) && Number(m[1]) === info.totalCount && Number(m[1]) === info.total, intro);
  check('分类页 UI 零回归（16 张类目卡 + 拼图结构）',
    (await page.locator('.cat-card').count()) === 16
    && Boolean(await page.locator('.cat-card .cat-collage').first().count()));

  /* ---- 4) 四页 UI 零回归 + 控制台零错误 ---- */
  for (const [label, hash] of [
    ['首页', '#/'], ['分类页', '#/categories'], ['甄选页', '#/products'],
    ['搜索页', '#/search?q=耳机'],
  ]) {
    await page.goto(`${APP}${hash}`, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    const ok = await page.evaluate(() => Boolean(document.querySelector('#view')?.children.length));
    check(`${label}正常渲染`, ok);
  }
  check('四页控制台零 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  failed += 1;
  console.log(`  FAIL 套件异常: ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ mock 商品数据层验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
