/**
 * arTryOn.js —— AR 试穿 / 试妆的**演示层**（只在用户点击入口后动态 import）。
 *
 * 三个刻意的边界：
 *   1) 不做人脸识别、不调用任何模型：画面是 CSS 模拟 + 一张示意贴图。
 *      真实摄像头只在你点「启用摄像头背景」并授权后才当作**背景**用，帧不上传。
 *   2) 摄像头被拒 / 拿不到流 / 浏览器不支持：静默回落到模拟画面，
 *      顶部换一行说明。绝不弹 error、绝不让层空着。
 *   3) 没有任何定时器：扫描线是 CSS 动画，退出时随节点一起消失。
 *
 * 依赖：ui.js（el/toast）、art.js（截图里的商品线稿）、tryOnConfig.js（文案与预设）。
 */
import { el, toast } from './ui.js';
import { productArtSvg } from './art.js';
import {
  TRYON_CAMERA, TRYON_COPY, TRYON_KIND_TEXT, TRYON_SHOT, cameraSupported, overlayPreset,
  tryOnHueOf, tryOnTintOf,
} from './store/tryOnConfig.js';

/** 贴图可移动范围（百分比），避免被拖到画面外只剩一条边 */
const CLAMP = { min: 8, max: 92 };

/** 规格列表：没有 skus 也要给一个可点的「标准版」，否则底部工具条会空一块 */
function skuListOf(product) {
  const list = Array.isArray(product.skus) ? product.skus.filter((s) => s && s.spec) : [];
  if (list.length) return list.map((s, i) => ({ id: s.id || `sku-${i}`, spec: String(s.spec), price: s.price }));
  return [{ id: 'default', spec: String(product.spec || '标准版'), price: product.price }];
}

/** 规格切换时贴图换色：色名词表优先，哈希兜底 */
const tintOf = (spec) => tryOnTintOf(spec);

/**
 * 挂载演示层。
 * @param {{product:object, kind:string, mode:'camera'|'static', onClose?:Function}} opts
 * @returns {{close:Function, node:HTMLElement}}
 */
export function mountTryOn({ product, kind, mode, onClose } = {}) {
  const p = product && typeof product === 'object' ? product : { name: '商品' };
  const k = String(kind || 'apparel');
  const preset = overlayPreset(k);
  const skus = skuListOf(p);
  const label = TRYON_KIND_TEXT[k] || 'AR 试穿';

  const prevFocus = document.activeElement;
  const abort = new AbortController();
  const { signal } = abort;
  let stream = null;
  let closed = false;
  let activeSku = 0;
  let activeHue = tryOnHueOf(skus[0].spec); // 截图底色相（哈希即可，只是氛围）

  /* ---------------- 顶部状态条 ---------------- */
  const statusText = el('span', { class: 'try-status-text' },
    mode === 'camera' ? TRYON_COPY.cameraOn : TRYON_COPY.staticNote);

  const liveBtn = cameraSupported() && mode === 'camera'
    ? el('button', {
        type: 'button',
        class: 'try-live-btn',
        title: TRYON_COPY.liveToggleHint,
        onclick: () => toggleLive(),
      }, TRYON_COPY.liveToggle)
    : null;

  const closeBtn = el('button', {
    type: 'button',
    class: 'try-close',
    'aria-label': TRYON_COPY.closeLabel,
    onclick: () => close(),
  }, '×');

  const topbar = el('div', { class: 'try-top' }, [
    el('div', { class: 'try-top-left' }, [
      el('span', { class: 'try-demo-tag' }, TRYON_COPY.demoTag),
      el('span', { class: 'try-kind' }, label),
    ]),
    el('div', { class: 'try-top-right' }, [liveBtn, closeBtn]),
  ]);

  /* ---------------- 画面：模拟底 + 可选真实视频 + 商品贴图 ---------------- */
  const video = el('video', {
    class: 'try-video',
    playsinline: '',
    muted: '',
    autoplay: '',
    'aria-hidden': 'true',
  });
  video.hidden = true;

  const simFeed = el('div', { class: 'try-sim', 'aria-hidden': 'true' }, [
    el('i', { class: 'try-sim-glow' }),
    el('i', { class: 'try-sim-scan' }),
    el('i', { class: 'try-sim-floor' }),
  ]);

  const overlayArt = el('span', { class: 'try-object-art' });
  overlayArt.innerHTML = productArtSvg({ ...p, id: `try-${p.id || 'x'}` });

  const overlayTint = el('i', { class: 'try-object-tint', 'aria-hidden': 'true' });
  const overlayCaption = el('span', { class: 'try-caption' }, preset.caption);

  const overlay = el('div', {
    class: 'try-object',
    style: `--top:${preset.top}; --left:${preset.left}; --scale:${preset.scale}`,
  }, [overlayArt, overlayTint, overlayCaption]);

  const stage = el('div', {
    class: 'try-stage',
    role: 'group',
    'aria-label': `${label}演示画面，可拖动移动贴图位置`,
  }, [simFeed, video, overlay]);

  /* 拖动贴图：pointer 事件 + 百分比定位；坐标夹逼在 8%–92% */
  let dragging = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    stage.setPointerCapture?.(e.pointerId);
    stage.classList.add('is-dragging');
  }, { signal });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const left = ((e.clientX - r.left) / r.width) * 100;
    const top = ((e.clientY - r.top) / r.height) * 100;
    overlay.style.setProperty('--left', `${Math.min(CLAMP.max, Math.max(CLAMP.min, left)).toFixed(1)}%`);
    overlay.style.setProperty('--top', `${Math.min(CLAMP.max, Math.max(CLAMP.min, top)).toFixed(1)}%`);
  }, { signal });
  const endDrag = () => {
    dragging = false;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endDrag, { signal });
  stage.addEventListener('pointercancel', endDrag, { signal });

  /* ---------------- 规格切换（mock：换色 + 换标价，不换商品） ---------------- */
  const specReadout = el('b', { class: 'try-spec-readout' }, skus[0].spec);
  const skuRow = el('div', { class: 'try-skus', role: 'group', 'aria-label': TRYON_COPY.skuLabel },
    skus.map((s, i) => el('button', {
      type: 'button',
      class: 'try-sku',
      'aria-pressed': String(i === 0),
      onclick: () => selectSku(i),
    }, [
      el('i', { class: 'try-sku-dot', style: `background:${tryOnTintOf(s.spec)}`, 'aria-hidden': 'true' }),
      el('span', {}, s.spec),
    ])));

  const skuBlock = el('div', { class: 'try-sku-block' }, [
    el('div', { class: 'try-sku-head' }, [
      el('span', { class: 'try-sku-label' }, TRYON_COPY.skuLabel),
      specReadout,
    ]),
    skuRow,
  ]);

  function selectSku(index) {
    const i = Math.max(0, Math.min(skus.length - 1, Number(index) || 0));
    activeSku = i;
    activeHue = tryOnHueOf(skus[i].spec);
    overlayTint.style.background = tintOf(skus[i].spec);
    specReadout.textContent = skus[i].spec;
    [...skuRow.children].forEach((btn, n) => btn.setAttribute('aria-pressed', String(n === i)));
    // 贴图轻微换向：让人确认「确实切了」，而不是只有标签变了
    overlayArt.style.filter = `hue-rotate(${(activeHue - tryOnHueOf(skus[0].spec)).toFixed(0)}deg)`;
  }

  /* ---------------- 底部工具条：截图 / 分享 / 退出 ---------------- */
  const shootBtn = el('button', {
    type: 'button',
    class: 'try-act',
    onclick: () => saveShot(),
  }, TRYON_COPY.shootLabel);

  const shareBtn = el('button', {
    type: 'button',
    class: 'try-act ghost',
    onclick: () => shareMock(),
  }, TRYON_COPY.shareLabel);

  const exitBtn = el('button', {
    type: 'button',
    class: 'try-act ghost',
    onclick: () => close(),
  }, '退出');

  const actions = el('div', { class: 'try-actions' }, [shootBtn, shareBtn, exitBtn]);

  const layer = el('div', {
    class: 'try-layer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': `${label}（${TRYON_COPY.demoTag}）`,
  }, [
    topbar,
    stage,
    el('div', { class: 'try-panel' }, [
      el('div', { class: 'try-status' }, [statusText]),
      skuBlock,
      el('p', { class: 'try-hint' }, `${TRYON_COPY.fitHint} · ${TRYON_COPY.entryHelp}`),
      actions,
    ]),
  ]);

  /* ---------------- 摄像头：只在用户点按钮后申请，拒绝就留在模拟画面 ---------------- */
  async function toggleLive() {
    if (stream) {
      stopStream();
      video.hidden = true;
      simFeed.hidden = false;
      statusText.textContent = TRYON_COPY.cameraOn;
      liveBtn.textContent = TRYON_COPY.liveToggle;
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: TRYON_CAMERA.facingMode },
        audio: false,
      });
      video.srcObject = stream;
      video.hidden = false;
      simFeed.hidden = true;
      await video.play().catch(() => {});
      statusText.textContent = TRYON_COPY.cameraLive;
      liveBtn.textContent = '关闭摄像头背景';
    } catch {
      stopStream();
      video.hidden = true;
      simFeed.hidden = false;
      // 拒绝 / 无设备 / 被系统禁用都走这里：说明一行，继续用模拟画面
      statusText.textContent = TRYON_COPY.cameraDenied;
      toast(TRYON_COPY.cameraFailed, 'warn');
    }
  }

  function stopStream() {
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch { /* 已释放 */ }
    stream = null;
    video.srcObject = null;
  }

  /* ---------------- 截图：canvas 占位图（不上传、不存服务端） ---------------- */
  function saveShot() {
    let url = '';
    try {
      const c = document.createElement('canvas');
      c.width = TRYON_SHOT.W;
      c.height = TRYON_SHOT.H;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no-2d-context');
      drawShot(ctx, c);
      url = c.toDataURL('image/png');
    } catch {
      toast(TRYON_COPY.shootFail, 'warn');
      return;
    }
    const a = el('a', { href: url, download: `maison-ar-${String(p.id || 'demo')}.png` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(TRYON_COPY.shootToast, 'ok');
  }

  function drawShot(ctx, c) {
    const { W, H } = TRYON_SHOT;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${activeHue} 42% 12%)`);
    g.addColorStop(1, '#07090c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 画面网格（1px 细线，和站内视觉语言一致）
    ctx.strokeStyle = 'rgba(34,211,238,0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += 60) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 贴图：把程序化线稿画进画面中央（同源 data URI，不会污染 canvas）
    try {
      const img = new Image();
      img.src = `data:image/svg+xml,${encodeURIComponent(productArtSvg({ ...p, id: `shot-${p.id || 'x'}` }))}`;
      const w = W * 0.62;
      const h = w;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2 - 40, w, h);
    } catch { /* 画不上就只留底色与文字，不影响导出 */ }

    ctx.fillStyle = '#e8edf2';
    ctx.font = '600 40px Georgia, "Times New Roman", serif';
    ctx.fillText(String(p.name || '商品').slice(0, 18), 48, 120);
    ctx.fillStyle = 'rgba(34,211,238,0.92)';
    ctx.font = '24px ui-monospace, monospace';
    ctx.fillText(`${TRYON_COPY.screenshotCaption} / ${label}`, 48, 164);
    ctx.fillStyle = 'rgba(232,237,242,0.82)';
    ctx.font = '24px ui-monospace, monospace';
    ctx.fillText(`SKU ${skus[activeSku].spec}`, 48, H - 96);
    ctx.fillStyle = 'rgba(139,149,163,0.9)';
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillText(TRYON_COPY.demoTag, 48, H - 56);
    ctx.strokeStyle = 'rgba(34,211,238,0.5)';
    ctx.strokeRect(20, 20, W - 40, H - 40);
    // 角落十字准星：让占位图一眼是「取景框」而不是失败图
    ctx.strokeStyle = 'rgba(232,237,242,0.6)';
    [[40, 40, 1, 1], [W - 40, 40, -1, 1], [40, H - 40, 1, -1], [W - 40, H - 40, -1, -1]].forEach(([x, y, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(x + 18 * dx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + 18 * dy);
      ctx.stroke();
    });
    void c;
  }

  /* ---------------- 分享（mock：复制链接，不接任何 SDK） ---------------- */
  function shareMock() {
    const url = `${location.origin}${location.pathname}#/product/${encodeURIComponent(String(p.id || ''))}?ar=1`;
    const done = () => toast(TRYON_COPY.shareToast, 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => toast(TRYON_COPY.shareFail, 'warn'));
      return;
    }
    toast(TRYON_COPY.shareFail, 'warn');
  }

  /* ---------------- 开合 ---------------- */
  function close() {
    if (closed) return;
    closed = true;
    abort.abort();
    stopStream();
    layer.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
    if (typeof onClose === 'function') onClose();
    prevFocus?.focus?.({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  selectSku(0);
  overlayTint.style.background = tintOf(skus[0].spec);
  document.body.classList.add('no-scroll');
  document.addEventListener('keydown', onKey);
  document.body.appendChild(layer);
  closeBtn.focus?.({ preventScroll: true });

  return { close, node: layer };
}
