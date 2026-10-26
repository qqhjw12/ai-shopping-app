// 应用入口：装配路由、顶栏交互、AI 助手、购物车。
import { el, updateCartBadge } from './ui.js';
import { renderHome, renderProducts, renderSearch, renderCartDrawer, renderProductDetail, openProductDetail } from './views.js';
import { renderCategories } from './categories.js';
import { renderCheckout } from './checkout.js';
import { renderOrders, renderFavorites } from './account.js';
import { renderTools } from './tools.js';
import { renderAnalytics } from './analytics.js';
import { initAssistant, setProductDetailHandler } from './assistant.js';
import { createRouter, navigate } from './router.js';
import { getUserId, loadCart, onCartChange } from './state.js';

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

/* ---------------- 路由分发 ---------------- */
function setActiveNav(path) {
  const key = path === '/' ? 'home'
    : path.startsWith('/categories') ? 'categories'
    : path.startsWith('/products') || path.startsWith('/search') || path.startsWith('/product/') ? 'products'
    : path.startsWith('/analytics') ? 'analytics'
    : path.startsWith('/tools') ? 'tools'
    : path.startsWith('/checkout') || path.startsWith('/orders') || path.startsWith('/favorites') ? 'account'
    : '';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function dispatch({ path, query }) {
  setActiveNav(path);
  window.scrollTo(0, 0);
  if (path === '/' || path === '') renderHome(view);
  else if (path === '/categories') renderCategories(view);
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
  else if (path === '/checkout') renderCheckout(view);
  else if (path === '/orders') renderOrders(view);
  else if (path === '/favorites') renderFavorites(view);
  else renderNotFound(view);
}

/* ---------------- 404：未知路由兜底 ---------------- */
export function renderNotFound(v) {
  v.innerHTML = '';
  v.appendChild(
    el('div', { class: 'notfound' }, [
      el('div', { class: 'nf-code' }, '404'),
      el('h2', {}, '这个页面走丢了'),
      el('p', {}, '可能是链接过期，或者该页面已经搬走了。试试下面几个入口 👇'),
      el('div', { class: 'nf-actions' }, [
        el('a', { class: 'nf-btn', href: '#/' }, '回首页'),
        el('a', { class: 'nf-btn ghost', href: '#/categories' }, '逛分类'),
        el('a', { class: 'nf-btn ghost', href: '#/products' }, '全部商品'),
        el('a', { class: 'nf-btn ghost', href: '#/orders' }, '我的订单'),
      ]),
    ]),
  );
}

/* ---------------- 启动 ---------------- */
initAssistant();
const router = createRouter(dispatch);
router.start();
