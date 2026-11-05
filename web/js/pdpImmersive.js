// 商品详情 3D/360° + AR 入口：最轻方案，零重型依赖。
//
// - 360° 查看器 = 图片序列切帧（12–24 帧）：拖拽/滑动按距离映射帧索引，
//   松手带惯性阻尼、首尾无缝衔接；支持键盘左右方向键（stage 可聚焦）。
//   无真实序列图时用同一张图占位并在角落标注「演示」，交互骨架完整。
// - AR 预览 = 渐进增强入口：桌面端弹层提示（不加载任何脚本）；移动端
//   支持 WebXR 时才动态 import 演示占位层（arPreview.js），不支持时降级
//   为图片查看并给出一行说明。
// - 刻意不引 Three.js / model-viewer：首屏零 3D 请求、零 WebGL 上下文；
//   页面切换（节点断开）时 rAF 自停 + AbortController 释放监听，无泄漏。
import { el, openModal } from './ui.js';
import { trackEvent } from './track.js';

const FRAME_COUNT = 24; // 演示序列帧数（规格 12–24）
const DRAG_PX_PER_FRAME = 18; // 拖动距离 → 帧索引映射
const INERTIA_DECAY = 0.94; // 松手惯性阻尼（每 16ms 速度 ×0.94）
const INERTIA_MIN = 0.02; // 低于该帧速度即停（帧/16ms）

const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 低端设备探测：仅用于提示口径——默认永远停在图片模式，3D 入口需用户主动点击 */
export function isLowEndDevice() {
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  return cores <= 4 || mem <= 4;
}

/** AR 能力探测：只在移动端被问到，任何异常都按「不支持」处理 */
async function arSupported() {
  try {
    if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') return false;
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

/**
 * 构建带「图片 / 360° 查看」切换与 AR 入口的画廊。
 * views.js 把原 mainButton（图片模式主图）与 thumbs 交进来，本模块负责：
 * 视图条（模式切换 + AR 预览）、360° 舞台（懒初始化 + 帧预载进度 + 失败兜底）、
 * 模式互斥显示。返回 section 结构：[viewbar, viewer, arNote, thumbs]。
 */
export function createGalleryModes(product, galleryImages, mainButton, thumbs) {
  const hasRealSequence = Array.isArray(product.spinFrames) && product.spinFrames.length >= 12;
  const baseSrc = galleryImages[0]?.src || product.pic || '';

  /* ---- 360° 舞台状态（首次进入 360° 模式才初始化）---- */
  let spinStage = null;
  let spinFrameImg = null;
  let spinCounter = null;
  let spinProgressFill = null;
  let spinFail = null;
  let spinRaf = 0;
  let position = 0; // 连续帧位置（可越界，显示时取模回绕）
  let frames = [];
  let velocity = 0;
  let dragging = false;
  const abort = new AbortController();
  const { signal } = abort;

  const setSpinFrame = (frameIndex) => {
    const n = frames.length;
    if (!n || !spinStage) return;
    const f = ((Math.round(frameIndex) % n) + n) % n;
    position = Math.round(frameIndex);
    if (frames[f]) spinFrameImg.src = frames[f];
    spinStage.dataset.frame = String(f);
    spinCounter.textContent = `${String(f + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    spinStage.setAttribute('aria-valuenow', String(f + 1));
    spinStage.setAttribute('aria-valuetext', `第 ${f + 1} 帧，共 ${n} 帧`);
  };

  /** 惯性：rAF 循环衰减速度；节点断开即自停（页面切换零泄漏） */
  function inertia() {
    if (reducedMotion()) return; // reduced-motion：拖到哪停哪，无自动运动
    let last = performance.now();
    const step = (now) => {
      if (!spinStage || !spinStage.isConnected) return;
      const dt = Math.max(1, now - last);
      last = now;
      const k = dt / 16;
      position += velocity * k;
      velocity *= Math.pow(INERTIA_DECAY, k);
      setSpinFrame(position);
      if (Math.abs(velocity) > INERTIA_MIN) spinRaf = requestAnimationFrame(step);
    };
    spinRaf = requestAnimationFrame(step);
  }

  function showSpinFail() {
    if (!spinStage || spinFail) return;
    spinProgressFill.parentElement.classList.add('is-error');
    spinFail = el('div', { class: 'spin-fail', role: 'status' }, [
      el('span', { class: 'spin-fail-text' }, '3D 预览暂不可用'),
      el('button', { type: 'button', class: 'ghost spin-fail-back', onclick: () => setMode('image') }, '切回图片'),
    ]);
    spinStage.appendChild(spinFail);
  }

  function buildSpinStage() {
    frames = hasRealSequence
      ? product.spinFrames.slice(0, FRAME_COUNT)
      : Array.from({ length: FRAME_COUNT }, () => baseSrc);
    spinFrameImg = el('img', { class: 'spin-frame', src: '', alt: `${product.name || '商品'} 360° 视图帧` });
    spinCounter = el('span', { class: 'spin-counter', 'aria-hidden': 'true' }, '01 / 24');
    spinProgressFill = el('i');
    const progress = el('span', { class: 'spin-progress', 'aria-hidden': 'true' }, [spinProgressFill]);
    spinStage = el('div', {
      class: 'spin-stage',
      tabindex: '0',
      role: 'slider',
      'aria-orientation': 'horizontal',
      'aria-label': `360° 商品视图：横向拖拽旋转，或使用左右方向键切帧（${hasRealSequence ? '实拍序列' : '演示序列'}）`,
      'aria-valuemin': '1',
      'aria-valuemax': String(frames.length),
      'aria-valuenow': '1',
      'data-demo': String(!hasRealSequence),
    }, [
      spinFrameImg,
      hasRealSequence ? null : el('span', { class: 'spin-demo-tag' }, '演示'),
      el('span', { class: 'spin-hint' }, '拖拽旋转 · ← → 切帧'),
      spinCounter,
      progress,
    ]);

    /* 帧预载：1px 青色进度细线；任一帧失败 → 兜底层（「3D 预览暂不可用」+ 切回图片） */
    const unique = [...new Set(frames)];
    if (!unique[0]) {
      showSpinFail();
    } else {
      let loaded = 0;
      const paint = () => {
        spinProgressFill.style.transform = `scaleX(${loaded / unique.length})`;
        if (loaded >= unique.length) progress.classList.add('is-done');
      };
      unique.forEach((src) => {
        const probe = new Image();
        probe.onload = () => { loaded += 1; paint(); };
        probe.onerror = () => { loaded += 1; paint(); showSpinFail(); };
        probe.src = src;
      });
    }

    /* 拖拽 → 帧映射 + 松手惯性；横向手势由 CSS touch-action:none 保证 */
    let startX = 0;
    let startPos = 0;
    let lastX = 0;
    let lastT = 0;
    spinStage.addEventListener('pointerdown', (e) => {
      // 兜底层里的按钮要能正常点击：pointer capture 会把 click 重定向到 stage，
      // 所以落在按钮上的按下事件不能启动拖拽
      if (e.target.closest('button')) return;
      dragging = true;
      startX = lastX = e.clientX;
      startPos = position;
      lastT = performance.now();
      velocity = 0;
      cancelAnimationFrame(spinRaf);
      spinStage.classList.add('is-dragging');
      spinStage.setPointerCapture(e.pointerId);
    }, { signal });
    spinStage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      position = startPos + dx / DRAG_PX_PER_FRAME;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      const vInstant = (((e.clientX - lastX) / DRAG_PX_PER_FRAME) / dt) * 16; // 帧/16ms
      velocity = 0.7 * velocity + 0.3 * vInstant;
      lastX = e.clientX;
      lastT = now;
      setSpinFrame(position);
    }, { signal });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      spinStage.classList.remove('is-dragging');
      try { spinStage.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      inertia();
    };
    spinStage.addEventListener('pointerup', endDrag, { signal });
    spinStage.addEventListener('pointercancel', endDrag, { signal });

    /* 键盘可访问性：左右方向键切帧（stage 可聚焦） */
    spinStage.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); velocity = 0; setSpinFrame(position + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); velocity = 0; setSpinFrame(position - 1); }
    }, { signal });

    setSpinFrame(0);
    return spinStage;
  }

  /* ---- 模式条：图片 / 360° 查看 + AR 预览 ---- */
  const imageBtn = el('button', {
    type: 'button',
    class: 'pdp-mode-btn is-active',
    'aria-pressed': 'true',
    onclick: () => setMode('image'),
  }, '图片');
  const spinBtn = el('button', {
    type: 'button',
    class: 'pdp-mode-btn',
    'aria-pressed': 'false',
    onclick: () => setMode('spin'),
  }, '360° 查看');
  const arBtn = el('button', {
    type: 'button',
    class: 'pdp-mode-btn pdp-ar-btn',
    onclick: () => handleAr(),
  }, 'AR 预览');
  const viewbar = el('div', { class: 'pdp-viewbar', role: 'group', 'aria-label': '查看方式' }, [
    imageBtn, spinBtn, el('span', { class: 'pdp-viewbar-gap', 'aria-hidden': 'true' }), arBtn,
  ]);

  const viewer = el('div', { class: 'pdp-viewer' }, [mainButton]);
  const arNote = el('div', { class: 'pdp-ar-note', role: 'status' });
  arNote.hidden = true;

  function setMode(next) {
    if (next === 'spin' && !spinStage) {
      spinStage = buildSpinStage();
      viewer.appendChild(spinStage);
    }
    const showSpin = next === 'spin';
    mainButton.style.display = showSpin ? 'none' : '';
    if (spinStage) spinStage.style.display = showSpin ? '' : 'none';
    imageBtn.classList.toggle('is-active', !showSpin);
    spinBtn.classList.toggle('is-active', showSpin);
    imageBtn.setAttribute('aria-pressed', String(!showSpin));
    spinBtn.setAttribute('aria-pressed', String(showSpin));
    if (showSpin) {
      trackEvent({ event: 'pdp_view_360', source: 'detail', productId: product.id });
      spinStage?.focus({ preventScroll: true });
    }
  }

  /* ---- AR 渐进增强：桌面提示 / 移动演示层 / 不支持降级说明 ---- */
  function showArNote(text) {
    arNote.textContent = text;
    arNote.hidden = false;
    clearTimeout(showArNote._t);
    showArNote._t = setTimeout(() => { arNote.hidden = true; }, 8000);
  }

  async function handleAr() {
    trackEvent({ event: 'pdp_ar_entry', source: 'detail', productId: product.id });
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) {
      // 桌面端：只弹提示层，不加载任何脚本
      openModal((modal, close) => {
        modal.appendChild(el('div', { class: 'pdp-ar-prompt' }, [
          el('h3', {}, '请在移动设备上使用 AR 预览'),
          el('p', {}, 'AR 实拍需要手机摄像头与 WebXR 支持；桌面端可以先用 360° 查看从各个角度观察商品。'),
          el('button', { type: 'button', class: 'ghost pdp-ar-prompt-ok', onclick: close }, '知道了'),
        ]));
      });
      return;
    }
    const supported = await arSupported();
    if (!supported) {
      // 不支持：降级为普通图片查看 + 一行说明（绝不静默失败）
      setMode('image');
      showArNote('当前设备不支持 AR 预览，已为你切回图片查看（360° 查看仍可用）');
      return;
    }
    // 支持 WebXR：此时才按需加载演示层模块（首屏零加载；真实会话接入点已留好）
    try {
      const { openArDemo } = await import('./arPreview.js');
      openArDemo({ product, image: galleryImages[0] });
    } catch {
      showArNote('AR 预览资源加载失败，请稍后重试（图片与 360° 查看不受影响）');
    }
  }

  const section = el('section', { class: 'pdp-gallery', 'aria-label': '商品图片画廊' }, [viewbar, viewer, arNote, thumbs]);

  /** 显式销毁：离开页面前回收监听与动画（节点断开时 rAF 也会自停，双保险） */
  function destroy() {
    abort.abort();
    cancelAnimationFrame(spinRaf);
    spinStage?.remove();
    spinStage = null;
  }
  section._immersiveDestroy = destroy;

  return section;
}
