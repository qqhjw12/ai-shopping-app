// 应用入口：装配路由、顶栏交互、AI 助手、购物车。
import { el, updateCartBadge } from './ui.js';
import { renderHome, renderProducts, renderSearch, renderCartDrawer, renderProductDetail, openProductDetail } from './views.js';
import { renderCategories } from './categories.js';
import { renderCheckout } from './checkout.js';
import { renderCart } from './cart.js';
import { renderOrderSuccess } from './orderSuccess.js';
import { renderOrders, renderFavorites } from './account.js';
import { renderAccount, renderOrderDetail } from './accountCenter.js';
import { renderLogin } from './login.js';
import { renderTools } from './tools.js';
import { renderAnalytics } from './analytics.js';
import { initAssistant, setProductDetailHandler } from './assistant.js';
import { createRouter, navigate } from './router.js';
import { getUserId, loadCart, onCartChange } from './state.js';
import { ensureSession } from './auth.js';
import { isProtectedPath, loginTarget } from './guard.js';
import { getCurrentUser, initials, onUserChange } from './user.js';

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
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
});

document.getElementById('cart-btn').addEventListener('click', () => renderCartDrawer());

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
    : path.startsWith('/account') || path.startsWith('/checkout') || path.startsWith('/orders') || path.startsWith('/favorites') || path.startsWith('/login') ? 'account'
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
  window.scrollTo(0, 0);
  if (path === '/' || path === '') renderHome(view);
  else if (path === '/categories') renderCategories(view);
  else if (path === '/login') renderLogin(view, { redirect: query.redirect || '' });
  else if (path === '/account') renderAccount(view, { tab: query.tab || 'orders' });
  else if (path.startsWith('/account/order/')) {
    renderOrderDetail(view, decodeURIComponent(path.slice('/account/order/'.length)));
  }
  else if (path === '/products') {
    const num = (k) => (query[k] == null || query[k] === '' ? undefined : Number(query[k]));
    renderProducts(view, {
      category: query.cat || '',
      sub: query.sub || '',
      brand: query.brand || '',
      sort: query.sort || 'default',
      minPrice: num('min'),
      maxPrice: num('max'),
    });
  }
  else if (path === '/search') renderSearch(view, query.q);
  else if (path.startsWith('/product/')) renderProductDetail(view, decodeURIComponent(path.slice('/product/'.length)), query.from);
  else if (path === '/tools') renderTools(view);
  else if (path.startsWith('/analytics')) renderAnalytics(view);
  else if (path === '/cart') renderCart(view);
  else if (path === '/checkout') renderCheckout(view);
  else if (path.startsWith('/order-success/')) {
    renderOrderSuccess(view, decodeURIComponent(path.slice('/order-success/'.length)));
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
const router = createRouter(dispatch);
router.start();
