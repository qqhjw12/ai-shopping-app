// 入驻结果通知模板：默认文案、变量校验、渲染、预览。
//
// 模板是**运营写给商家看的话**，所以三件事必须做到：
//   1) 变量有白名单。模板会拼进外发文案，写错一个变量名，等于给所有商家
//      发一条「{{conpany}} 已通过审核」——发出去就收不回来了。
//   2) 渲染时机在「排通知」那一刻，不是发送时。队列里存的是渲染后的成品，
//      运营改模板只影响此后新排的通知，已排队的那条不会被悄悄改写。
//      这也是「改完立即生效」与「已发出去的不能变」之间的正确切法。
//   3) 通道可以单独关。法务说「短信先别发」就关短信，邮件照旧——
//      而不是把整条通知停掉（商家手里还有一条回执）。
//
// 默认文案刻意保持不变量之外的零逻辑：空备注的兜底（比如通过时没写说明）
// 在 render 之前就补好，模板里只写 {{note}}。模板一旦带上条件判断，
// 运营改一个字符就可能改出语法错，而他们没有地方运行它。
import * as repo from '../repositories/noticeTemplateRepo.js';

export const TEMPLATE_VARS = ['company', 'id', 'brand', 'contact', 'note', 'statusLabel'];

export const TEMPLATE_STATUSES = ['approved', 'rejected', 'withdrawn'];
export const TEMPLATE_CHANNELS = ['sms', 'email'];

const STATUS_LABEL = { approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
const CHANNEL_LABEL = { sms: '短信', email: '邮件' };

// 备注为空时补的话。放在这里而不是模板里：模板不该有条件逻辑（见文件顶部第 3 条）。
const NOTE_FALLBACK = {
  approved: '我们会通过你登记的联系方式联系你，完成签约与开店配置。',
  rejected: '未填写具体原因，可回复本消息或联系招商同学了解详情。',
  withdrawn: '如需重新入驻，随时可以再提交一份申请。',
};

const DEFAULT_TEMPLATES = {
  'approved:sms': {
    subject: '',
    body: '【MAISON 商家入驻】{{company}}（{{id}}）已通过审核。{{note}}',
  },
  'approved:email': {
    subject: '{{id}} 入驻审核结果：已通过',
    body: '{{contact}} 你好：\n\n{{company}}（品牌 {{brand}}）的入驻申请 {{id}} 已通过审核。\n{{note}}\n\n—— MAISON 商家运营',
  },
  'rejected:sms': {
    subject: '',
    body: '【MAISON 商家入驻】{{company}}（{{id}}）未通过审核。原因：{{note}}。补充材料后可以重新提交申请。',
  },
  'rejected:email': {
    subject: '{{id}} 入驻审核结果：需要补充材料',
    body: '{{contact}} 你好：\n\n{{company}}（品牌 {{brand}}）的入驻申请 {{id}} 未通过本次审核。\n原因：{{note}}\n\n补充材料后可以重新提交申请；如有疑问可直接回复本邮件。\n\n—— MAISON 商家运营',
  },
  'withdrawn:sms': {
    subject: '',
    body: '【MAISON 商家入驻】{{company}}（{{id}}）的入驻申请已按你的要求撤回。{{note}}',
  },
  'withdrawn:email': {
    subject: '{{id}} 入驻申请已撤回',
    body: '{{contact}} 你好：\n\n{{company}}（品牌 {{brand}}）的入驻申请 {{id}} 已撤回，平台不再继续审核。\n{{note}}\n\n—— MAISON 商家运营',
  },
};

export const templateId = (status, channel) => `${status}:${channel}`;

const DEFAULT_LIMITS = { body: 400, subject: 60, smsBody: 200 };

/** 默认模板 + 库里的覆盖项，合并成「当前生效」的视图 */
export function list() {
  const overrides = new Map(repo.listTemplates().map((t) => [t.id, t]));
  const items = [];
  for (const status of TEMPLATE_STATUSES) {
    for (const channel of TEMPLATE_CHANNELS) {
      const id = templateId(status, channel);
      const def = DEFAULT_TEMPLATES[id] || { subject: '', body: '' };
      const ov = overrides.get(id);
      items.push({
        id,
        status,
        statusLabel: STATUS_LABEL[status],
        channel,
        channelLabel: CHANNEL_LABEL[channel],
        subject: ov ? ov.subject : def.subject,
        body: ov ? ov.body : def.body,
        enabled: ov ? ov.enabled : true,
        customized: Boolean(ov),
        defaultSubject: def.subject,
        defaultBody: def.body,
        updatedBy: ov ? ov.updatedBy : '',
        updatedAt: ov ? ov.updatedAt : null,
      });
    }
  }
  return { items, variables: TEMPLATE_VARS, limits: DEFAULT_LIMITS };
}

export function get(id) {
  return list().items.find((t) => t.id === id) || null;
}

/** 找出模板里用到但不存在的变量：{{foo}} → foo。用于保存前拦截，也用于预览提示。 */
function unknownVars(text) {
  const out = new Set();
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let m = re.exec(text);
  while (m) {
    if (!TEMPLATE_VARS.includes(m[1])) out.add(m[1]);
    m = re.exec(text);
  }
  return [...out];
}

/**
 * 校验并保存。返回 warnings（不阻断）——比如短信超出一个计费段，
 * 是「你确定要这么长吗」，不是「不能这么写」。
 */
export function save(id, payload = {}, actor = 'admin') {
  const target = get(id);
  if (!target) throw Object.assign(new Error('模板不存在'), { status: 404 });

  const subject = String(payload.subject == null ? target.subject : payload.subject).trim();
  const body = String(payload.body == null ? target.body : payload.body).trim();
  const enabled = payload.enabled == null ? target.enabled : Boolean(payload.enabled);

  const fields = {};
  if (!body) fields.body = '通知正文不能为空';
  else if (body.length > DEFAULT_LIMITS.body) fields.body = `正文不能超过 ${DEFAULT_LIMITS.body} 字`;
  if (target.channel === 'email') {
    if (!subject) fields.subject = '邮件主题不能为空';
    else if (subject.length > DEFAULT_LIMITS.subject) fields.subject = `主题不能超过 ${DEFAULT_LIMITS.subject} 字`;
  }
  if (Object.keys(fields).length) {
    throw Object.assign(new Error('请检查模板内容'), { status: 400, fields });
  }

  const badVars = [...new Set([...unknownVars(body), ...unknownVars(subject)])];
  if (badVars.length) {
    throw Object.assign(
      new Error(`模板里有不认识的变量：${badVars.map((v) => `{{${v}}}`).join('、')}`),
      { status: 400, fields: { body: `可用变量：${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(' ')}` } },
    );
  }

  const warnings = [];
  if (target.channel === 'sms' && body.length > DEFAULT_LIMITS.smsBody) {
    warnings.push(`短信正文 ${body.length} 字，超过 ${DEFAULT_LIMITS.smsBody} 字会按多条计费`);
  }

  repo.saveTemplate({
    id,
    status: target.status,
    channel: target.channel,
    subject: target.channel === 'email' ? subject : '',
    body,
    enabled,
    by: actor,
  });
  return { template: get(id), warnings };
}

/** 恢复默认：删覆盖行。删了 0 行也是成功（本来就用默认） */
export function reset(id) {
  const target = get(id);
  if (!target) throw Object.assign(new Error('模板不存在'), { status: 404 });
  const removed = repo.deleteTemplate(id);
  return { template: get(id), removed: removed > 0 };
}

/** 变量填充。缺的值一律替换成空串，绝不留 {{x}} 给商家看 */
export function fill(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}

/** 一条申请的模板变量 */
export function varsOf(app, note = '') {
  const status = app.status;
  return {
    company: app.company || '',
    id: app.id || '',
    brand: app.brand || '',
    contact: app.contact || '',
    note: String(note || '').trim() || NOTE_FALLBACK[status] || '',
    statusLabel: STATUS_LABEL[status] || status,
  };
}

/**
 * 渲染某条状态下的全部通知（每个启用的通道一条）。
 * 收件人打码在此完成——库里本来就不该出现完整手机号/邮箱。
 */
export function renderFor(status, app, note = '', maskers = {}) {
  const vars = varsOf({ ...app, status }, note);
  const items = list().items;
  const out = [];
  for (const t of items) {
    if (t.status !== status || !t.enabled) continue;
    if (t.channel === 'sms') {
      if (!app.phone) continue;
      out.push({
        channel: 'sms',
        targetMasked: maskers.phone ? maskers.phone(app.phone) : '',
        subject: '',
        body: fill(t.body, vars),
      });
    } else {
      if (!app.email) continue;
      out.push({
        channel: 'email',
        targetMasked: maskers.email ? maskers.email(app.email) : '',
        subject: fill(t.subject, vars),
        body: fill(t.body, vars),
      });
    }
  }
  return out;
}

const SAMPLE = {
  id: 'MA202610310001',
  status: 'approved',
  company: '杭州砚白设计有限公司',
  brand: '砚白 YANBAI',
  contact: '周砚',
};

/**
 * 预览：用真实申请（可选）或内置样例渲染，不落库、不排队。
 * body / subject 可以覆盖已保存的模板——运营在编辑框里改完想看效果，
 * 不应该被要求「先保存再看」（保存是一个有副作用的动作，预览不是）。
 */
export function preview(id, { app = null, note = '', body: bodyOverride, subject: subjectOverride } = {}) {
  const target = get(id);
  if (!target) throw Object.assign(new Error('模板不存在'), { status: 404 });
  const base = app || SAMPLE;
  const vars = varsOf({ ...base, status: target.status }, note);
  const rawBody = bodyOverride == null ? target.body : String(bodyOverride);
  const rawSubject = subjectOverride == null ? target.subject : String(subjectOverride);
  const body = fill(rawBody, vars);
  const warnings = [];
  if (target.channel === 'sms' && body.length > DEFAULT_LIMITS.smsBody) {
    warnings.push(`预览 ${body.length} 字，超过 ${DEFAULT_LIMITS.smsBody} 字会按多条计费`);
  }
  return {
    id,
    channel: target.channel,
    channelLabel: target.channelLabel,
    subject: target.channel === 'email' ? fill(rawSubject, vars) : '',
    body,
    sample: !app,
    warnings,
  };
}
