#!/usr/bin/env python3
"""仅预览静态前端。无业务 API，不读取 Token，不调用麦当劳。"""

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "output" / "mcd-wheel-static"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://mcp.mcd.cn; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        super().end_headers()

    def do_GET(self):
        if self.headers.get("Host") not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"):
            self.send_error(403, "Local preview only")
            return
        super().do_GET()

    def list_directory(self, _):
        self.send_error(404, "Page not found")
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-build", action="store_true", help="直接预览已有静态产物")
    args = parser.parse_args()
    if not args.no_build:
        subprocess.run(["node", str(REPO / "scripts/build_frontend.mjs")], check=True)
    if not (WEB / "index.html").exists():
        parser.error("请先运行 npm run build")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"麦麦饱饱盘：http://127.0.0.1:{server.server_port}（纯静态体验页，实时功能请加载扩展）", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
