#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI Canvas 本地开发服务器

为什么不用 python -m http.server：
  自带的那个不发 Cache-Control 头，浏览器就会用启发式缓存，
  改完代码刷新页面还是旧 JS，必须 Ctrl+F5 才行。

这个版本发了 no-store，所以普通刷新（F5）就能看到最新代码。

用法：  python server.py [端口]
"""

import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        sys.stderr.write("AI Canvas dev server\n")
        sys.stderr.write("  url  : http://127.0.0.1:%d/\n" % PORT)
        sys.stderr.write("  cache: disabled\n\n")
        sys.stderr.flush()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass