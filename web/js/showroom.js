/**
 * showroom.js —— 虚拟展厅：大厅（#/showroom）+ 分区（#/showroom/:id）。
 *
 * 两个硬约束：
 *   1) 「展厅视图」的景深全部由 CSS transform 完成（perspective + rotateY + translateY + scale），
 *      **不引 Three.js / WebGL**：卡片是平面的，观感是斜的。prefers-reduced-motion 时
 *      由样式表把 transform 与过渡一起收掉（见 styles.css 的 html.reduced-fx 块）。
 *   2) 不自动轮播。横向轨道是原生 overflow-x 滚动 + scroll-snap，用户不动它就不动。
 *      规格明确禁止自动播放：那既是动效噪音，也会在移动端抢走纵向滚动。
 *
 * 商品来源统一走 views.getProducts()（与详情页同一个池），否则卡片点进详情会「商品已下架」。
 */
import { el, emptyEditorial, fmtPrice, productCard, productThumb, toast } from './ui.js';
import { navigate } from './router.js';
import { doAdd, getProducts } from './views.js';
import { SHOWROOM_ZONES, SR_COPY, SR_VIEW, zoneById, zoneHash } from './store/showroomConfig.js';
import { loadView, pickZoneProducts, saveView, zoneCount } from './store/showroomStore.js';
import { zoneArt } from './showroomArt.js';

/* ==================== 懒加载 ==================== */

/**
 * 进入视口才挂载内容：数据是程序化 SVG（零请求），但 DOM 构建与贴图仍需开销。
 * 不支持 IntersectionObserver 的浏览器直接同步挂载（降级 = 立即可见）。
 */
function lazyMount(host, build) {
  if (typeof IntersectionObserver !== 'function') {
    host.appendChild(build());
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      if (!host.isConnected) return;
      host.appendChild(build());
      host.classList.add('is-loaded');
    });
  }, { rootMargin: '240px 0px' });
  io.observe(host);
}

/** 占位骨架：懒加载期间给一块同尺寸的细线框，避免布局跳动 */
function skeleton(cls = '') {
  return el('span', { class: `sr-skeleton ${cls}`.trim(), 'aria-hidden': 'true' });
}

/* ==================== 大厅 ==================== */

/**
 * @param {HTMLElement} view 路由容器
 */
export async function renderShowroomList(view) {
  view.innerHTML = '';
  const pool = await getProductsSafe();

  const head = el('section', { class: 'sr-head' }, [
    el('span', { class: 'eyebrow' }, SR_COPY.eyebrow),
    el('h1', { class: 'sr-title' }, SR_COPY.pageTitle),
    el('p', { class: 'sr-lead' }, SR_COPY.lead),
  ]);

  const grid = el('div', { class: 'sr-zones' });
  SHOWROOM_ZONES.forEach((zone, i) => {
    if (i >= 5) return; // 规格 3–5 个分区，多了首页就是一面墙
    const count = zoneCount(zone, pool);
    const artHost = el('span', { class: 'sr-zone-art-host' }, [skeleton()]);
    const card = el('article', { class: 'sr-zone', style: `--hue:${zone.hue}; --i:${i}` }, [
      artHost,
      el('div', { class: 'sr-zone-body' }, [
        el('div', { class: 'sr-zone-top' }, [
          el('span', { class: 'sr-zone-eyebrow' }, zone.eyebrow),
          el('span', { class: 'sr-zone-count' }, `${count} ${SR_COPY.countUnit}`),
        ]),
        el('h2', { class: 'sr-zone-name' }, zone.name),
        el('p', { class: 'sr-zone-desc' }, zone.desc),
        el('a', {
          class: 'sr-zone-enter',
          href: zoneHash(zone.id),
          'aria-label': SR_COPY.enterZone(zone.name),
        }, [el('span', {}, SR_COPY.enter), el('i', { 'aria-hidden': 'true' }, '→')]),
      ]),
    ]);
    lazyMount(artHost, () => zoneArt(zone, { variant: 'card' }));
    grid.appendChild(card);
  });

  view.appendChild(el('section', { class: 'sr-page sr-list' }, [head, grid]));
}

/* ==================== 分区详情 ==================== */

/**
 * @param {HTMLElement} view
 * @param {string} id 分区 id
 */
export async function renderShowroomDetail(view, id) {
  view.innerHTML = '';
  const zone = zoneById(id);
  if (!zone) {
    view.appendChild(emptyEditorial({
      title: '这个展厅不存在',
      text: '可能是链接里的地址写错了，或者这个分区已经撤展。',
      primaryLabel: '回到展厅大厅',
      onPrimary: () => navigate('#/showroom'),
      secondaryLabel: '浏览全部商品',
      onSecondary: () => navigate('#/products'),
    }));
    return;
  }

  const pool = await getProductsSafe();
  const items = pickZoneProducts(zone, pool);
  let currentView = loadView();

  const heroHost = el('span', { class: 'sr-hero-art-host' }, [skeleton('is-wide')]);
  lazyMount(heroHost, () => zoneArt(zone, { variant: 'hero' }));

  const back = el('a', { class: 'sr-back', href: '#/showroom' }, SR_COPY.backToList);

  const countLabel = el('span', { class: 'sr-meta' },
    `${items.length} ${SR_COPY.countUnit} · ${SR_COPY.demoTag}`);

  const bodyHost = el('div', { class: 'sr-body' });

  const gridBtn = el('button', {
    type: 'button',
    class: 'sr-viewbtn',
    'aria-pressed': 'false',
    onclick: () => switchView(SR_VIEW.GRID),
  }, SR_COPY.viewGrid);

  const hallBtn = el('button', {
    type: 'button',
    class: 'sr-viewbtn',
    'aria-pressed': 'false',
    onclick: () => switchView(SR_VIEW.HALL),
  }, SR_COPY.viewHall);

  const toggle = el('div', { class: 'sr-toggle', role: 'group', 'aria-label': SR_COPY.viewLabel }, [
    gridBtn, hallBtn,
  ]);

  const hint = el('p', { class: 'sr-hint' }, '');

  const header = el('section', { class: 'sr-hero' }, [
    heroHost,
    el('div', { class: 'sr-hero-body' }, [
      back,
      el('div', { class: 'sr-hero-row' }, [
        el('div', {}, [
          el('span', { class: 'sr-zone-eyebrow' }, zone.eyebrow),
          el('h1', { class: 'sr-hero-name' }, zone.name),
          el('p', { class: 'sr-hero-desc' }, zone.floor || zone.desc),
        ]),
        el('div', { class: 'sr-hero-side' }, [countLabel, toggle]),
      ]),
      hint,
    ]),
  ]);

  function paint() {
    bodyHost.innerHTML = '';
    const isHall = currentView === SR_VIEW.HALL;
    gridBtn.setAttribute('aria-pressed', String(!isHall));
    hallBtn.setAttribute('aria-pressed', String(isHall));
    hint.textContent = isHall ? SR_COPY.hallHint : SR_COPY.gridHint;
    bodyHost.className = `sr-body is-${currentView}`;
    if (!items.length) {
      bodyHost.appendChild(emptyEditorial({
        title: SR_COPY.emptyZone,
        text: SR_COPY.emptyZoneHint,
        primaryLabel: '换个分区',
        onPrimary: () => navigate('#/showroom'),
      }));
      return;
    }
    bodyHost.appendChild(isHall ? buildHall(items) : buildGrid(items));
  }

  function switchView(next) {
    if (next === currentView) return;
    currentView = next;
    saveView(next); // 偏好落盘：下次进来还是你上次看的那一种
    paint();
  }

  paint();
  view.appendChild(el('section', { class: 'sr-page sr-detail' }, [header, bodyHost]));
}

/* ---------------- 网格视图：复用全站商品卡 ---------------- */

function buildGrid(items) {
  const grid = el('div', { class: 'sr-grid' });
  items.forEach((p) => {
    grid.appendChild(productCard(p, {
      onDetail: () => navigate(`#/product/${encodeURIComponent(p.id)}`),
      onAddCart: () => doAdd(p, 'showroom'),
      comparable: false,
    }));
  });
  return grid;
}

/* ---------------- 展厅视图：横向大卡 + CSS 景深 ---------------- */

function buildHall(items) {
  const rail = el('div', {
    class: 'sr-rail',
    role: 'list',
    'aria-label': '展品轨道，横向滑动浏览',
  });

  items.forEach((p, i) => {
    // 景深参数：奇偶交替倾斜 + 波浪式抬升，全部交给 CSS 变量，JS 只算数
    const depth = {
      tilt: i % 2 === 0 ? -3.6 : 3,
      lift: (i % 4) * 12,
      scale: (1 - Math.min(0.06, Math.abs(i % 4) * 0.015)).toFixed(3),
    };
    const artHost = el('span', { class: 'sr-hall-art' }, [skeleton()]);
    lazyMount(artHost, () => productThumb(p));

    const card = el('article', {
      class: 'sr-hall-card',
      role: 'listitem',
      style: `--i:${i}; --tilt:${depth.tilt}; --lift:${depth.lift}; --scale:${depth.scale}`,
    }, [
      el('span', { class: 'sr-hall-index', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
      artHost,
      el('div', { class: 'sr-hall-body' }, [
        el('div', { class: 'sr-hall-meta' }, [p.brand || p.category || 'MAISON', Number(p.rating) > 0 ? `★ ${Number(p.rating).toFixed(1)}` : '']),
        el('h3', { class: 'sr-hall-name' }, p.name),
        el('div', { class: 'sr-hall-price' }, [el('b', {}, fmtPrice(p.price))]),
        el('div', { class: 'sr-hall-actions' }, [
          el('button', {
            type: 'button',
            class: 'ghost',
            onclick: () => navigate(`#/product/${encodeURIComponent(p.id)}`),
          }, SR_COPY.detail),
          el('button', {
            type: 'button',
            onclick: () => doAdd(p, 'showroom'),
          }, SR_COPY.addToBag),
        ]),
      ]),
    ]);
    rail.appendChild(card);
  });

  // 轨道尾部留一张「回到大厅」的空位，滑到底不至于戛然而止
  rail.appendChild(el('a', { class: 'sr-rail-end', href: '#/showroom' }, [
    el('span', {}, '还想看看别的分区'),
    el('b', {}, '回到展厅大厅 →'),
  ]));

  return rail;
}

/* ---------------- 取货：失败也要能画出展厅 ---------------- */

async function getProductsSafe() {
  try {
    const list = await getProducts();
    return Array.isArray(list) ? list : [];
  } catch {
    toast('商品目录暂时读不到，展厅先按空白展示', 'warn');
    return [];
  }
}
