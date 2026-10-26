import { config, useReal } from './config.js';
import * as productRepo from './repositories/productRepo.js';
import * as orderRepo from './repositories/orderRepo.js';

// mall 内部 API 客户端。
// 真实接入（docker 模式）：mall 暴露只读内部接口（商品/分类/订单），AI Gateway 带 userId 调它。
// local 模式：直接读本地 SQLite（64 款商品 + 演示订单），无需任何外部服务。

// 约定：mall 需提供 GET /api/ai/products （返回商品列表，字段对齐 productRepo）
export async function fetchProducts() {
  if (useReal()) {
    try {
      const res = await fetch(`${config.mallBaseUrl}/api/ai/products`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length) return data;
      }
      console.warn('[mallClient] 拉取商品失败，回退本地 SQLite');
    } catch (e) {
      console.warn(`[mallClient] 无法连接 mall (${config.mallBaseUrl})，回退本地 SQLite: ${e.message}`);
    }
  }
  return productRepo.listProducts();
}

// 订单查询：售后助手需要按 userId / orderId 查单。
// local 模式读 SQLite 里的演示订单（含物流信息）。
export async function getOrders(userId) {
  if (useReal()) {
    try {
      const res = await fetch(
        `${config.mallBaseUrl}/api/ai/orders?userId=${encodeURIComponent(userId || '')}`,
        { headers: { 'Content-Type': 'application/json' } },
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length) return data;
      }
      console.warn('[mallClient] 拉取订单失败，回退本地 SQLite');
    } catch (e) {
      console.warn(`[mallClient] 无法连接 mall 订单接口，回退本地 SQLite: ${e.message}`);
    }
  }
  return orderRepo.listOrdersForDemo(userId);
}

export function getOrder(orderId) {
  return orderRepo.getOrderById(orderId);
}
