#!/usr/bin/env python3
"""本地静态开发服务器（面向 web/ 目录），零第三方依赖。

相比 `python -m http.server` 的三处改进：

1. 强制 `Cache-Control: no-store`——改完 CSS/JS 刷新即生效，不会被浏览器缓存坑；
2. 补全 MIME——`.mjs`/`.js` 一律 `text/javascript`（Windows 注册表有时把它映射成
   text/plain，ES Module 会因严格 MIME 检查被浏览器拒绝执行）；同理补 `.svg`/
   `.woff2`/`.webmanifest`/`.wasm`；
3. 拒绝隐藏文件与目录（`.git`/`.env` 之类），端口占用时报可读错误而不是抛栈。

用法：
    python scripts/dev_server.py --port 5500 --directory web
    python scripts/dev_server.py --port 5500 --directory web --quiet
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import sys

# 显式覆盖：不依赖系统的 mimetypes 数据库（Windows 注册表会污染映射）
MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
}


class DevHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件处理器：no-store + 隐藏路径拦截。"""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **MIME_OVERRIDES,
    }

    # 只允许读，开发期不处理任何写方法
    def do_POST(self) -> None:  # noqa: N802 (http.server 的命名约定)
        self.send_error(405, "dev server is read-only")

    def do_PUT(self) -> None:  # noqa: N802
        self.send_error(405, "dev server is read-only")

    def do_DELETE(self) -> None:  # noqa: N802
        self.send_error(405, "dev server is read-only")

    def list_directory(self, path):  # type: ignore[override]
        # 不暴露目录清单，避免把整棵树列给浏览器
        self.send_error(404, "Not Found")
        return None

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        resolved = super().translate_path(path)
        # 隐藏文件/目录一律当作不存在（"." / ".." 不算隐藏，否则根路径会被误拦）
        rel = os.path.relpath(resolved, os.getcwd())
        parts = [p for p in rel.split(os.sep) if p not in (".", "..", "")]
        if any(part.startswith(".") for part in parts):
            return os.path.join(os.getcwd(), "__hidden__")
        return resolved

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # 只报非 2xx：开发期每个 200 都刷屏，而 404 恰恰是最需要一眼看到的
        if isinstance(code, int) and 200 <= code < 300:
            return
        super().log_request(code, size)


def main() -> int:
    parser = argparse.ArgumentParser(description="本地静态开发服务器")
    parser.add_argument("--port", type=int, default=5500, help="监听端口（默认 5500）")
    parser.add_argument("--bind", default="127.0.0.1", help="绑定地址（默认 127.0.0.1）")
    parser.add_argument("--directory", default="web", help="站点根目录（默认 web）")
    parser.add_argument("--quiet", action="store_true", help="不打印启动横幅")
    args = parser.parse_args()

    root = os.path.abspath(args.directory)
    if not os.path.isfile(os.path.join(root, "index.html")):
        sys.stderr.write(f"✗ 目录下没有 index.html：{root}\n")
        return 1

    os.chdir(root)  # translate_path 以 cwd 为基准
    handler = functools.partial(DevHandler, directory=root)
    server_cls = getattr(http.server, "ThreadingHTTPServer", http.server.HTTPServer)

    try:
        httpd = server_cls((args.bind, args.port), handler)
    except OSError as exc:
        sys.stderr.write(
            f"✗ 无法监听 {args.bind}:{args.port} —— {exc}\n"
            f"  端口可能已被占用，换一个：WEB_PORT=5501 bash scripts/dev-local.sh\n"
        )
        return 1

    if not args.quiet:
        sys.stdout.write(f"  静态前端: http://localhost:{args.port}/  （root={root}）\n")
        sys.stdout.flush()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
