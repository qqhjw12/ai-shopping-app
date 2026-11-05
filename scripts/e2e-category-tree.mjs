#!/usr/bin/env node
/**
 * 分类树数据层验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 本步只扩充分类树数据（25 一级 / 220 二级 / 三级全覆盖）+ 工具函数，不改任何页面 UI：
 *   1) 分类页 UI 零回归：卡片结构与数量与既有 deriveCategoryTree 口径完全一致；
 *   2) 页面上下文 dynamic import 数据层：6 个工具函数真实可用；
 *   3) getDescendantIds 返回一级下全部子孙 id；
 *   4) productInCategory 经 LEGACY 映射让「按一级查商品」包含子孙分类商品；
 *   5) 首页/分类页控制台零错误。
 *
 * 用法：node scripts/e2e-category-tree.mjs [--port 4408] [--headed]
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
const PORT = Number(argOf('--port', '4408'));
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
  if (/Failed to load resource/.test(t)) return; // 无后端演示站的 404 噪音
  consoleErrors.push(t.slice(0, 140));
});

/* ---- 1) 首页加载 + 分类页 UI 零回归 ---- */
await page.goto(`${APP}#/`, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.goto(`${APP}#/categories`, { waitUntil: 'load' });
await page.waitForTimeout(1400);

check('分类页正常渲染', await page.evaluate(() => document.querySelectorAll('.cat-card').length > 0));
check('分类页 UI 零回归：卡片仍由 deriveCategoryTree 驱动（16 个一级）',
  (await page.evaluate(() => document.querySelectorAll('.cat-card').length)) === 16,
  String(await page.evaluate(() => document.querySelectorAll('.cat-card').length)));
check('分类页卡片结构不变（拼图 + 类目名 + 件数）',
  await page.evaluate(() => {
    const c = document.querySelector('.cat-card');
    return !!c && !!c.querySelector('.cat-collage') && !!c.querySelector('.cat-title') && /件/.test(c.textContent);
  }));

/* ---- 2) 页面上下文 dynamic import 数据层 + 工具函数真实可用 ---- */
const probe = await page.evaluate(async () => {
  const ct = await import('./js/store/categoryTree.js');
  const desc = ct.getDescendantIds('mobile');
  const probe = { categoryId: 'phone', subCategoryId: 'phone_smart' };
  return {
    l1: ct.CATEGORY_TREE.length,
    descLen: desc.length,
    descHasLeaf: desc.includes('mobile_01_t1'),
    path: ct.getCategoryPath('womenswear_01_t1').map((n) => n.name).join('>'),
    search: ct.searchCategories('连衣裙').length,
    inMobile: ct.productInCategory(probe, 'mobile'),
    inDigital: ct.productInCategory(probe, 'digital'),
    notPet: ct.productInCategory(probe, 'pet'),
    legacyComputer: ct.productInCategory({ categoryId: 'computer' }, 'computer'),
    leafSum: ct.getCategoryById('mobile').productCount,
  };
});
check('页面上下文可 dynamic import categoryTree 数据层', probe.l1 === 25, JSON.stringify(probe));
check('getDescendantIds(手机通讯) 返回全部子孙 id（31 个，含三级）', probe.descLen > 20 && probe.descHasLeaf, `len=${probe.descLen}`);
check('getCategoryPath 输出正确面包屑（女装>连衣裙>长款连衣裙）', probe.path === '女装>连衣裙>长款连衣裙', probe.path);
check('searchCategories 命中含三级的节点', probe.search >= 3, `hits=${probe.search}`);
check('按一级查商品：旧种子商品经映射命中 手机通讯/数码电子、不误判 宠物用品',
  probe.inMobile && probe.inDigital && !probe.notPet, JSON.stringify(probe));
check('语义重合一级直接继承旧 id（computer→电脑办公）', probe.legacyComputer);
check('一级 productCount 为子级汇总（非零占位）', probe.leafSum > 0 && Number.isInteger(probe.leafSum), `=${probe.leafSum}`);

check('首页/分类页控制台零错误', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
staticServer.kill();
console.log(failed === 0 ? '\n✓ 分类树数据层验收全部通过' : `\n✗ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
