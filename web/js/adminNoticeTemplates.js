// 运营侧「通知模板」页（#/admin/notice-templates）。
//
// 这一页解决的是一个很具体的问题：审核结果发出去的那段话，以前写在代码里。
// 法务要加一句「最终解释权」、招商想把「3 个工作日」换成「48 小时」，
// 都得改代码、发版、走评审——于是所有商家就一直在收那段旧文案。
//
// 三条页面级约定：
//   1) 变量用**可点的胶囊**插入，而不是让人背 {{company}}。模板里写错一个字母，
//      发出去就是一条「{{conpany}} 已通过」给全部商家，收不回来；
//   2) 预览用编辑框里的当前内容（不是已保存的版本）：改完先看，再决定存不存。
//      保存是有副作用的动作，不该被当成「查看效果」的必经步骤；
//   3) 关通道（enabled=false）比删模板安全：法务说「短信先别发」，关掉即可，
//      邮件照旧；恢复时不用重新写一遍文案。
import { api } from './api.js';
import { el, loading, toast } from './ui.js';
import {
  adminHeaders,
  adminKeyGate,
  adminTabs,
  clearAdminIdentity,
  fmtStamp,
  isKeyRejected,
  readAdminActor,
  readAdminKey,
} from './adminShared.js';

const STATUS_INTRO = {
  approved: '审核通过时发给商家的话。空备注会补一句「我们会联系你完成签约」。',
  rejected: '驳回时发给商家的话。审核意见会填进 {{note}}，一定要让商家知道缺什么。',
  withdrawn: '商家自己撤回后发的回执。这条是确认，不是结果——语气别像拒绝。',
};

async function fetchTemplates() {
  return api('/api/merchant/notice-templates', { headers: adminHeaders(), retries: 0 });
}

async function putTemplate(id, payload) {
  return api(`/api/merchant/notice-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: payload,
    retries: 0,
  });
}

async function resetTemplate(id) {
  return api(`/api/merchant/notice-templates/${encodeURIComponent(id)}/reset`, {
    method: 'POST',
    headers: adminHeaders(),
    retries: 0,
  });
}

async function previewTemplate(id, payload) {
  return api(`/api/merchant/notice-templates/${encodeURIComponent(id)}/preview`, {
    method: 'POST',
    headers: adminHeaders(),
    body: payload,
    retries: 0,
  });
}

/* ============================================================
   单张模板卡
   ============================================================ */

function templateCard(t, { variables, limits, onChanged }) {
  const isEmail = t.channel === 'email';
  const subjectInput = isEmail
    ? el('input', { class: 'mzt-input', type: 'text', value: t.subject, maxlength: String(limits.subject) })
    : null;
  const bodyInput = el('textarea', { class: 'mzt-input mzt-body', rows: isEmail ? '6' : '3', maxlength: String(limits.body) });
  bodyInput.value = t.body;

  const counter = el('span', { class: 'mzt-count' });
  const syncCount = () => {
    const n = bodyInput.value.length;
    counter.textContent = isEmail
      ? `${n} / ${limits.body} 字`
      : `${n} 字${n > limits.smsBody ? `（超过 ${limits.smsBody} 字按多条计费）` : ''}`;
    counter.classList.toggle('is-over', isEmail ? n > limits.body : n > limits.smsBody);
  };
  syncCount();
  bodyInput.addEventListener('input', syncCount);

  // 变量胶囊：点一下插到光标处（不是追加到末尾——追加会把句子插断）
  const insert = (token) => {
    const start = bodyInput.selectionStart ?? bodyInput.value.length;
    const end = bodyInput.selectionEnd ?? bodyInput.value.length;
    bodyInput.value = `${bodyInput.value.slice(0, start)}${token}${bodyInput.value.slice(end)}`;
    bodyInput.focus();
    bodyInput.selectionStart = bodyInput.selectionEnd = start + token.length;
    syncCount();
  };
  const chips = el('div', { class: 'mzt-vars' }, [
    el('span', { class: 'mzt-vars-label' }, '插入变量'),
    ...variables.map((v) => el('button', {
      class: 'mzt-var',
      type: 'button',
      title: `插入 {{${v}}}`,
      onclick: () => insert(`{{${v}}}`),
    }, `{{${v}}}`)),
  ]);

  const previewBox = el('div', { class: 'mzt-preview', hidden: true });
  const err = el('p', { class: 'mzt-error', role: 'alert' });
  const enabled = el('input', { type: 'checkbox', checked: t.enabled });
  const state = el('span', { class: `mzt-state${t.customized ? ' is-custom' : ''}` },
    t.customized ? '已自定义' : '使用默认');

  const saveBtn = el('button', { class: 'adm-btn', type: 'submit' }, '保存');
  const previewBtn = el('button', { class: 'adm-line-btn', type: 'button' }, '预览效果');
  const resetBtn = el('button', { class: 'adm-line-btn', type: 'button' }, '恢复默认');

  previewBtn.addEventListener('click', async () => {
    err.textContent = '';
    previewBtn.disabled = true;
    try {
      const r = await previewTemplate(t.id, {
        body: bodyInput.value,
        ...(isEmail ? { subject: subjectInput.value } : {}),
      });
      previewBox.hidden = false;
      previewBox.innerHTML = '';
      // 一律走数组 + filter：原生 append(null) 会渲染出字面量 "null"
      previewBox.append(...[
        el('span', { class: 'mzt-preview-label' }, r.sample ? '预览（示例数据）' : '预览'),
        r.subject ? el('strong', { class: 'mzt-preview-subject' }, r.subject) : null,
        el('p', { class: 'mzt-preview-body' }, r.body),
        ...(r.warnings || []).map((w) => el('p', { class: 'mzt-warn' }, w)),
      ].filter(Boolean));
    } catch (e) {
      err.textContent = (e && e.message) || '预览失败';
    } finally {
      previewBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async () => {
    if (!t.customized) {
      toast('这张模板本来就是默认文案', 'warn');
      return;
    }
    resetBtn.disabled = true;
    try {
      const r = await resetTemplate(t.id);
      toast('已恢复默认文案', 'ok');
      if (onChanged) onChanged(r);
    } catch (e) {
      toast((e && e.message) || '恢复失败', 'warn');
    } finally {
      resetBtn.disabled = false;
    }
  });

  const form = el('form', { class: 'mzt-card-form' }, [
    isEmail ? el('label', { class: 'mzt-label' }, '邮件主题') : null,
    isEmail ? subjectInput : null,
    el('label', { class: 'mzt-label' }, '正文'),
    bodyInput,
    el('div', { class: 'mzt-meta' }, [counter, el('span', { class: 'mzt-state-wrap' }, state)]),
    chips,
    el('label', { class: 'mzt-toggle' }, [enabled, el('span', {}, isEmail ? '启用邮件通知' : '启用短信通知')]),
    err,
    el('div', { class: 'mzt-actions' }, [saveBtn, previewBtn, resetBtn]),
    previewBox,
  ].filter(Boolean));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const r = await putTemplate(t.id, {
        body: bodyInput.value,
        enabled: enabled.checked,
        ...(isEmail ? { subject: subjectInput.value } : {}),
      });
      toast((r.warnings && r.warnings[0]) || '模板已保存，新排队的通知按新文案发送', r.warnings && r.warnings.length ? 'warn' : 'ok');
      if (onChanged) onChanged(r);
    } catch (e) {
      const first = e && e.fields ? Object.values(e.fields)[0] : '';
      err.textContent = first || (e && e.message) || '保存失败';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });

  return el('article', { class: `mzt-card${t.enabled ? '' : ' is-off'}`, 'data-template': t.id }, [
    el('div', { class: 'mzt-card-head' }, [
      el('div', {}, [
        el('strong', { class: 'mzt-channel' }, t.channelLabel),
        el('span', { class: 'mzt-updated' }, t.customized ? `最后修改 ${fmtStamp(t.updatedAt)} · ${t.updatedBy || '—'}` : '未修改过'),
      ]),
      el('span', { class: `adm-status s-${t.enabled ? 'approved' : 'withdrawn'}` }, t.enabled ? '启用中' : '已关闭'),
    ]),
    form,
  ]);
}

/* ============================================================
   页面
   ============================================================ */

export async function renderAdminNoticeTemplates(view) {
  const paint = () => renderAdminNoticeTemplates(view);

  if (!readAdminKey() || !readAdminActor()) {
    view.innerHTML = '';
    view.appendChild(adminKeyGate({
      title: '通知模板',
      sub: '这里改的是发给商家的原话。属于运营配置，需要管理密钥。',
      hint: [
        '与两个审核台共用同一把钥匙和同一个署名。',
        el('br', {}),
        '模板在「排通知」的那一刻渲染：改完只影响此后新排队的通知，已经发出去的那条不会变——',
        '这也意味着，改完记得看一遍「立即投递通知」之后的实际效果。',
      ],
      onPass: paint,
    }));
    return;
  }

  view.innerHTML = '';
  const host = el('div', { class: 'mzt-host' });
  view.appendChild(el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    adminTabs('templates'),
    el('div', { class: 'adm-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'MERCHANT NOTICES'),
        el('h1', { class: 'adm-title' }, '通知模板'),
        el('span', { class: 'adm-actor' }, `操作人 ${readAdminActor()}`),
      ]),
      el('button', {
        class: 'adm-line-btn',
        type: 'button',
        onclick: () => {
          clearAdminIdentity();
          paint();
        },
      }, '退出'),
    ]),
    el('p', { class: 'mzt-intro' },
      '审核结果与撤回回执都从这里发出。变量在排通知时填充，收件人始终是打码的——'
      + '模板里不要写查询链接：链接带查询凭证，会和短信一起被转发出去。'),
    host,
  ]));
  loading(host, '正在读取通知模板…');

  let data;
  try {
    data = await fetchTemplates();
  } catch (e) {
    host.innerHTML = '';
    if (isKeyRejected(e)) {
      clearAdminIdentity();
      paint();
      toast(`无法访问：${(e && e.message) || '密钥无效'}`, 'warn');
      return;
    }
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, '没有取到模板'),
      el('p', {}, (e && e.message) || '请稍后重试'),
      el('button', { class: 'adm-line-btn', type: 'button', onclick: paint }, '重试'),
    ]));
    return;
  }

  host.innerHTML = '';
  const items = (data && data.items) || [];
  const groups = [
    ['approved', '审核通过'],
    ['rejected', '审核驳回'],
    ['withdrawn', '商家撤回'],
  ];
  for (const [status, title] of groups) {
    const list = items.filter((t) => t.status === status);
    if (!list.length) continue;
    host.appendChild(el('section', { class: 'mzt-group' }, [
      el('div', { class: 'mzt-group-head' }, [
        el('h2', { class: 'mzt-group-title' }, title),
        el('p', { class: 'mzt-group-sub' }, STATUS_INTRO[status] || ''),
      ]),
      el('div', { class: 'mzt-grid' }, list.map((t) => templateCard(t, {
        variables: data.variables,
        limits: data.limits,
        onChanged: paint,
      }))),
    ]));
  }

  host.appendChild(el('p', { class: 'mzt-foot' },
    '关掉某个通道只是不再排队，不会补发历史通知；恢复默认会删除自定义文案，回到代码里的默认版本。'));
}
