// 应用入口：装配路由、顶栏交互、AI 助手、购物车。
import { el, updateCartBadge } from './ui.js';
import { renderHome, renderProducts, renderSearch, renderCartDrawer, renderProductDetail, openProductDetail } from './views.js';
import { renderCategories } from './categories.js';
import { renderCheckout } from './checkout.js';
import { renderCart } from './cart.js';
import { renderOrderSuccess } from './orderSuccess.js';
import { renderOrders, renderFavorites } from './account.js';
import { renderAccount } from './accountCenter.js';
import { renderOrderDetail } from './orderDetail.js';
import { renderCoupons } from './coupons.js';
import { renderLogin } from './login.js';
import { renderTools } from './tools.js';
import { renderAnalytics } from './analytics.js';
import { renderAdminAftersales } from './adminAftersales.js';
import { renderAdminMerchants } from './adminMerchants.js';
import { renderAdminNoticeTemplates } from './adminNoticeTemplates.js';
import { renderMerchantJoin, renderMerchantApply } from './merchant.js';
import { renderMerchantDashboard } from './merchantDashboard.js';
import { initAssistant, setProductDetailHandler } from './assistant.js';
import { askGuide, openImageSearch } from './aiShop.js';
import { favoriteCount, onFavoritesChange } from './store/favoriteStore.js';
import { createRouter, navigate, parseHash } from './router.js';
import { getUserId, loadCart, onCartChange } from './state.js';
import { ensureSession } from './auth.js';
import { isProtectedPath, loginTarget } from './guard.js';
import { getCurrentUser, initials, onUserChange } from './user.js';
import { loadRuntimeConfig } from './store/config.js';

// 仅在显式直连网关（?api=...）时自动建立会话：
// 纯静态演示（GitHub Pages 无后端）跳过，避免每页产生无谓的 404 请求。
if (new URLSearchParams(location.search).get('api')) {
  ensureSession(getUserId()).catch(() => {});
}

// 推荐卡带来源跳转
setProductDetailHandler((p) => openProductDetail(p, 'guide'));

/* ---------------- 购物车：服务端优先，离线回落 ---------------- */
updateCartBadge();
// 购物车变化时刷新角标（加购/删改/服务端合并都会触发）
onCartChange(() => updateCartBadge());
// 拉取服务端购物车（演示模式下静默保持本地数据）
loadCart();

const view = document.getElementById('view');

/* ---------------- 顶栏交互 ---------------- */
/* ---------------- 顶栏搜索 ---------------- */
// 搜索栏是全局唯一入口：提交即进 #/search?q=；当前已在同一结果页时手动重绘一次，
// 否则 hash 没变、hashchange 不触发，用户会以为「点了没反应」。
const searchForm = document.getElementById('search-form');
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
  if (location.hash === target) dispatch(parseHash());
  else navigate(target);
});

/** 搜索栏回填当前关键词：刷新 / 深链 / 前进后退时输入框与结果保持一致 */
function syncSearchInput(query) {
  const input = document.getElementById('search-input');
  if (input) input.value = query || '';
}

document.getElementById('cart-btn').addEventListener('click', () => renderCartDrawer());

/* ---------------- 顶栏：图片搜索 / AI 导购 ---------------- */
// 搜索栏旁的两个入口：相机 → 图片搜索（演示占位），星标 → AI 导购抽屉。
// 已输入关键词时把词带进抽屉，省一次重复输入。
document.getElementById('img-search-btn').addEventListener('click', () => openImageSearch());
document.getElementById('ai-guide-btn').addEventListener('click', () => {
  const input = document.getElementById('search-input');
  askGuide(input ? input.value.trim() : '');
});

/* ---------------- 顶栏收藏入口 ---------------- */
// 角标跟随收藏条数：0 时隐藏，避免空着挂一个 0 显得像坏数据。
function paintFavBadge() {
  const badge = document.getElementById('fav-count');
  if (!badge) return;
  const n = favoriteCount();
  badge.textContent = String(n);
  badge.classList.toggle('is-empty', n === 0);
}
paintFavBadge();
onFavoritesChange(paintFavBadge);

/* ---------------- 顶栏账户入口 ---------------- */
// 未登录显示「登录」，登录后显示头像字 + 昵称首字；登录态变化时自动重绘。
function paintAccountEntry() {
  const slot = document.getElementById('account-slot');
  if (!slot) return;
  const user = getCurrentUser();
  slot.innerHTML = '';
  slot.appendChild(el('a', {
    class: `account-entry${user ? ' is-in' : ''}`,
    href: user ? '#/account' : '#/login',
    'aria-label': user ? '进入个人中心' : '登录',
    title: user ? '个人中心' : '登录 / 注册',
  }, [
    el('span', { class: 'account-entry-avatar', 'aria-hidden': 'true' }, user ? initials(user) : '·'),
    el('span', { class: 'account-entry-word' }, user ? '我的' : '登录'),
  ]));
}

paintAccountEntry();
onUserChange((user) => {
  paintAccountEntry();
  // 登录 / 换号后购物车归属变了，重新拉一次服务端购物袋（离线时静默保持本地）
  if (user) loadCart();
});

/* ---------------- 路由分发 ---------------- */
function setActiveNav(path) {
  const key = path === '/' ? 'home'
    : path.startsWith('/categories') ? 'categories'
    : path.startsWith('/products') || path.startsWith('/search') || path.startsWith('/product/') ? 'products'
    : path.startsWith('/analytics') ? 'analytics'
    : path.startsWith('/tools') ? 'tools'
    : path.startsWith('/merchant') ? 'merchant'
    : path.startsWith('/account') || path.startsWith('/coupons') || path.startsWith('/checkout') || path.startsWith('/orders') || path.startsWith('/favorites') || path.startsWith('/login') ? 'account'
    : '';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function dispatch({ path, query }) {
  // 路由守卫：受保护页面未登录 → 登录页，并把原始 hash（含查询串）塞进 redirect
  if (isProtectedPath(path) && !getCurrentUser()) {
    setActiveNav(path);
    navigate(loginTarget(location.hash.slice(1) || path));
    return;
  }
  setActiveNav(path);
  // 招商页有吸底 CTA：给 body 挂标记，把 AI 浮窗抬到它上面，避免两个按钮叠在一起
  document.body.classList.toggle('has-merchant-bar', path === '/merchant/join');
  // 工作台在移动端有底部标签栏：让 AI 浮窗抬上去，别和导航叠在一起
  document.body.classList.toggle('has-dash-bar', path === '/merchant/dashboard');
  window.scrollTo(0, 0);
  syncSearchInput(path === '/search' ? query.q : '');
  if (path === '/' || path === '') renderHome(view);
  else if (path === '/categories') renderCategories(view, query);
  else if (path === '/login') renderLogin(view, { redirect: query.redirect || '' });
  else if (path === '/account') renderAccount(view, { tab: query.tab || 'orders' });
  else if (path === '/coupons') renderCoupons(view);
  else if (path.startsWith('/account/order/')) {
    renderOrderDetail(view, decodeURIComponent(path.slice('/account/order/'.length)));
  }
  else if (path === '/products') renderProducts(view, query);
  else if (path === '/search') renderSearch(view, query);
  else if (path.startsWith('/product/')) renderProductDetail(view, decodeURIComponent(path.slice('/product/'.length)), query.from);
  else if (path === '/tools') renderTools(view);
  else if (path.startsWith('/analytics')) renderAnalytics(view);
  else if (path === '/cart') renderCart(view);
  else if (path === '/checkout') renderCheckout(view);
  else if (path.startsWith('/order-success/')) {
    renderOrderSuccess(view, decodeURIComponent(path.slice('/order-success/'.length)));
  }
  // 运营侧：不进登录守卫（运营不是买家），门禁在页面内部用管理密钥
  else if (path === '/admin/aftersales') renderAdminAftersales(view, query);
  else if (path === '/admin/merchants') renderAdminMerchants(view, query);
  else if (path === '/admin/notice-templates') renderAdminNoticeTemplates(view, query);
  // 商家侧：招商不需要登录（让商家先进门）；申请页带 ?id&key 时是回看已提交的申请
  else if (path === '/merchant/join') renderMerchantJoin(view);
  else if (path === '/merchant/apply') renderMerchantApply(view, query);
  // 商家工作台：上一版只有概览页（/merchant/workspace），旧链接一律转到新工作台，
  // query（含 id/key/tab）原样带过去，收藏的链接不会因为改路由而失效
  else if (path === '/merchant/workspace' || path === '/merchant/dashboard') {
    if (path === '/merchant/workspace') {
      const q = new URLSearchParams(query).toString();
      navigate(`/merchant/dashboard${q ? `?${q}` : ''}`);
    } else {
      renderMerchantDashboard(view, query);
    }
  }
  else if (path === '/orders') renderOrders(view);
  else if (path === '/favorites') renderFavorites(view);
  else renderNotFound(view);
}

/* ---------------- 404：未知路由兜底 ---------------- */
export function renderNotFound(v) {
  v.innerHTML = '';
  v.appendChild(
    el('div', { class: 'notfound' }, [
      el('span', { class: 'eyebrow' }, 'PAGE NOT FOUND'),
      el('div', { class: 'nf-code' }, '404'),
      el('h2', {}, '这一页，暂时离席'),
      el('p', {}, '可能是链接过期，或它已被移到别处。不妨从下面重新开始。'),
      el('div', { class: 'nf-actions' }, [
        el('a', { class: 'nf-btn', href: '#/' }, '回到首页'),
        el('a', { class: 'nf-btn ghost', href: '#/categories' }, '浏览分类'),
        el('a', { class: 'nf-btn ghost', href: '#/products' }, '全部甄选'),
        el('a', { class: 'nf-btn ghost', href: '#/orders' }, '我的订单'),
      ]),
    ]),
  );
}

/* ---------------- 启动 ---------------- */
initAssistant();
// 运营配置（运费/配送/券规则）先拉一次：不阻塞首屏（缓存里已有上次的值），
// 拉到新值会通知订阅者（结算页据此重绘运费），其余页面下一次渲染自然用新值。
loadRuntimeConfig().catch(() => {});
const router = createRouter(dispatch);
router.start();
