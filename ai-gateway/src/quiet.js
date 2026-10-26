// 精准屏蔽 node:sqlite 的 ExperimentalWarning（Node 22 内置 SQLite 仍标记为实验特性）。
// 只过滤这一条，其他警告照常输出——不要用 NODE_NO_WARNINGS 全关，会掩盖真问题。
const originalEmit = process.emitWarning.bind(process);

process.emitWarning = (warning, ...args) => {
  const msg = typeof warning === 'string' ? warning : warning && warning.message ? warning.message : '';
  if (msg.includes('SQLite is an experimental feature')) return;
  originalEmit(warning, ...args);
};
