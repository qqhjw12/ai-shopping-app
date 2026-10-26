import { appEnabled, runWorkflow } from './difyClient.js';
import { getOrders, getOrder } from './mallClient.js';

// 订单售后助手：按 userId / orderId 查单，给出状态、物流、退换货指引。
// docker 模式调用 Dify Workflow（可在 Dify 控制台接 mall 订单 API 做更复杂的售后编排）；
// local 模式用内置样本订单 + 规则兜底，保证离线演示可跑。

const STATUS_TEXT = {
  paid: '已付款，待发货',
  shipped: '已发货，运输中',
  completed: '已完成（已签收）',
  refunding: '退款 / 售后处理中',
};

async function localAfterSale({ userId, orderId, query }) {
  const orders = orderId ? [getOrder(orderId)].filter(Boolean) : await getOrders(userId);
  if (!orders.length) {
    return {
      answer: '抱歉，暂时没有查到相关订单。请确认已登录，或提供订单号；也可以联系人工客服协助。',
      orders: [],
      mode: 'local',
    };
  }
  const o = orders[0];
  const status = STATUS_TEXT[o.status] || o.status;
  let answer = `您的订单 ${o.id}（${o.productName} ×${o.qty}）当前状态：${status}。`;
  if (o.status === 'shipped') {
    answer += ` 物流信息：${o.logistics}。如需退货，可在签收后 7 天内发起。`;
  } else if (o.status === 'completed') {
    answer += ` 已签收。如需退换货，请在售后时效内申请。`;
  } else if (o.status === 'paid') {
    answer += ` 仓库正在备货，暂不支持修改收货地址。`;
  }
  answer += ` 您也可以直接说「我要退货」，我帮您发起售后流程。`;
  return { answer, orders, mode: 'local' };
}

export async function handleAfterSale({ userId, orderId, query }) {
  if (appEnabled('aftersale')) {
    try {
      const inputs = {
        user_id: userId || '',
        order_id: orderId || '',
        query: query || '',
      };
      const r = await runWorkflow(config.dify.aftersaleApiKey, {
        inputs,
        userId: userId || 'anonymous',
      });
      const out = r.outputs || {};
      return {
        answer: out.answer || '',
        orders: out.orders || [],
        mode: 'dify',
      };
    } catch (e) {
      console.warn(`[aftersale] Dify 失败，回退本地逻辑: ${e.message}`);
    }
  }
  return localAfterSale({ userId, orderId, query });
}
