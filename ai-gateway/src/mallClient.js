import { config } from './config.js';
import { sampleProducts } from './data/products.js';

// mall 内部 API 客户端。
// 真实接入（docker 模式）：mall 暴露只读内部接口（商品/分类/订单），AI Gateway 带 userId 调它。
// 演示模式：返回内置样本，保证离线可跑。

// 约定：mall 需提供 GET /api/ai/products （返回商品列表，字段对齐 sampleProducts）
export async function fetchProducts() {
  if (config.runMode === 'docker') {
    try {
      const res = await fetch(`${config.mallBaseUrl}/api/ai/products`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) return data;
      }
      console.warn('[mallClient] 拉取商品失败，回退样本数据');
    } catch (e) {
      console.warn(`[mallClient] 无法连接 mall (${config.mallBaseUrl})，回退样本: ${e.message}`);
    }
  }
  return sampleProducts;
}

// 订单查询：售后助手需要按 userId / orderId 查单。
// 演示模式返回内置样本订单；docker 模式优先调 mall /api/ai/orders。
const sampleOrders = [
  { id: 'SO20261001001', userId: 'u1', productName: '声海主动降噪无线蓝牙耳机', qty: 1, price: 899, status: 'shipped', logistics: '顺丰 SF123456，已到达上海转运中心' },
  { id: 'SO20260928007', userId: 'u1', productName: '云帆 14 轻薄笔记本', qty: 1, price: 4599, status: 'completed', logistics: '已签收' },
  { id: 'SO20261020012', userId: 'u2', productName: '暖冬羽绒服', qty: 2, price: 399, status: 'paid', logistics: '待发货' },
];

export async function getOrders(userId) {
  if (config.runMode === 'docker') {
    try {
      const res = await fetch(
        `${config.mallBaseUrl}/api/ai/orders?userId=${encodeURIComponent(userId || '')}`,
        { headers: { 'Content-Type': 'application/json' } },
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) return data;
      }
      console.warn('[mallClient] 拉取订单失败，回退样本数据');
    } catch (e) {
      console.warn(`[mallClient] 无法连接 mall 订单接口，回退样本: ${e.message}`);
    }
  }
  return sampleOrders.filter((o) => !userId || o.userId === userId);
}

export function getOrder(orderId) {
  if (!orderId) return null;
  return sampleOrders.find((o) => o.id === orderId) || null;
}
