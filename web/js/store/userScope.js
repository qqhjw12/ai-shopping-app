// 本地数据的「归属作用域」——收藏、最近浏览都按它分区存放。
//
// 规则：
//   · 已登录 → 用账户 id（`u:<id>`），换账号即换分区，不会串到别人的收藏；
//   · 未登录 → 用持久匿名 id（`l:<id>`，存 localStorage）。
//
// 为什么不复用 state.js 的 getUserId()：那个匿名 id 存在 sessionStorage，
// 关掉标签页就换人。购物车丢了还能重加，收藏夹丢了就是实打实的数据损失，
// 所以这里用 localStorage 的稳定身份；实名优先仍然由登录用户决定。
import { getCurrentUser } from '../user.js';

const LOCAL_UID_KEY = 'maison_local_uid';

/** 持久匿名 id（localStorage 写不进去时退化为跨刷新固定的兜底值） */
export function localUid() {
  try {
    let id = localStorage.getItem(LOCAL_UID_KEY);
    if (!id) {
      id = `l_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(LOCAL_UID_KEY, id);
    }
    return id;
  } catch {
    return 'l_anon';
  }
}

/** 当前作用域标识，用作数据分桶的 key */
export function scopeId() {
  let user = null;
  try {
    user = getCurrentUser();
  } catch {
    user = null;
  }
  if (user && user.id) return `u:${user.id}`;
  return `l:${localUid()}`;
}
