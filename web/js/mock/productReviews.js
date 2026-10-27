// PDP 评价 mock 数据 · 仅用于当前阶段。
// 后续接入真实评价 API 时，保持 Review 字段不变，替换 productDetailStore 的取数实现即可。
// Review: { id, author, rating, content, created_at, skuSpec?, helpful?, aspects? }
//   - author / rating / content / created_at：与既有 reviewCard 渲染契约对齐；
//   - aspects：带极性的评价侧写（pos 好评点 / neg 顾虑点），AI 摘要据此统计要点，
//     比直接对正文做分词更可控，也让摘要结论可解释、可回溯到具体评价；
//   - helpful：有用票数，供「最有用」排序使用。

export const PRODUCT_REVIEWS = {
  // 云帆 14 轻薄笔记本
  p017: [
    {
      id: 'rv-p017-1',
      author: '陈知远',
      rating: 5,
      created_at: '2026-09-18',
      skuSpec: '深空灰 / i7 16G+512G',
      helpful: 132,
      content: '出差党刚需。2.8K 屏看文档和修图都很通透，机身 1.2kg 塞进通勤包毫无负担，一天会议加写作下来还剩三成电。',
      aspects: [
        { text: '2.8K 屏幕通透', polarity: 'pos' },
        { text: '机身轻便', polarity: 'pos' },
        { text: '续航扎实', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p017-2',
      author: '苏晓',
      rating: 5,
      created_at: '2026-09-02',
      skuSpec: '月光银 / 16G + 1T',
      helpful: 96,
      content: '键盘手感和触控板面积超出预期，写代码一天不累。金属机身做工细腻，没有廉价感。',
      aspects: [
        { text: '键盘手感好', polarity: 'pos' },
        { text: '做工精致', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p017-3',
      author: '林成',
      rating: 4,
      created_at: '2026-08-25',
      skuSpec: '深空灰 / 16G + 512G',
      helpful: 58,
      content: '日常办公非常安静，但跑大型表格和轻度剪辑时风扇会起来，声音不算小。性能释放偏保守点。',
      aspects: [
        { text: '办公安静', polarity: 'pos' },
        { text: '高负载风扇噪音', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p017-4',
      author: '郑楠',
      rating: 5,
      created_at: '2026-08-11',
      skuSpec: '深空灰 / 32G + 1T',
      helpful: 74,
      content: '32G 版本多开虚拟机也不卡，接口够我用。唯一希望下一代把读卡器加回来。',
      aspects: [
        { text: '多任务流畅', polarity: 'pos' },
        { text: '接口偏少', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p017-5',
      author: '何一白',
      rating: 4,
      created_at: '2026-07-29',
      skuSpec: '月光银 / 16G + 1T',
      helpful: 31,
      content: '屏幕素质确实好，但默认色温偏冷，自己校了一下才舒服。包装很讲究，开箱体验不错。',
      aspects: [
        { text: '屏幕素质好', polarity: 'pos' },
        { text: '默认色温偏冷', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p017-6',
      author: '吴柏',
      rating: 5,
      created_at: '2026-07-16',
      skuSpec: '深空灰 / 16G + 512G',
      helpful: 45,
      content: '从老机器换过来，开机速度和安全解锁体验提升明显。一天不插电做 PPT 完全没问题。',
      aspects: [
        { text: '开机与解锁快', polarity: 'pos' },
        { text: '续航扎实', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p017-7',
      author: '周citing',
      rating: 3,
      created_at: '2026-06-30',
      skuSpec: '深空灰 / 16G + 512G',
      helpful: 22,
      content: '机器是好机器，就是这价位只给两个 USB-C，接显示器还得带拓展坞，希望配件再良心些。',
      aspects: [
        { text: '接口偏少', polarity: 'neg' },
        { text: '整机质感好', polarity: 'pos' },
      ],
    },
  ],

  // 声海 主动降噪无线耳机
  p033: [
    {
      id: 'rv-p033-1',
      author: '梁悠',
      rating: 5,
      created_at: '2026-09-21',
      skuSpec: '曜石黑 / 标准版',
      helpful: 187,
      content: '地铁通勤神器。开启降噪后车厢轰鸣几乎消失，42 小时总续航一周一充，戴一天耳朵也不胀。',
      aspects: [
        { text: '降噪效果强', polarity: 'pos' },
        { text: '续航持久', polarity: 'pos' },
        { text: '佩戴舒适', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p033-2',
      author: '许墨',
      rating: 5,
      created_at: '2026-09-06',
      skuSpec: '暖沙白 / 标准版',
      helpful: 121,
      content: '人声清晰，听播客比看视频电影更惊艳。通透模式过马路很实用，不用摘下来。',
      aspects: [
        { text: '人声清晰', polarity: 'pos' },
        { text: '通透模式实用', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p033-3',
      author: '范小满',
      rating: 4,
      created_at: '2026-08-27',
      skuSpec: '雾霭蓝 / 标准版',
      helpful: 66,
      content: '音质和做工都对得起价格。唯一手贱：触控区域比较灵敏，戴围巾时容易误触暂停。',
      aspects: [
        { text: '音质均衡', polarity: 'pos' },
        { text: '触控易误触', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p033-4',
      author: '崔亦',
      rating: 5,
      created_at: '2026-08-09',
      skuSpec: '曜石黑 / 标准版',
      helpful: 89,
      content: '跑步出汗也不怕，IPX5 名副其实。佩戴稳固，不会像有些半入耳那样滑出来。',
      aspects: [
        { text: '防水可靠', polarity: 'pos' },
        { text: '佩戴稳固', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p033-5',
      author: '施年',
      rating: 3,
      created_at: '2026-07-24',
      skuSpec: '雾霭蓝 / 标准版',
      helpful: 41,
      content: '降噪确实厉害，但配套 App 的 EQ 设置逻辑有点绕，第一次配对了半天才连上两台设备。',
      aspects: [
        { text: '降噪效果强', polarity: 'pos' },
        { text: 'App 不好用', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p033-6',
      author: '钟屿',
      rating: 5,
      created_at: '2026-07-12',
      skuSpec: '暖沙白 / 标准版',
      helpful: 53,
      content: '出差坐经济舱全程开着，下飞机耳朵不难受。收纳盒比我预想的小。',
      aspects: [
        { text: '佩戴舒适', polarity: 'pos' },
        { text: '收纳小巧', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p033-7',
      author: '简一',
      rating: 4,
      created_at: '2026-06-28',
      skuSpec: '曜石黑 / 标准版',
      helpful: 28,
      content: '通话降噪不错，对方听得清。冬天戴帽子会飘一点咯吱声，算是小瑕疵。',
      aspects: [
        { text: '通话清晰', polarity: 'pos' },
        { text: '冬季偶有异响', polarity: 'neg' },
      ],
    },
  ],

  // 栖木 人体工学办公椅
  p097: [
    {
      id: 'rv-p097-1',
      author: '罗砚',
      rating: 5,
      created_at: '2026-09-24',
      skuSpec: '石墨黑 / 带脚托',
      helpful: 158,
      content: '每天坐 8 小时写方案，腰托四向调节真的能找到那个支撑点，以前下午必酸的腰现在基本没感觉了。',
      aspects: [
        { text: '腰托支撑到位', polarity: 'pos' },
        { text: '久坐不累', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p097-2',
      author: '阮宁',
      rating: 5,
      created_at: '2026-09-11',
      skuSpec: '石墨黑 / 标准版',
      helpful: 103,
      content: '网背透气是买它的主要原因，夏天不开空调后背也不会闷湿。安装十分钟搞定，女生也能搬。',
      aspects: [
        { text: '网背透气', polarity: 'pos' },
        { text: '安装方便', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p097-3',
      author: '邵行',
      rating: 4,
      created_at: '2026-08-30',
      skuSpec: '石墨黑 / 带脚托',
      helpful: 71,
      content: '整体很扎实，坐感偏硬挺，喜欢软沙发感的人要适应几天。午休放脚托不错。',
      aspects: [
        { text: '结构扎实', polarity: 'pos' },
        { text: '坐感偏硬', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p097-4',
      author: '姜之久',
      rating: 5,
      created_at: '2026-08-15',
      skuSpec: '石墨黑 / 标准版',
      helpful: 62,
      content: '3D 扶手能贴合手肘，敲代码一整天肩膀不耸了。三年质保也让人放心。',
      aspects: [
        { text: '扶手调节实用', polarity: 'pos' },
        { text: '质保放心', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p097-5',
      author: '祝小满',
      rating: 4,
      created_at: '2026-07-27',
      skuSpec: '石墨黑 / 标准版',
      helpful: 37,
      content: '性价比很高。物流送货上门，但包装箱太大，拆完堆了一阳台纸壳。',
      aspects: [
        { text: '性价比高', polarity: 'pos' },
        { text: '包装体积大', polarity: 'neg' },
      ],
    },
    {
      id: 'rv-p097-6',
      author: '宋临',
      rating: 5,
      created_at: '2026-07-08',
      skuSpec: '石墨黑 / 带脚托',
      helpful: 49,
      content: '身高 185 也够用，头枕高度的余量比同价位大。后仰锁定的两档很顺手。',
      aspects: [
        { text: '身高兼容好', polarity: 'pos' },
        { text: '后仰顺滑', polarity: 'pos' },
      ],
    },
    {
      id: 'rv-p097-7',
      author: '易声',
      rating: 3,
      created_at: '2026-06-22',
      skuSpec: '石墨黑 / 标准版',
      helpful: 26,
      content: '支撑没问题，但扶手塑料件手感略一般，用力按有轻微响动，介意的话建议看下实机。',
      aspects: [
        { text: '腰托支撑到位', polarity: 'pos' },
        { text: '扶手件有异响', polarity: 'neg' },
      ],
    },
  ],
};

/** 按商品 ID 取 mock 评价；无数据时返回空数组（由上层决定是否降级）。 */
export function getMockReviews(id) {
  return PRODUCT_REVIEWS[String(id)] || [];
}
