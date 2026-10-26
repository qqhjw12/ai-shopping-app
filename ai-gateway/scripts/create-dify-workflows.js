// 在 Dify 中创建两个 Workflow App（运营文案 / 订单售后）的壳，并验证连通性。
// 说明：Dify 的 workflow 图（节点/prompt）建议在 Dify 控制台由运营同事无代码编辑，
//       本脚本只负责创建 App 壳 + 校验 API Key 是否可用，避免把未经验证的 DSL 写死。
//
// 用法：
//   RUN_MODE=docker DIFY_API_URL=... DIFY_ADMIN_KEY=... node scripts/create-dify-workflows.js
// 说明：DIFY_ADMIN_KEY 是 Dify 后台「设置 -> API 密钥」里给服务端用的管理员密钥（区别于应用级 API Key）。
//       未配置或 local 模式时，脚本仅打印待办清单并退出，不报错。

import { config } from '../src/config.js';
import { readFileSync } from 'node:fs';

const ADMIN_KEY = process.env.DIFY_ADMIN_KEY || '';
const specs = ['copywrite.spec.json', 'aftersale.spec.json'].map((f) =>
  JSON.parse(readFileSync(new URL(`../dify-workflows/${f}`, import.meta.url))),
);

if (config.runMode !== 'docker' || !ADMIN_KEY) {
  console.log('[create-dify-workflows] 非 docker 模式或缺少 DIFY_ADMIN_KEY，仅输出待办清单：');
  for (const s of specs) {
    console.log(`  - 请在 Dify 控制台新建 Workflow 应用「${s.app_name}」`);
    console.log(`    输入变量：${Object.keys(s.entry_inputs).join('、')}`);
    console.log(`    参考蓝图：dify-workflows/${s.app_name}.spec.json`);
    console.log(`    发布后在「访问 API」拿到 Key，填入 .env 的 DIFY_CW_API_KEY / DIFY_AS_API_KEY`);
  }
  process.exit(0);
}

async function createApp(spec) {
  const resp = await fetch(`${config.dify.apiUrl.replace('/v1', '')}/console/api/apps`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: spec.app_name, mode: 'workflow', description: spec.description }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`创建「${spec.app_name}」失败 ${resp.status}: ${text}`);
  }
  return resp.json();
}

(async () => {
  console.log(`[create-dify-workflows] Dify API: ${config.dify.apiUrl}`);
  for (const s of specs) {
    try {
      const r = await createApp(s);
      console.log(`[ok] 已创建「${s.app_name}」app_id=${r.id || r.app_id || '(见返回)'}`);
      console.log(`     请到 Dify 控制台按 dify-workflows/${s.app_name}.spec.json 补全工作流节点并发布`);
    } catch (e) {
      console.error(`[fail] ${e.message}`);
    }
  }
  console.log('完成。发布后把应用 API Key 填回 .env（DIFY_CW_API_KEY / DIFY_AS_API_KEY），网关即自动切换为调用真实 Dify。');
})();
