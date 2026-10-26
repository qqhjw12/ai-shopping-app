// 极简 hash 路由：解析 #/path?query，change 时回调。

export function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, queryStr] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  return { path: path || '/', query };
}

export function navigate(path) {
  location.hash = path;
}

export function createRouter(onRoute) {
  const handle = () => onRoute(parseHash());
  window.addEventListener('hashchange', handle);
  return { start: handle };
}
