/**
 * fx.js —— 全局氛围动效性能开关。
 * 不含业务逻辑：只负责把「这台设备能承受多少装饰动效」翻译成 html 上的类名，
 * CSS 侧所有装饰动画（网格漂移 / 扫描线 / 呼吸点 / backdrop-filter）按类名降级。
 *
 *  - html.reduced-fx  小屏（<768px）/ prefers-reduced-motion / 设备内存 <4GB
 *  - html.low-power   电池电量 <20% 且未在充电（只停网格漂移这类纯装饰）
 *
 * 判定全部是可变状态：监听 matchMedia / resize / 电量变化，实时增删类。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return; // Node（静态检查）环境直接跳过
  var root = document.documentElement;
  var mqReduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function applySwitch() {
    var reduced = !!(mqReduced && mqReduced.matches);
    var small = window.innerWidth < 768;
    var mem = navigator.deviceMemory || 8; // 未暴露时按高配处理
    var lowMem = mem < 4;
    root.classList.toggle('reduced-fx', reduced || small || lowMem);
  }

  // ---- 低电量：纯装饰（网格漂移）单独静止 ----
  function watchBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(function (bat) {
      var applyPower = function () {
        root.classList.toggle('low-power', !bat.charging && bat.level < 0.2);
      };
      applyPower();
      bat.addEventListener('levelchange', applyPower);
      bat.addEventListener('chargingchange', applyPower);
    }).catch(function () { /* 电池 API 拒绝：按正常供电处理 */ });
  }

  var resizeTick = 0;
  window.addEventListener('resize', function () {
    if (resizeTick) return;
    resizeTick = requestAnimationFrame(function () { resizeTick = 0; applySwitch(); });
  }, { passive: true });
  if (mqReduced) {
    var onChange = mqReduced.addEventListener
      ? mqReduced.addEventListener.bind(mqReduced, 'change', applySwitch)
      : null; // 旧实现：不再单独兼容，每次导航都会重新初始化
    if (!onChange && mqReduced.addListener) mqReduced.addListener(applySwitch);
  }

  applySwitch();
  watchBattery();
})();
