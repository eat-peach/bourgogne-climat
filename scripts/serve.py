#!/usr/bin/env python3
"""Small, dependency-free development server for website/dist."""
from __future__ import annotations

import argparse
import mimetypes
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1] / "dist"
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")


class StaticHandler(SimpleHTTPRequestHandler):
    server_version = "BurgundyAtlasDev/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def translate_path(self, path):
        # SimpleHTTPRequestHandler's implementation is platform-sensitive and
        # may leave encoded traversal segments behind. Resolve and contain it.
        clean = unquote(urlsplit(path).path).lstrip("/")
        candidate = (ROOT / clean).resolve()
        try:
            candidate.relative_to(ROOT.resolve())
        except ValueError:
            return str(ROOT / "__missing__")
        return str(candidate)

    def list_directory(self, path):
        self.send_error(404, "Directory listings are disabled")
        return None

    def do_GET(self):
        if urlsplit(self.path).path in ("", "/"):
            self.path = "/index.html"
        super().do_GET()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), StaticHandler)
    print(f"Burgundy Atlas: http://{args.host}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
