// AI 工具箱视图：运营文案生成 + 订单售后助手（6 大 AI 模块中的两个运营侧能力）。
import { api, ApiError } from './api.js';
import { el, loading, banner, fmtPrice } from './ui.js';
import { getUserId } from './state.js';
import { isDemoMode, setDemoMode } from './demo.js';

function friendly(err) {
  return err instanceof ApiError ? err.message : '出错了，请稍后重试';
}

function noGateway(err) {
  return !err || err.kind === 'network' || err.kind === 'offline' || err.status === 404;
}

function demoAwareError(err, fallback) {
  if (isDemoMode() || noGateway(err)) {
    if (noGateway(err)) setDemoMode(true);
    return '演示模式：未连接 AI 网关，暂无法生成结果。本地启动 ai-gateway 后刷新即可使用。';
  }
  return fallback;
}

function cwBlock(title, items) {
  if (!items || !items.length) return null;
  return el('div', { class: 'cw-block' }, [
    el('div', { class: 'cw-title' }, title),
    el('ul', {}, items.map((t) => el('li', {}, t))),
  ]);
}

async function handleCopywrite(e, resultEl) {
  e.preventDefault();
  const name = document.getElementById('cw-name').value.trim();
  if (!name) {
    banner(resultEl, '请填写商品名称', 'warn');
    return;
  }
  const priceRaw = document.getElementById('cw-price').value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  loading(resultEl, '正在生成文案…');
  try {
    const data = await api('/api/ai/copywrite', {
      body: {
        product: {
          name,
          brand: document.getElementById('cw-brand').value.trim(),
          category: document.getElementById('cw-category').value.trim(),
          price: priceRaw ? Number(priceRaw) : undefined,
        },
        sellingPoints: document
          .getElementById('cw-points')
          .value.split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
        tone: document.getElementById('cw-tone').value,
        platform: document.getElementById('cw-platform').value,
        count: 3,
      },
    });
    resultEl.innerHTML = '';
    if (data.detail) {
      resultEl.appendChild(el('div', { class: 'cw-block' }, [el('div', { class: 'cw-title' }, '商品详情'), el('div', { style: 'font-size:13px;line-height:1.7;white-space:pre-wrap' }, data.detail)]));
    }
    resultEl.appendChild(cwBlock('标题', data.titles));
    resultEl.appendChild(cwBlock('种草文案', data.social));
    resultEl.appendChild(cwBlock('话题标签', data.hashtags));
  } catch (err) {
    banner(resultEl, demoAwareError(err, friendly(err)), 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function handleAftersale(e, resultEl) {
  e.preventDefault();
  const userId = document.getElementById('as-userId').value.trim() || getUserId();
  const orderId = document.getElementById('as-orderId').value.trim();
  const query = document.getElementById('as-query').value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  loading(resultEl, '正在查询订单…');
  try {
    const data = await api('/api/ai/aftersale', { body: { userId, orderId, query } });
    resultEl.innerHTML = '';
    resultEl.appendChild(el('div', { class: 'intro' }, data.answer || ''));
    (data.orders || []).forEach((o) => {
      resultEl.appendChild(
        el('div', { class: 'order-card' }, [
          el('div', { class: 'oid' }, `${o.productName || o.id} ×${o.qty || 1}`),
          el('div', { class: 'ostatus' }, `订单 ${o.id} · ${o.status || ''}`),
          o.logistics ? el('div', { class: 'olog' }, o.logistics) : null,
        ]),
      );
    });
  } catch (err) {
    banner(resultEl, demoAwareError(err, friendly(err)), 'warn');
  } finally {
    btn.disabled = false;
  }
}

export function renderTools(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE INTELLIGENCE DESK'),
      el('h1', { class: 'page-display' }, 'AI 工坊'),
      el('p', {}, '工具台：生成商品文案、处理订单售后。想看来源与行为的分析报表，请前往「选购洞察」。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      el('span', { class: 'intro-count' }, 'TWO SERVICES'),
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]));

  const cwResult = el('div', { class: 'result', 'aria-live': 'polite' });
  const asResult = el('div', { class: 'result', 'aria-live': 'polite' });

  const cwCard = el('div', { class: 'tool-card' }, [
    el('div', { class: 'tool-head' }, [
      el('span', { class: 'eyebrow' }, 'STUDIO 01'),
      el('span', { class: 'tool-mark', 'aria-hidden': 'true' }, 'A'),
    ]),
    el('h3', {}, '文案工坊'),
    el('p', { class: 'muted' }, '填商品信息、卖点、语气与平台，产出多版本标题、详情与种草文案。'),
    el('form', { onsubmit: (e) => handleCopywrite(e, cwResult) }, [
      el('div', { class: 'form-row' }, [
        el('input', { id: 'cw-name', placeholder: '商品名称，如 声海降噪耳机' }),
        el('input', { id: 'cw-brand', placeholder: '品牌（可选）' }),
      ]),
      el('div', { class: 'form-row' }, [
        el('input', { id: 'cw-category', placeholder: '分类（可选）' }),
        el('input', { id: 'cw-price', placeholder: '价格（可选），如 899', inputmode: 'numeric' }),
      ]),
      el('div', { class: 'form-row full' }, [el('input', { id: 'cw-points', placeholder: '核心卖点，用、或逗号分隔，如 主动降噪、40小时续航' })]),
      el('div', { class: 'form-row' }, [
        el('select', { id: 'cw-tone' }, [
          el('option', { value: '专业' }, '语气：专业'),
          el('option', { value: '活泼' }, '语气：活泼'),
          el('option', { value: '种草', selected: 'selected' }, '语气：种草'),
          el('option', { value: '促销' }, '语气：促销'),
        ]),
        el('select', { id: 'cw-platform' }, [
          el('option', { value: '通用' }, '平台：通用'),
          el('option', { value: '淘宝' }, '平台：淘宝'),
          el('option', { value: '抖音' }, '平台：抖音'),
          el('option', { value: '小红书', selected: 'selected' }, '平台：小红书'),
        ]),
      ]),
      el('div', { class: 'form-row full' }, [el('button', { type: 'submit' }, '生成文案')]),
    ]),
    cwResult,
  ]);

  const asCard = el('div', { class: 'tool-card' }, [
    el('div', { class: 'tool-head' }, [
      el('span', { class: 'eyebrow' }, 'SERVICE 02'),
      el('span', { class: 'tool-mark', 'aria-hidden': 'true' }, 'M'),
    ]),
    el('h3', {}, '订单管家'),
    el('p', { class: 'muted' }, '输入用户 ID 或订单号，查询订单状态、物流与退换货指引。'),
    el('form', { onsubmit: (e) => handleAftersale(e, asResult) }, [
      el('div', { class: 'form-row' }, [
        el('input', { id: 'as-userId', placeholder: '用户 ID（默认本机会话 ID）' }),
        el('input', { id: 'as-orderId', placeholder: '订单号（可选）' }),
      ]),
      el('div', { class: 'form-row full' }, [el('input', { id: 'as-query', placeholder: '问题描述（可选），如 我要退货' })]),
      el('div', { class: 'form-row full' }, [el('button', { type: 'submit' }, '查询')]),
    ]),
    asResult,
  ]);

  const grid = el('div', { class: 'tools-grid' }, [cwCard, asCard]);
  view.appendChild(grid);
}
