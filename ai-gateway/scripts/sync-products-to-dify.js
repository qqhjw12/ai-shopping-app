// 把 mall 商品同步进 Dify 知识库（供「商品问答」RAG 检索）。
// 用法：
//   docker 模式（已配 DIFY_*）：node scripts/sync-products-to-dify.js
//   本地模式：会自动跳过并打印待同步数量，不报错
import { fetchProducts } from '../src/mallClient.js';
import { syncProductsToDataset } from '../src/difyClient.js';

const products = await fetchProducts();
const result = await syncProductsToDataset(products);
console.log('Dify 知识库同步结果：', result);
