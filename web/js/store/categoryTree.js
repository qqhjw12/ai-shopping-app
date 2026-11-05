/**
 * categoryTree.js —— 全站分类树数据层（本步纯数据 + 工具函数，不接任何页面 UI）。
 *
 * 结构：25 个一级类目，每个一级 6–12 个二级，≥70% 的二级带 3–8 个三级。
 * 模型沿用既有 Category：{ id, name, slug, parentId, level, icon, description,
 *                          productCount, sort, children }
 *   - id/slug 全英文（禁中文 id）；二级/三级 id 由「父 id + 序号」确定性生成；
 *   - productCount：由 products.js 用真实 mock 商品数回填（叶子 = 直接挂载数，
 *     父级 = 自身 + 全部子孙），**不再写死常数、不再用哈希假数字**；
 *     未接入商品数据源时初值为 0；
 *   - icon：一级类目的细线风格占位图标名（emoji 字符，不使用实拍图片）。
 *
 * ⚠️ 页面组件禁止直接 import 本文件的任何裸数组；一律走下面导出的工具函数
 *    （getCategoryById / getChildren / getAncestors / getCategoryPath /
 *      searchCategories / getDescendantIds / productInCategory）。
 */

/* ---------------- 原始数据（紧凑 DSL）----------------
 * 每个一级：[id, 名称, 图标, 描述, [二级...]]
 * 每个二级：'名称|slug' 或 '名称|slug|三级1,三级2,…'（三级只写中文名，id/slug 自动生成）
 * 三级为空段的二级允许（覆盖率 ≥70% 由 check-web 断言兜底）。
 */
const RAW = [
  ['womenswear', '女装', '👗', '当季女装与经典衣橱单品', [
    '连衣裙|dress|长款连衣裙,短款连衣裙,吊带裙,衬衫裙,针织裙,礼服裙',
    '上衣|tops|针织衫,衬衫,T恤,吊带背心,雪纺衫',
    '裤装|pants|阔腿裤,直筒裤,牛仔裤,休闲裤,西装裤',
    '外套|coats|风衣,西装外套,羽绒服,毛呢大衣,皮衣',
    '半身裙|skirts|A字裙,百褶裙,包臀裙,长裙',
    '针织衫|knits|毛衣,开衫,马甲,高领针织',
    '衬衫|shirts|白衬衫,条纹衬衫,法式衬衫,牛津纺衬衫',
    '套装|suits|西装套装,休闲套装,运动套装',
    '大码女装|plus|大码连衣裙,大码上衣,大码裤装',
    '汉服/旗袍|hanfu|齐胸襦裙,马面裙,改良旗袍,宋制汉服',
    '泳装|swim|连体泳衣,分体泳衣,泳罩,罩衫',
  ]],
  ['menswear', '男装', '👔', '商务与休闲男装全场景', [
    'T恤|tshirt|圆领T恤,POLO衫,长袖T恤,印花T恤',
    '衬衫|shirts|休闲衬衫,商务衬衫,牛仔衬衫,法兰绒衬衫',
    '裤装|pants|休闲裤,牛仔裤,西裤,工装裤,运动裤',
    '外套|jackets|夹克,风衣,羽绒服,大衣,冲锋衣',
    '西装|suits|商务西装,修身西装,礼服,西装马甲',
    '卫衣|hoodies|连帽卫衣,套头卫衣,拉链卫衣',
    '针织衫|knits|毛衣,羊毛衫,开衫',
    '运动装|activewear|运动套装,跑步服,篮球服',
    '中式男装|chinese|唐装,盘扣上衣,亚麻套装',
    '家居服|lounge|睡衣套装,家居裤,浴袍',
  ]],
  ['lingerie', '内衣家居服', '🧵', '贴身衣物与居家舒适单品', [
    '文胸|bras|无钢圈文胸,聚拢文胸,运动文胸,睡眠文胸',
    '内裤|briefs|三角内裤,平角内裤,无痕内裤',
    '家居服|lounge|睡衣套装,珊瑚绒家居服,真丝睡裙,情侣家居服',
    '睡衣|sleepwear|真丝睡衣,纯棉睡衣,吊带睡裙',
    '保暖内衣|thermal|秋衣秋裤,加绒保暖套装,德绒内衣',
    '塑身衣|shapewear|束腰,塑身裤,连体塑身衣',
    '袜子|socks|船袜,中筒袜,丝袜,光腿神器',
    '吊带背心|camisole|纯棉吊带,蕾丝吊带,莫代尔背心',
    '秋裤|longjohns|薄款秋裤,加厚秋裤,蚕丝保暖秋裤',
  ]],
  ['shoes', '鞋靴', '👟', '从通勤皮鞋到专业跑鞋', [
    '运动鞋|sneakers|跑步鞋,篮球鞋,板鞋,老爹鞋,训练鞋',
    '休闲鞋|casual|小白鞋,乐福鞋,帆布鞋,豆豆鞋',
    '皮鞋|leather|商务皮鞋,牛津鞋,德比鞋,孟克鞋',
    '靴子|boots|切尔西靴,马丁靴,雪地靴,长筒靴',
    '高跟鞋|heels|细跟高跟鞋,粗跟鞋,猫跟鞋,防水台',
    '凉鞋|sandals|罗马凉鞋,一字带,坡跟凉鞋,拖鞋式凉鞋',
    '拖鞋|slippers|居家拖鞋,浴室拖鞋,一字拖,棉拖',
    '布鞋|cloth|老北京布鞋,千层底,功夫鞋',
    '鞋靴配件|shoe-gear|鞋垫,鞋带,鞋油,撑鞋器',
  ]],
  ['bags', '箱包', '👜', '通勤、旅行与日常收纳', [
    '女包|women|单肩包,手提包,斜挎包,托特包,腋下包',
    '男包|men|公文包,胸包,腰包,手拿包',
    '双肩包|backpack|通勤双肩包,学生书包,旅行背包,电脑包',
    '旅行箱|luggage|登机箱,托运箱,行李袋,旅行套装',
    '钱包卡包|wallets|长款钱包,短款钱包,卡包,钥匙包',
    '功能包|functional|相机包,运动腰包,防水包,骑行包',
    '母婴包|mom|妈咪包,背奶包,儿童书包',
    '箱包配件|bag-gear|行李牌,密码锁,防尘袋,内胆包',
  ]],
  ['jewelry', '珠宝配饰', '💎', '贵金属、宝石与日常配饰', [
    '项链|necklaces|锁骨链,吊坠项链,珍珠项链,毛衣链',
    '手链手镯|bracelets|银手镯,串珠手链,转运珠,红绳',
    '戒指|rings|对戒,尾戒,食指环,求婚钻戒',
    '耳饰|earrings|耳钉,耳环,耳骨夹,耳线',
    '发饰|hair|发夹,发圈,发箍,簪子',
    '胸针|brooches|珍珠胸针,复古胸针,徽章',
    '袖扣领带夹|formal|袖扣,领带夹,领结',
    '银饰玉器|silver|足银手镯,和田玉,翡翠吊坠,银锁',
  ]],
  ['watches', '钟表眼镜', '⌚', '腕表、镜架与视力健康', [
    '机械表|mechanical|正装表,潜水表,飞行员表,镂空机械',
    '石英表|quartz|商务石英,时尚石英,情侣表',
    '智能手表|smart|运动智能表,通话手表,血压手表',
    '眼镜框|frames|光学镜架,太阳镜,无框眼镜,板材架',
    '镜片|lenses|防蓝光镜片,变色镜片,近视镜片,老花镜片',
    '隐形眼镜|contact|日抛,月抛,彩色隐形,护理液',
    '怀表座钟|collectible|怀表,座钟,挂钟,机械钟',
  ]],
  ['beauty', '美妆护肤', '✨', '护肤、彩妆与美容工具', [
    '面部护肤|skincare|爽肤水,乳液面霜,精华原液,面霜,洁面',
    '眼部护理|eye|眼霜,眼部精华,眼膜',
    '唇部护理|lipcare|润唇膏,唇膜,唇部精华',
    '精华原液|serum|玻尿酸精华,烟酰胺精华,视黄醇精华,维C精华',
    '面膜|masks|贴片面膜,涂抹面膜,睡眠面膜,泥膜',
    '防晒|sunscreen|防晒霜,防晒喷雾,物理防晒,防晒棒',
    '彩妆|makeup|粉底液,口红,眼影,腮红,睫毛膏,眉笔',
    '卸妆|makeup-remover|卸妆水,卸妆油,卸妆膏,眼唇卸妆',
    '男士护理|men|男士洁面,男士水乳,男士防晒',
    '美容工具|tools|美容仪,化妆刷,粉扑,面膜碗',
  ]],
  ['fragrance', '香水香氛', '🌸', '香水、香薰与空间气味', [
    '女士香水|women|花果调香水,木质花香,甜美调,清冷调',
    '男士香水|men|木质调,馥奇调,柑橘调,皮革调',
    '中性香水|unisex|柑橘调,海洋调,茶香调,皂香调',
    '香薰蜡烛|candles|大豆蜡,椰子蜡,木质香,花香调,果香调,节日限定',
    '精油|essential-oil|单方精油,复方精油,香薰机精油,按摩精油',
    '车载香氛|car|车载出风口香薰,车载香水座,香片',
    '试香小样|samples|Q版小样,试管香水,旅行装',
    '居家香氛|home|无火香薰,藤条香薰,香薰喷雾,衣柜香片',
  ]],
  ['digital', '数码电子', '🎧', '影音娱乐与智能装备', [
    '手机通讯|mobile-devices|智能手机,功能机,手机配件',
    '电脑办公|computers|笔记本,平板,显示器,打印机',
    '影音娱乐|av|耳机,音箱,投影仪,家庭影院',
    '智能穿戴|wearables|智能手表,智能手环,AR眼镜',
    '摄影摄像|camera|微单相机,运动相机,镜头,三脚架',
    '数码配件|accessories|充电宝,数据线,充电器,手机壳,存储卡',
    '游戏设备|gaming|游戏主机,手柄,游戏耳机,键盘鼠标',
    '智能家居|smarthome|智能音箱,智能门锁,扫地机器人,智能灯',
    '电子阅读|ereader|电子书阅读器,墨水屏,阅读灯',
    '无人机|drone|航拍无人机,迷你无人机,fpv穿越机',
  ]],
  ['mobile', '手机通讯', '📱', '手机、配件与通讯服务', [
    '智能手机|phones|旗舰手机,中端手机,电竞手机,折叠屏',
    '老人机|senior|按键老人机,大屏老人机,三防机',
    '对讲机|radio|民用对讲机,车载电台,公网对讲',
    '手机配件|accessories|手机壳膜,充电宝,充电器,数据线,无线充电',
    '运营商服务|carrier|合约机,靓号,宽带套餐',
    '二手手机|used|95新,99新,官翻机',
    '维修服务|repair|换屏,换电池,主板维修',
  ]],
  ['computer', '电脑办公', '💻', '笔记本、外设与办公设备', [
    '笔记本|laptops|轻薄本,游戏本,商务本,创作者本',
    '平板|tablets|iPad,安卓平板,学习平板',
    '台式机|desktop|游戏主机,办公整机,迷你主机,一体机',
    '显示器|monitors|电竞显示器,4K显示器,带鱼屏,便携屏',
    '打印机|printers|喷墨打印机,激光打印机,标签机,扫描仪',
    '外设|peripherals|机械键盘,游戏鼠标,手写板,数位板',
    '网络设备|network|路由器,交换机,网卡,网线',
    '办公设备|office-equip|投影仪,考勤机,会议平板,碎纸机',
    '软件服务|software|办公软件,杀毒软件,云服务',
  ]],
  ['appliance', '家用电器', '🧊', '大小家电与环境电器', [
    '清洁电器|cleaning|扫地机器人,洗地机,吸尘器,蒸汽拖把',
    '厨房电器|kitchen|电饭煲,破壁机,空气炸锅,微波炉,电烤箱',
    '冰箱|fridge|双开门冰箱,多门冰箱,迷你冰箱,酒柜冰吧',
    '洗衣机|washer|滚筒洗衣机,波轮洗衣机,烘干机,洗烘套装',
    '空调|ac|壁挂空调,柜式空调,中央空调,移动空调',
    '环境电器|climate|空气净化器,加湿器,除湿机,电风扇,取暖器',
    '个护电器|personal|电吹风,电动牙刷,剃须刀,卷发棒,冲牙器',
    '生活电器|living|饮水机,电水壶,挂烫机,缝纫机',
    '厨小电|small|养生壶,电炖锅,三明治机,绞肉机',
    '电视|tv|4K电视,OLED电视,激光电视,投影电视',
  ]],
  ['smart-home', '智能家居', '🏠', '全屋智能与家庭安防', [
    '智能门锁|locks|指纹锁,密码锁,人脸识别锁,猫眼锁',
    '智能照明|lighting|智能吸顶灯,智能灯泡,灯带,智能开关',
    '智能安防|security|智能摄像头,门磁传感器,烟雾报警器,可视门铃',
    '智能音箱|speakers|带屏音箱,智能音箱,语音遥控器',
    '清洁机器人|robot|扫拖一体,拖地机器人,擦窗机器人',
    '智能窗帘|curtain|电动窗帘,窗帘电机,轨道配件',
    '智能家电|smart-appliance|智能冰箱,智能洗碗机,智能烤箱',
    '全屋智能|whole-home|智能网关,智能家居套装,中控屏',
  ]],
  ['food', '食品生鲜', '🍚', '零食、生鲜与地方风味', [
    '休闲零食|snacks|薯片膨化,肉干肉脯,海味零食,辣条',
    '坚果炒货|nuts|混合坚果,瓜子,花生,夏威夷果',
    '饼干糕点|bakery|曲奇,蛋糕,面包,苏打饼干',
    '糖果巧克力|candy|黑巧克力,软糖,硬糖,棒棒糖',
    '方便速食|instant|方便面,自热火锅,速食粥,螺蛳粉',
    '粮油调味|condiment|大米,食用油,酱油醋,火锅底料',
    '生鲜水果|fresh|时令水果,进口水果,叶菜,菌菇',
    '肉类水产|meat|牛羊肉,猪肉,海鲜水产,虾仁',
    '乳品饮料|dairy|鲜牛奶,酸奶,奶酪,果蔬汁',
    '地方特产|specialty|辣味特产,糕点特产,干货山珍',
  ]],
  ['wine-tea', '酒水茶饮', '🍵', '酒类、茶叶与冲调饮品', [
    '白酒|baijiu|酱香型,浓香型,清香型,礼盒装',
    '红酒葡萄酒|wine|干红,干白,起泡酒,桃红',
    '洋酒|spirits|威士忌,白兰地,伏特加,利口酒',
    '啤酒|beer|精酿啤酒,工业啤酒,果啤,无醇啤酒',
    '黄酒米酒|rice-wine|绍兴黄酒,糯米酒,青梅酒',
    '茶叶|tea|绿茶,红茶,乌龙茶,白茶,普洱',
    '茶具冲饮|tea-set|紫砂壶,盖碗,公道杯,茶包',
    '咖啡饮品|coffee|咖啡豆,挂耳咖啡,咖啡液,速溶咖啡',
  ]],
  ['mother-baby', '母婴用品', '🍼', '从孕期到幼儿的全段养育', [
    '奶粉|formula|一段奶粉,二段奶粉,儿童奶粉,有机奶粉',
    '辅食|baby-food|米粉,果泥,磨牙饼干,儿童面条',
    '尿裤|diapers|纸尿裤,拉拉裤,成长裤,湿巾',
    '喂养用品|feeding|奶瓶,安抚奶嘴,吸奶器,消毒锅',
    '洗护用品|care|婴儿洗发沐浴,护臀膏,婴儿面霜,痱子水',
    '婴儿车床|gear|婴儿推车,安全座椅,婴儿床,餐椅',
    '孕妈用品|maternity|孕妇装,防妊娠纹,待产包,孕妇奶粉',
    '玩具早教|early-learning|布书,摇铃,早教机,爬行垫',
    '婴儿服饰|baby-clothes|连体衣,和尚服,婴儿袜,胎帽',
  ]],
  ['kids-toys', '童装玩具', '🧸', '童装童鞋与全龄玩具', [
    '童装|clothing|男童装,女童装,婴幼儿服装,亲子装',
    '童鞋|shoes|学步鞋,运动童鞋,凉鞋童靴',
    '积木拼插|blocks|颗粒积木,大颗粒,磁力片,拼图',
    '遥控电动|rc|遥控车,遥控飞机,电动火车',
    '毛绒安抚|plush|毛绒玩具,安抚玩偶,抱枕娃娃',
    '益智早教|educational|科学实验,编程机器人,数独棋盘,识字卡',
    '户外玩具|outdoor|滑板车,儿童自行车,泡泡机,戏水玩具',
    '潮玩手办|figures|盲盒,手办,模型,卡牌',
    '桌游棋牌|board|儿童桌游,飞行棋,国际象棋,五子棋',
  ]],
  ['sports', '运动户外', '🏕️', '运动装备与户外场景', [
    '运动服饰|apparel|跑步T恤,运动裤,瑜伽服,泳装,骑行服',
    '运动配件|gear|运动袜,护膝护腕,运动手套,空顶帽',
    '露营装备|camping|帐篷,睡袋,露营灯,天幕,折叠桌椅',
    '徒步登山|hiking|登山包,登山杖,冲锋衣,徒步鞋',
    '跑步|running|跑鞋,运动腰包,跑步耳机,运动水壶',
    '球类|balls|篮球,足球,羽毛球拍,乒乓球拍,网球拍',
    '骑行|cycling|公路车,山地车,骑行头盔,骑行服',
    '水上运动|water|浮潜装备,游泳圈,桨板,救生衣',
    '垂钓|fishing|鱼竿,鱼线,鱼饵,渔具箱',
    '轮滑滑板|skating|滑板,轮滑鞋,护具套装',
  ]],
  ['fitness', '健身器材', '🏋️', '家用与商用训练器械', [
    '有氧器械|cardio|跑步机,椭圆机,动感单车,划船机',
    '力量训练|strength|哑铃,杠铃,壶铃,卧推架,龙门架',
    '瑜伽普拉提|yoga|瑜伽垫,瑜伽球,弹力带,泡沫轴',
    '护具恢复|protection|护腰,筋膜枪,肌贴,按摩轴',
    '体能训练|conditioning|跳绳,战绳,敏捷梯,握力器',
    '健身服饰|apparel|健身服,运动内衣,健身手套',
    '营养补剂|nutrition|蛋白粉,肌酸,左旋肉碱,维生素',
  ]],
  ['auto-parts', '汽车用品', '🚗', '车内车外与养护应急', [
    '车载电子|electronics|行车记录仪,车载充电器,车载冰箱,导航仪',
    '内饰用品|interior|座垫脚垫,方向盘套,挂件,收纳袋',
    '外部改装|exterior|车贴,行李架,车顶箱,轮毂盖',
    '清洗养护|care|洗车水枪,车蜡,玻璃水,镀膜剂',
    '安全应急|safety|灭火器,安全锤,胎压计,三角架',
    '儿童安全|kids|儿童安全座椅,增高垫,车载遮阳帘',
    '机油养护|maintenance|机油,机滤,空滤,防冻液',
    '摩托装备|moto|头盔,骑行服,摩托手套,护具',
    '车载舒适|comfort|车载床垫,遮阳挡,颈枕腰靠',
  ]],
  ['pet', '宠物用品', '🐾', '猫狗主粮、用品与洗护', [
    '猫粮|cat-food|幼猫粮,成猫粮,老年猫粮,处方粮,冻干粮,湿粮罐头',
    '狗粮|dog-food|幼犬粮,成犬粮,老年犬粮,处方粮,冻干粮',
    '宠物零食|treats|猫条,肉干,磨牙棒,冻干零食',
    '猫砂|litter|膨润土猫砂,豆腐猫砂,混合猫砂,松木猫砂',
    '宠物玩具|toys|逗猫棒,漏食球,咬胶,激光笔',
    '宠物服饰|apparel|宠物雨衣,秋冬衣服,圣诞装扮,宠物鞋',
    '宠物窝垫|beds|猫窝,狗窝,垫子,猫爬架',
    '出行牵引|travel|牵引绳,猫包,航空箱,胸背带',
    '洗护美容|grooming|宠物香波,梳子,指甲剪,吹水机',
    '医疗保健|health|驱虫药,益生菌,营养膏,体检套餐',
  ]],
  ['books-culture', '图书文创', '📚', '阅读、手账与文创周边', [
    '文学小说|fiction|当代小说,外国文学,悬疑推理,科幻小说',
    '少儿读物|kids|绘本,儿童文学,科普百科,桥梁书',
    '人文社科|humanities|历史,哲学,心理学,社会学',
    '经管励志|business|管理学,投资理财,人物传记,自我成长',
    '艺术设计|art|绘画教程,摄影集,设计书,书法碑帖',
    '文创手账|creative|手账本,和纸胶带,印章,文创周边',
    '礼品书|gifts|礼盒装,精装典藏,签名本',
    '期刊杂志|magazines|文学期刊,财经杂志,漫画志',
  ]],
  ['stationery', '办公文具', '✏️', '书写、纸品与办公耗材', [
    '书写工具|writing|中性笔,钢笔,圆珠笔,荧光笔,毛笔',
    '本册纸品|paper|笔记本,活页本,便签纸,信纸信封',
    '学生文具|student|文具盒,削笔机,尺子,橡皮,书包',
    '桌面收纳|desk|笔筒,文件架,桌面收纳盒,标签机',
    '办公耗材|consumables|打印纸,色带碳粉,装订夹,档案盒',
    '财务用品|finance|点钞机,票据夹,账本,计算器',
    '美术用品|art|素描铅笔,水彩颜料,画板画架,马克笔',
    '印章证书|seal|印章印泥,证书制作,奖状,请柬',
  ]],
  ['music', '乐器音响', '🎹', '乐器、音响与录音设备', [
    '键盘乐器|keyboard|电钢琴,电子琴,合成器,手卷钢琴',
    '弦乐器|strings|吉他,尤克里里,小提琴,大提琴,贝斯',
    '打击乐器|percussion|架子鼓,电子鼓,卡宏鼓,非洲鼓',
    '管乐器|wind|口琴,萨克斯,长笛,小号',
    '民族乐器|chinese|古筝,二胡,琵琶,笛子,唢呐',
    '音响设备|audio|蓝牙音箱,回音壁,hifi音响,功放',
    'DJ制作|dj|DJ控制器,MIDI键盘,声卡,监听耳机',
    '乐器配件|gear|琴弦,拨片,谱架,调音器,琴包',
  ]],
];

/* ---------------- 构建（productCount 由商品数据源回填） ----------------
 * 本文件不再生成任何假计数：productCount 初值恒为 0，
 * 由 products.js 加载后调用 setCategoryProductCounts() 写入真实值。 */

function buildTree() {
  const top = RAW.map(([id, name, icon, description, subs]) => {
    const l1 = {
      id, name,
      slug: id,
      parentId: null,
      level: 1,
      icon,
      description,
      productCount: 0,
      sort: 0,
      children: subs.map((line, si) => {
        const [sName, sSlug, third] = String(line).split('|');
        const l2Id = `${id}_${String(si + 1).padStart(2, '0')}`;
        const l2 = {
          id: l2Id,
          name: sName,
          slug: sSlug || l2Id,
          parentId: id,
          level: 2,
          icon: '',
          description: '',
          productCount: 0,
          sort: si + 1,
          children: third
            ? third.split(',').map((tName, ti) => {
                const tId = `${l2Id}_t${ti + 1}`;
                return {
                  id: tId,
                  name: tName,
                  slug: `${sSlug || l2Id}-t${ti + 1}`,
                  parentId: l2Id,
                  level: 3,
                  icon: '',
                  description: '',
                  productCount: 0, // 由 setCategoryProductCounts 回填
                  sort: ti + 1,
                  children: [],
                };
              })
            : [],
        };
        // 二级计数由 setCategoryProductCounts 回填（此处保持 0，不写假数字）
        return l2;
      }),
    };
    // 一级计数同样由 setCategoryProductCounts 回填
    l1.sort = 0;
    return l1;
  });
  top.forEach((c, i) => { c.sort = i + 1; });
  return top;
}

export const CATEGORY_TREE = buildTree();

/**
 * 用真实商品计数回填全树 productCount（不再使用哈希假数字）。
 * @param {Map<string, number>} directCounts 节点 id → 直接挂在该节点的商品数
 * 叶子 = 直接挂载数；父级 = 自身直接数 + Σ 子节点完整子树计数，
 * 与 getProductsByCategory(id, { includeDescendants: true }) 口径完全一致。
 * 依赖方向保持单向：products.js → categoryTree.js，本文件不反向 import。
 */
export function setCategoryProductCounts(directCounts) {
  const counts = directCounts instanceof Map
    ? directCounts
    : new Map(Object.entries(directCounts || {}));
  const apply = (nodes) => nodes.reduce((sum, n) => {
    const childSum = apply(n.children || []);
    n.productCount = (counts.get(n.id) || 0) + childSum;
    return sum + n.productCount;
  }, 0);
  apply(CATEGORY_TREE);
}

/** 扁平索引（模块内部用；页面请走工具函数，勿直接 import 裸数组） */
const INDEX = new Map();
(function indexTree(nodes) {
  for (const n of nodes) {
    INDEX.set(n.id, n);
    if (n.children.length) indexTree(n.children);
  }
})(CATEGORY_TREE);

/* ---------------- 工具函数（页面唯一的消费入口）---------------- */

/** 按 id 取分类节点（含各级）；未命中返回 null */
export function getCategoryById(id) {
  return INDEX.get(id) || null;
}

/** 直接子级（一级入参传 null/undefined 时返回全部一级） */
export function getChildren(parentId) {
  if (!parentId) return CATEGORY_TREE;
  const node = INDEX.get(parentId);
  return node ? node.children : [];
}

/** 祖先链（直接父 → 根），一级返回 [] */
export function getAncestors(id) {
  const chain = [];
  let node = INDEX.get(id);
  while (node && node.parentId) {
    const parent = INDEX.get(node.parentId);
    if (!parent) break;
    chain.push(parent);
    node = parent;
  }
  return chain;
}

/** 面包屑路径：根 → 自身（含自身） */
export function getCategoryPath(id) {
  return [...getAncestors(id).reverse(), ...(INDEX.has(id) ? [INDEX.get(id)] : [])];
}

/** 关键词搜索分类（名称包含即可，含三级；返回节点数组） */
export function searchCategories(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const hits = [];
  for (const n of INDEX.values()) {
    if (n.name.toLowerCase().includes(kw) || n.slug.toLowerCase().includes(kw)) hits.push(n);
  }
  return hits;
}

/** 一级/任意节点下的全部子孙 id（不含自身）——用于「查一级含全部子孙商品」 */
export function getDescendantIds(id) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      out.push(c.id);
      walk(c);
    }
  };
  const root = INDEX.get(id);
  if (root) walk(root);
  return out;
}

/** 节点自身 + 全部子孙 id */
export function getCategoryAndDescendantIds(id) {
  return INDEX.has(id) ? [id, ...getDescendantIds(id)] : [];
}

/* ---------------- 与既有商品数据的兼容桥 ----------------
 * 旧种子商品只有 16 个一级类目（phone/computer/audio/…）与 17 个二级类目
 * （beauty_skincare、book_read、food_snack …），这些 id 在新树里都不存在。
 * 新树是 25 个一级，这里把旧 id 映射到新树节点（过渡方案）：
 *   - 一级：语义重合的直接继承旧 id（computer/appliance/food/sports/pet/stationery），
 *     其余映射到最贴近的新树一级（如 phone→手机通讯、audio→数码电子）；
 *   - 二级：映射到新树的二级/三级节点，让真实商品真正「挂在子孙分类上」，
 *     而不只是靠一级别名硬命中——否则按二级/三级查询会查不到任何真实商品。
 * 后续真实商品数据回填时，商品将直接携带新树 categoryId，本表可整体下线。
 */
export const LEGACY_CATEGORY_ALIASES = {
  phone: ['mobile', 'digital'],
  computer: ['computer'],
  audio: ['digital'],
  appliance: ['appliance'],
  apparel: ['womenswear'],
  food: ['food'],
  home: ['smart-home'],
  baby: ['mother-baby'],
  book: ['books-culture', 'music'],
  kitchen: ['appliance'],
  pet: ['pet'],
  auto: ['auto-parts'],
  health: ['beauty'],
  stationery: ['stationery'],
  sports: ['sports'],
};

/** 旧二级类目 → 新树子孙节点（真实演示商品 17 个 subCategoryId 全覆盖）。
 *  一二级语义不完全等价时取最贴近节点，可映射到多个节点。 */
export const LEGACY_SUBCATEGORY_ALIASES = {
  // 图书文创（旧 book）
  book_read: ['books-culture_01'],          // 阅读 → 文学小说
  book_hobby: ['books-culture_06'],         // 兴趣爱好 → 文创手账
  book_instrument: ['music', 'music_01'],   // 乐器 → 乐器音响 / 键盘乐器
  // 食品生鲜（旧 food）
  food_drink: ['food_09'],                  // 饮品 → 乳品饮料
  food_grain: ['food_06'],                  // 粮油 → 粮油调味
  food_snack: ['food_01'],                  // 零食 → 休闲零食
  // 美妆护肤（旧 beauty）
  beauty_personal: ['beauty_01', 'beauty_10'], // 个护 → 面部护肤 / 美容工具
  beauty_skincare: ['beauty_01'],           // 护肤 → 面部护肤
  beauty_makeup: ['beauty_07'],             // 彩妆 → 彩妆
  // 宠物用品（旧 pet）
  pet_cat: ['pet_01', 'pet_04'],            // 猫 → 猫粮 / 猫砂
  pet_dog: ['pet_02'],                      // 狗 → 狗粮
  pet_accessory: ['pet_05', 'pet_06'],      // 配件 → 玩具 / 服饰
  // 母婴用品（旧 baby）
  baby_care: ['mother-baby_05'],            // 护理 → 洗护用品
  baby_milk: ['mother-baby_01'],            // 奶粉 → 奶粉
  // 健康（25 一级中无保健类，暂归美妆个护一级；真实回填后下线）
  health_supplement: ['beauty'],
  // 数码（旧 phone）
  phone_wear: ['digital_04'],               // 穿戴 → 智能穿戴
  // 服饰（旧 apparel，鞋类实属鞋靴一级）
  apparel_shoe: ['shoes_01'],               // 鞋 → 运动鞋
};

/** 商品归属的新树 id 集合：自身类目 ∪ 一级别名 ∪ 二级别名。 */
function ownedCategoryIds(product) {
  return new Set(
    [
      product.categoryId,
      product.subCategoryId,
      ...(LEGACY_CATEGORY_ALIASES[product.categoryId] || []),
      ...(LEGACY_SUBCATEGORY_ALIASES[product.subCategoryId] || []),
    ].filter(Boolean),
  );
}

/**
 * 商品是否属于某分类（含全部子孙）。
 * 命中面 = 商品归属 id 集合 ∩「目标节点自身 ∪ 全部子孙」，
 * 因此按一级查询会自动包含挂在任意二级/三级分类下的商品。
 */
export function productInCategory(product, catId) {
  if (!product || !INDEX.has(catId)) return false;
  const owned = ownedCategoryIds(product);
  return getCategoryAndDescendantIds(catId).some((id) => owned.has(id));
}

/** 按一级（或任意节点）批量查询商品，自动包含全部子孙分类商品。
 *  页面接入分类筛选时应走这里，而不是自己遍历一维数组。 */
export function filterProductsByCategory(products, catId) {
  const list = Array.isArray(products) ? products : [];
  if (!INDEX.has(catId)) return [];
  return list.filter((p) => productInCategory(p, catId));
}
