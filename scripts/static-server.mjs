#!/usr/bin/env node
// 本地静态开发服务器 —— Node 兜底实现（没装 Python 时由 dev-local.sh 调用）。
// 行为与 scripts/dev_server.py 对齐：no-store、MIME 补全、只读、拒绝隐藏路径。
//
// 用法：node scripts/static-server.mjs --port 5500 --root web
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function parseArgs(argv) {
  const out = { port: 5500, root: 'web', bind: '127.0.0.1', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--bind') out.bind = argv[++i];
    else if (arg === '--quiet') out.quiet = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root);

try {
  await fs.access(path.join(root, 'index.html'));
} catch {
  console.error(`✗ 目录下没有 index.html：${root}`);
  process.exit(1);
}

function resolveTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  // 路径穿越拦截 + 隐藏路径拦截（.git / .env 之类）
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const segments = path.relative(root, abs).split(path.sep);
  if (segments.some((s) => s.startsWith('.'))) return null;
  return abs;
}

async function statFile(target) {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    return { file: index, size: (await fs.stat(index)).size };
  }
  return { file: target, size: stat.size };
}

const server = createServer(async (req, res) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, 'dev server is read-only');
    return;
  }

  try {
    const target = resolveTarget(req.url || '/');
    if (!target) {
      send(404, 'Not Found');
      return;
    }
    const { file, size } = await statFile(target);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch (err) {
    if (err && err.code === 'ENOENT') send(404, 'Not Found');
    else if (err && err.code === 'EISDIR') send(404, 'Not Found');
    else send(500, 'Internal Server Error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ 无法监听 ${args.bind}:${args.port} —— 端口已被占用`);
    console.error('  换一个端口：WEB_PORT=5501 bash scripts/dev-local.sh');
  } else {
    console.error(`✗ 静态服务启动失败：${err.message}`);
  }
  process.exit(1);
});

server.listen(args.port, args.bind, () => {
  if (!args.quiet) console.log(`  静态前端: http://localhost:${args.port}/  （root=${root}）`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
