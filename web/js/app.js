// 应用入口：装配路由、顶栏交互、AI 助手、购物车。
import { updateCartBadge } from './ui.js';
import { renderHome, renderProducts, renderSearch, renderCartDrawer, renderProductDetail, openProductDetail } from './views.js';
import { renderTools } from './tools.js';
import { initAssistant, setProductDetailHandler } from './assistant.js';
import { createRouter, navigate } from './router.js';

const view = document.getElementById('view');

// 商品详情由助手内的推荐卡片触发（跳转至路由页，支持深链 + 来源埋点）
setProductDetailHandler((p) => openProductDetail(p, 'guide'));
// 购物车角标初始刷新
updateCartBadge();

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
    : path.startsWith('/products') || path.startsWith('/search') || path.startsWith('/product/') ? 'products'
    : path.startsWith('/tools') ? 'tools'
    : '';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function dispatch({ path, query }) {
  setActiveNav(path);
  window.scrollTo(0, 0);
  if (path === '/' || path === '') renderHome(view);
  else if (path === '/products') renderProducts(view, { category: query.cat });
  else if (path === '/search') renderSearch(view, query.q);
  else if (path.startsWith('/product/')) renderProductDetail(view, decodeURIComponent(path.slice('/product/'.length)), query.from);
  else if (path === '/tools') renderTools(view);
  else renderHome(view);
}

/* ---------------- 启动 ---------------- */
initAssistant();
const router = createRouter(dispatch);
router.start();
