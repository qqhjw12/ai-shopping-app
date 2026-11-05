// AR 预览演示占位层：**按需动态 import**——只有移动端点击「AR 预览」且
// WebXR(immersive-ar) 探测通过时才会加载本模块（首屏零请求）。
// 本仓库不引 model-viewer / Three.js：这里是诚实的「演示模式」占位实现，
// 真实 AR 会话的接入点已留好（renderer/会话建立处见 TODO 标注）。
import { el } from './ui.js';

export function openArDemo({ product, image }) {
  const prevFocus = document.activeElement;
  const close = () => {
    layer.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const src = image?.src || product.pic || '';
  const stage = el('div', { class: 'ar-stage' }, [
    el('div', { class: 'ar-frame' }, [
      src ? el('img', { class: 'ar-object', src, alt: `${product.name || '商品'} AR 占位` }) : null,
      el('i', { class: 'ar-corner ar-tl', 'aria-hidden': 'true' }),
      el('i', { class: 'ar-corner ar-tr', 'aria-hidden': 'true' }),
      el('i', { class: 'ar-corner ar-bl', 'aria-hidden': 'true' }),
      el('i', { class: 'ar-corner ar-br', 'aria-hidden': 'true' }),
    ]),
  ]);

  const layer = el('div', { class: 'ar-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AR 预览（演示模式）' }, [
    el('div', { class: 'ar-status' }, [
      el('span', { class: 'ar-status-text' }, 'AR PREVIEW / 演示模式'),
      el('button', { type: 'button', class: 'ar-close', 'aria-label': '关闭 AR 预览', onclick: close }, '×'),
    ]),
    stage,
    el('div', { class: 'ar-note' }, '演示模式：AR 实拍占位层（按需加载），真实会话需接入 model-viewer / WebXR'),
  ]);

  document.body.classList.add('no-scroll');
  document.addEventListener('keydown', onKey);
  document.body.appendChild(layer);
  layer.querySelector('.ar-close')?.focus({ preventScroll: true });
  // TODO(真实 AR 会话)：在此建立 WebXR immersive-ar 会话或挂载 model-viewer
}
