// 入驻审核结果通知：出站队列的投递侧。
//
// 为什么是队列而不是「审核请求里直接发」：
//   1) 审核是运营的一次点击，它的结果只取决于审核本身。短信服务商抖 3 秒、
//      对方超时、对方 502，都不该让这次审核失败或变慢；
//   2) 服务商挂了之后要能重试。放在请求里就只能靠运营再点一次「通过」——
//      而那时候申请已经是终态，点不动了；
//   3) 发没发出去要能查。运营台看得到「这条排队中 / 已发送 / 未配置通道 /
//      发送失败」，而不是以为通知过了。
//
// 通道只有 webhook 一种：站内不内置任何短信/邮件 SDK。选哪家是部署方的事，
// 密钥也不该躺在应用里。配了 NOTIFY_WEBHOOK_URL 就 POST 过去，由对方的适配层
// 决定发短信还是发邮件；没配就把通知标成 skipped —— 不是「发过了」。
//
// 投递必须幂等：同一条通知重试两次会收到同样的 body，接收方按 id 去重。
import { config } from '../config.js';
import { log } from '../logger.js';
import * as merchantRepo from '../repositories/merchantRepo.js';

/** 有通道 / 没通道，运营台与健康检查都用这个判断 */
export function channelState() {
  return config.notify.webhookUrl
    ? { mode: 'webhook', ready: true }
    : { mode: 'none', ready: false, reason: '未配置 NOTIFY_WEBHOOK_URL' };
}

async function postWebhook(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.notify.timeoutMs);
  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 投递一条。
 * 返回终态字符串，方便调用方统计：sent / skipped / retry / dead。
 */
async function deliver(row) {
  const state = channelState();
  if (!state.ready) {
    // 没配通道不是失败，配置好之后也不会补发历史消息（那是运营的判断，
    // 不该由某次重启悄悄替他们决定）——所以直接落到 skipped，不再排队。
    merchantRepo.markNoticeSkipped(row.id, state.reason);
    return 'skipped';
  }
  try {
    await postWebhook({
      // 接收方按 (applicationId, noticeId) 去重：重试会重复到达
      noticeId: row.id,
      applicationId: row.application_id,
      channel: row.channel,
      targetMasked: row.target_masked,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
    });
    merchantRepo.markNoticeSent(row.id);
    return 'sent';
  } catch (e) {
    const dead = merchantRepo.markNoticeAttemptFailed(
      row.id,
      e && e.name === 'AbortError' ? 'webhook 超时' : (e && e.message) || 'unknown',
      config.notify.maxAttempts,
    );
    return dead ? 'dead' : 'retry';
  }
}

/**
 * 扫一轮队列。天生幂等：只捡 status='queued' 的行，发出去的立刻改状态，
 * 两轮并发（或多进程部署）最多是重复投递一次，不会丢消息也不会重复入队。
 */
export async function flush({ limit = 20 } = {}) {
  const rows = merchantRepo.takeQueuedNotices(limit);
  const counts = { picked: rows.length, sent: 0, skipped: 0, retry: 0, dead: 0 };
  for (const row of rows) {
    // 一条一条发，不并发打服务商：队列本来就不长，并发只会让对方的限流更难猜
    // eslint-disable-next-line no-await-in-loop
    const outcome = await deliver(row);
    counts[outcome] += 1;
    if (outcome === 'dead') {
      log.warn('notice.dead_letter', {
        noticeId: row.id,
        applicationId: row.application_id,
        channel: row.channel,
      });
    }
  }
  if (counts.picked) log.info('notice.flush', counts);
  return counts;
}

/** 给后台 worker 用的包装：任何异常只记日志，绝不冒泡到进程顶层 */
export async function flushSafely() {
  try {
    return await flush();
  } catch (e) {
    log.error('notice.flush_failed', { err: e.message });
    return null;
  }
}

export function queueStats() {
  return { ...merchantRepo.countNotices(), channel: channelState() };
}
