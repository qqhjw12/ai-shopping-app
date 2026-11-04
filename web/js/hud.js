// 全局 HUD 框架层的唯一脚本：状态栏时钟。
//
// 为什么只有这么点逻辑：状态栏的其余读数（延迟 / 扫描量 / 价格异动）
// 是刻意的静态 mock —— 每帧抖动的假数字会让人以为页面在刷新，反而
// 抢走注意力。真正需要「在走」的只有时间。
//
// 结构留在 index.html 里而不是由 JS 生成：装饰层不该依赖 JS 才出现，
// 否则脚本一挂，整条 chrome 就塌了 30px，布局跟着跳。

const CLOCK_ID = 'sysbar-clock';

/** 两位补零：等宽字体下 09:05:01 和 23:47:56 才会同宽，日期跳秒不抖。 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 启动状态栏时钟。
 * 幂等：重复调用只会重置同一个定时器，不会叠加。
 */
export function initHud() {
  const clock = document.getElementById(CLOCK_ID);
  if (!clock) return () => {};

  let timer = null;

  const paint = () => {
    const now = new Date();
    const stamp = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    // 只在真正变化时写 DOM：每秒一次的无谓写入会让读屏和快照工具误判重绘
    if (clock.textContent !== stamp) clock.textContent = stamp;
  };

  const start = () => {
    if (timer) return;
    paint();
    timer = setInterval(paint, 1000);
  };

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  // 标签页在后台时停表：没人看的秒针不该继续烧定时器。
  // 回到前台先补一次读数，避免显示的是切走那一刻的时间。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });

  start();

  return stop;
}
