// 物流视图：把「订单状态 + 物流事件」翻译成时间线要画的东西。
//
// 为什么单独成一个模块：
//   1) 时间线是**四段固定节点**（已揽收 / 运输中 / 派送中 / 已签收），
//      但事件是零到四条。渲染层如果自己按 events 逐条画，就会出现
//      「只有一条记录的时间线」——用户看不出后面还有几步。这里补齐未到达的节点（done:false）。
//   2) 事件有两个来源：服务端（真实流水）与本地演示（mock 发货）。两者的 code 必须一致，
//      所以词表放这里，服务端 ai-gateway/src/services/logisticsService.js 是同构的一份。
//      这是刻意重复（与 shippingFeeOf 同理）：服务端要能独立跑，前端要能离线渲染。
//
// 时间格式：一律沿用全站的做法——直接切 'YYYY-MM-DD HH:mm:ss' 的字符串，不做时区换算。
// 换成 new Date() 解析再本地化，会与订单页其他地方（下单时间也是切字符串）差 8 小时，
// 时间线看起来就像「比下单时间还早」。
const STAGES = [
  { code: 'picked_up', title: '已揽收' },
  { code: 'in_transit', title: '运输中' },
  { code: 'out_for_delivery', title: '派送中' },
  { code: 'signed', title: '已签收' },
];

export const LOGISTICS_STAGES = STAGES;

const STAGE_BY_CODE = new Map(STAGES.map((s) => [s.code, s]));

const COMPANIES = [
  { name: '顺丰速运', prefix: 'SF' },
  { name: '京东物流', prefix: 'JD' },
  { name: '中通快递', prefix: 'ZT' },
];

/** 'YYYY-MM-DD HH:mm:ss' → 'MM-DD HH:mm'（与全站一致，只切字符串） */
export function fmtWhen(at) {
  const s = String(at || '');
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s.slice(0, 16);
}

/** 与服务端 dbTime 同格式（UTC 秒级），本地演示写进去的事件才能和服务端事件混排 */
function dbTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 本地演示：揽收 + 运输中两条事件。
 * 时间往前错开一分钟——两条同秒看起来像重复记录，放到未来又自相矛盾。
 */
export function mockShipEvents(company, now = Date.now()) {
  return [
    { code: 'picked_up', title: '已揽收', detail: `${company} 已揽收，发往始发分拨中心`, at: dbTime(now - 60000) },
    { code: 'in_transit', title: '运输中', detail: '包裹已离开始发分拨中心，正在运往收货城市', at: dbTime(now) },
  ];
}

/** 本地演示：派送中 + 已签收 */
export function mockDeliverEvents(now = Date.now()) {
  return [
    { code: 'out_for_delivery', title: '派送中', detail: '快件已到达收货城市网点，快递员正在派送', at: dbTime(now - 60000) },
    { code: 'signed', title: '已签收', detail: '包裹已签收，签收人：本人', at: dbTime(now) },
  ];
}

/** 本地演示：随机快递 + 运单号 + 两条事件 */
export function mockShipment(now = Date.now()) {
  const c = COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
  const digits = String(now).slice(-8) + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return {
    company: c.name,
    trackingNo: `${c.prefix}${digits}`,
    events: mockShipEvents(c.name, now),
  };
}

/**
 * 订单 → 时间线视图。
 *
 * @returns {{company:string, trackingNo:string, shipped:boolean,
 *            events:Array<{code,title,detail,at}>, stages:Array<{code,title,at,done}>}}
 *   events 已发生（旧→新），stages 是补齐后的四段固定节点。
 */
export function logisticsOf(order = {}) {
  const logi = order.logistics || {};
  const events = (Array.isArray(logi.events) ? logi.events : [])
    .filter((e) => e && e.code)
    .map((e) => ({
      code: e.code,
      title: e.title || (STAGE_BY_CODE.get(e.code) || {}).title || '物流更新',
      detail: e.detail || '',
      at: e.at || e.happenedAt || '',
    }));

  // 老订单 / 本地单没有事件行：按状态与时间戳补出来。
  // 宁可合成两条也比「已发货但时间线一片空白」强——后者看起来就是功能坏了。
  if (!events.length) {
    const shippedAt = logi.shippedAt || order.shippedAt || '';
    const completedAt = logi.completedAt || order.completedAt || '';
    if (shippedAt && ['shipped', 'completed', 'refunding'].includes(order.status)) {
      events.push({ code: 'picked_up', title: '已揽收', detail: '', at: shippedAt });
      events.push({ code: 'in_transit', title: '运输中', detail: '', at: shippedAt });
    }
    if (completedAt && (order.status === 'completed' || order.status === 'refunding')) {
      events.push({ code: 'out_for_delivery', title: '派送中', detail: '', at: completedAt });
      events.push({ code: 'signed', title: '已签收', detail: '', at: completedAt });
    }
  }

  const byCode = new Map();
  events.forEach((e) => byCode.set(e.code, e));

  return {
    company: logi.company || order.logisticsCompany || '',
    trackingNo: logi.trackingNo || order.trackingNo || '',
    shipped: events.length > 0,
    events,
    // 四段固定节点：已发生的带时间，未发生的 done:false（前端灰显，但保留位置）
    stages: STAGES.map((s) => {
      const hit = byCode.get(s.code);
      return {
        code: s.code,
        title: s.title,
        detail: hit ? hit.detail : '',
        at: hit ? hit.at : '',
        done: Boolean(hit),
      };
    }),
  };
}
