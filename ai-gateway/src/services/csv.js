// CSV 生成：只做三件事——转义、防公式注入、加 BOM。
//
// 三件事都不是可选的：
//   1) 转义：商家备注里出现一个逗号或换行，整个表格就错列（运营会在错误的行上做决定）；
//   2) 防公式注入：Excel 打开 =HYPERLINK("http://evil","点我") 这样的单元格会真的当公式执行。
//      把以 = + - @ 开头的值前面加一个 ' 是业界通行做法——多一个字符，少一类事故；
//   3) BOM：不加 \ufeff 的话，Windows Excel 会用本地 GBK 解码，中文全成乱码。
//      这份表格是给运营下载的，不是给程序读的，所以优先照顾 Excel。
//
// 换行统一用 \r\n：RFC 4180 规定，且 Excel 对它最友好。

const GUARD = /^[=+\-@\t\r]/;

function cell(value) {
  const s = value == null ? '' : String(value);
  // 0 和 false 都要保留：'' 与 0 在表格里是完全不同的信息
  const safe = GUARD.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * @param {Array<[string,string]>} columns [字段名, 表头]
 * @param {Array<object>} rows
 * @returns {string} 带 BOM 的 CSV 文本
 */
export function toCsv(columns, rows = []) {
  const lines = [columns.map(([, label]) => cell(label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([key]) => cell(row[key])).join(','));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** 文件名里的中文与空格按 RFC 5987 编码；同时给一个 ASCII 兜底名，老客户端也能存下来 */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
