/**
 * pdpTryOn.js —— 详情页「AR 试穿 / 试妆」入口（轻量，随首屏加载）。
 *
 * 职责边界：
 *   · 本模块只做三件事：判断该不该出现、桌面端弹提示、移动端探测能力后
 *     **动态 import** 演示层。它自己绝不 import arTryOn.js 的静态依赖，
 *     所以首屏零 AR 请求（e2e 会在网络面板上盯这一条）。
 *   · 不申请摄像头权限：申请发生在用户进了演示层、又主动点了「启用摄像头背景」
 *     之后。进页面就弹权限框是最快的流失方式，也会让「没授权」看起来像 bug。
 *
 * 与 pdpImmersive.js 里那个「AR 预览」的分工：
 *   AR 预览 = 把商品放进你所在的空间（任何类目都能用，需 WebXR）；
 *   AR 试穿 = 把商品穿到你身上 / 脸上（只对服饰鞋包美妆珠宝钟表眼镜有意义）。
 *   两个入口都在，但语义不同，所以没有合并。
 */
import { el, openModal, toast } from './ui.js';
import { trackEvent } from './track.js';
import { TRYON_COPY, cameraSupported, tryOnKindOf, tryOnLabel } from './store/tryOnConfig.js';

/** 是否触屏（粗指针）——桌面端只提示，不加载演示层 */
function isCoarsePointer() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

/**
 * 入口按钮；不支持的类目返回 null（调用方直接不插 DOM）。
 * @param {object} product
 * @param {string} className 额外样式类（沿用次要操作区的 ghost）
 */
export function tryOnButton(product, className = 'ghost') {
  const kind = tryOnKindOf(product);
  if (!kind) return null;
  const label = tryOnLabel(product);
  return el('button', {
    type: 'button',
    class: `tryon-entry ${className}`.trim(),
    'data-tryon-kind': kind,
    title: TRYON_COPY.entryHelp,
    'aria-label': `${label}（${TRYON_COPY.demoTag}）`,
    onclick: () => openTryOn(product),
  }, [
    el('span', { class: 'tryon-entry-icon', 'aria-hidden': 'true' }, '◈'),
    el('span', {}, label),
  ]);
}

/**
 * 打开试穿：桌面提示 / 移动端按能力选模式 / 失败降级为说明。
 */
export async function openTryOn(product) {
  const kind = tryOnKindOf(product);
  if (!kind) return;
  trackEvent({ event: 'pdp_tryon_entry', source: 'detail', productId: product.id, kind });

  if (!isCoarsePointer()) {
    // 桌面端：只弹一句话，不 import 任何演示代码
    const label = tryOnLabel(product);
    openModal((modal, close) => {
      modal.appendChild(el('div', { class: 'tryon-prompt' }, [
        el('span', { class: 'tryon-prompt-tag' }, TRYON_COPY.demoTag),
        el('h3', {}, TRYON_COPY.desktopTitle),
        el('p', {}, TRYON_COPY.desktopBody(label)),
        el('button', { type: 'button', class: 'ghost tryon-prompt-ok', onclick: close }, TRYON_COPY.desktopOk),
      ]));
    });
    return;
  }

  // 移动端：有 getUserMedia 走「演示画面 + 可选真背景」，没有就静态示意图
  const mode = cameraSupported() ? 'camera' : 'static';
  try {
    const { mountTryOn } = await import('./arTryOn.js');
    mountTryOn({ product, kind, mode });
  } catch {
    toast(TRYON_COPY.loadFail, 'warn');
  }
}
