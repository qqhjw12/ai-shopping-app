// 图片上传：压缩 → 提交 → 拿回对象键。
//
// 先用 canvas 压一道再传：手机直出照片动辄 4-6MB，压到 ~200KB 再传，
// 省流量也减轻网关压力（网关那边还有 6MB 的硬上限兜底）。
//
// 拿回的是**对象键**而不是 URL：URL 可能是有时效的预签名地址，
// 存进工单第二天就是死链。展示时现解析（服务端返回的 url 只用于本次预览）。
import { api, mediaUrl } from './api.js';

/**
 * 压缩：等比缩到最长边 maxEdge，转 JPEG。
 * @param {File} file
 * @returns {Promise<string>} dataURL
 */
export function compressImageFile(file, maxEdge = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('未选择图片'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('当前浏览器不支持图片压缩'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 上传一张凭证。
 *
 * 上传失败时要说清楚是「这张没传上去」而不是「工单提交失败」——
 * 用户好几十兆的照片传到一半断了，看到「提交失败」会以为整单都废了。
 *
 * @param {File} file
 * @returns {Promise<{name: string, size: number, key: string, url: string}>}
 */
export async function uploadEvidence(file) {
  const dataUrl = await compressImageFile(file);
  const d = await api('/api/aftersale/evidence', {
    method: 'POST',
    body: { data: dataUrl },
    retries: 0, // 大 body 不重试：重试一次就是再传一遍几 MB
  });
  return {
    name: String(file.name || '凭证').slice(0, 60),
    size: Number(d.size || 0),
    key: String(d.key || ''),
    url: mediaUrl(d.url || ''),
  };
}
