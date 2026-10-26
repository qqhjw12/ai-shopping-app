// 演示模式标志：当 AI 网关不可达时（例如 GitHub Pages 静态站点未连接后端），
// views.js 调用 setDemoMode(true)；assistant.js / tools.js 据此把网络错误替换为友好提示。
// 拆成独立模块，避免与 views.js 形成循环依赖。
let _demo = false;

export function setDemoMode(v) {
  _demo = !!v;
}

export function isDemoMode() {
  return _demo;
}
