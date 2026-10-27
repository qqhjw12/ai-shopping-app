// PDP mock 数据 · 仅用于当前阶段。
// 后续接入真实商品详情 API 时，保持 ProductDetail 字段不变，替换 productDetailStore 的取数实现即可。
// ProductDetail: { id, name, price, originalPrice, images[], skus[], stock, shippingNote, returnNote, rating, reviewCount }
// images 由 productDetailStore 根据 imageLabels / 商品主图生成，保证画廊至少有 3 个视图。

export const PRODUCT_DETAIL_MOCKS = {
  p017: {
    id: 'p017',
    name: '云帆 14 轻薄笔记本',
    brand: '云帆',
    category: '电脑办公',
    categoryId: 'computer',
    price: 5999,
    originalPrice: 6499,
    stock: 396,
    rating: 4.7,
    reviewCount: 1885,
    imageLabels: ['正面', '结构', '细节'],
    skuGroupLabel: '颜色 / 配置',
    skus: [
      { id: 'p017-s1', spec: '深空灰 / 16G + 512G', price: 5999, stock: 133, status: 'on_sale' },
      { id: 'p017-s2', spec: '月光银 / 16G + 1T', price: 6299, stock: 132, status: 'on_sale' },
      { id: 'p017-s3', spec: '深空灰 / 32G + 1T', price: 6599, stock: 131, status: 'on_sale' },
    ],
    shippingNote: '顺丰空运包邮 · 付款后 48 小时内发出',
    returnNote: '7 天无理由退换 · 一年整机质保',
    highlight: '14 英寸 2.8K 屏幕',
    description: '14 英寸 2.8K 屏幕，重 1.2kg，标压 i7 + 16G 内存，续航 12 小时，出差办公首选。',
    highlights: ['正品保障', '顺丰包邮', '一年质保', '七天无理由'],
  },

  p033: {
    id: 'p033',
    name: '声海 主动降噪无线耳机',
    brand: '声海',
    category: '音频耳机',
    categoryId: 'audio',
    price: 899,
    originalPrice: 999,
    stock: 310,
    rating: 4.5,
    reviewCount: 1239,
    imageLabels: ['正面', '佩戴', '细节'],
    skuGroupLabel: '颜色',
    skus: [
      { id: 'p033-s1', spec: '曜石黑 / 标准版', price: 899, stock: 103, status: 'on_sale' },
      { id: 'p033-s2', spec: '暖沙白 / 标准版', price: 1199, stock: 102, status: 'on_sale' },
      { id: 'p033-s3', spec: '雾霭蓝 / 标准版', price: 1499, stock: 105, status: 'on_sale' },
    ],
    shippingNote: '顺丰包邮 · 预计 24 小时内发出',
    returnNote: '7 天无理由退换 · 一年质保',
    highlight: '主动降噪深度 42dB',
    description: '主动降噪深度 42dB，42 小时总续航，IPX5 防水，通勤与运动都合适。',
    highlights: ['正品保障', '顺丰包邮', '一年质保', '七天无理由'],
  },

  p097: {
    id: 'p097',
    name: '栖木 人体工学办公椅',
    brand: '栖木',
    category: '家居家具',
    categoryId: 'home',
    price: 1299,
    originalPrice: 1599,
    stock: 33,
    rating: 4.8,
    reviewCount: 1637,
    imageLabels: ['正面', '结构', '场景'],
    skuGroupLabel: '颜色 / 版本',
    skus: [
      { id: 'p097-s1', spec: '石墨黑 / 标准版', price: 1299, stock: 17, status: 'on_sale' },
      { id: 'p097-s2', spec: '石墨黑 / 带脚托', price: 1599, stock: 16, status: 'on_sale' },
    ],
    shippingNote: '送货上门 · 预计 3–5 个工作日送达',
    returnNote: '7 天无理由退换 · 三年质保',
    highlight: '四向调节腰托 + 3D 扶手',
    description: '四向调节腰托 + 3D 扶手，网背透气久坐不闷，适合每天 8 小时办公。',
    highlights: ['正品保障', '送货上门', '三年质保', '七天无理由'],
  },
};

export function getMockProductDetail(id) {
  return PRODUCT_DETAIL_MOCKS[String(id)] || null;
}
