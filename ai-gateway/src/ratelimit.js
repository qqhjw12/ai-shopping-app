// 进程内限流原语：固定窗口计数器 + 并发闸门。零依赖、随进程重启清空。
// 用于上传这类「单请求重、易被刷」的端点；多实例部署应把限流上移到网关/Redis，
// 本模块不承担分布式一致性（README 已注明边界）。

/**
 * 固定窗口限流器。
 * @param {{limit:number, windowMs:number}} opts limit<=0 表示不限制
 * @returns {{
 *   hit:(key:string, now?:number)=>{allowed:boolean, retryAfterSec:number, remaining:number},
 *   sweep:(now?:number)=>number,
 *   size:()=>number
 * }}
 */
export function createFixedWindow({ limit, windowMs }) {
  const buckets = new Map(); // key -> { count, resetAt }
  return {
    hit(key, now = Date.now()) {
      if (!limit || limit <= 0) return { allowed: true, retryAfterSec: 0, remaining: Infinity };
      let b = buckets.get(key);
      if (!b || now > b.resetAt) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > limit) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: 0 };
      }
      return { allowed: true, retryAfterSec: 0, remaining: limit - b.count };
    },
    /** 清掉已过期的桶，避免长期运行内存无限增长 */
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [k, b] of buckets) {
        if (now > b.resetAt) {
          buckets.delete(k);
          removed += 1;
        }
      }
      return removed;
    },
    size: () => buckets.size,
  };
}

/**
 * 并发闸门：限制同时在处理的任务数（防并发大 body 打爆内存）。
 * @param {{max:number}} opts max<=0 表示不限制
 * @returns {{acquire:()=>(()=>void)|null, active:()=>number}}
 */
export function createConcurrencyGate({ max }) {
  let active = 0;
  return {
    /** 取到一个名额返回 release 函数；已满返回 null */
    acquire() {
      if (!max || max <= 0) return () => {};
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active -= 1;
        }
      };
    },
    active: () => active,
  };
}
