#!/usr/bin/env python3
"""Static development server — serves src/ on http://localhost:8090.

Stdlib only. No caching, so a reload always shows the current files.

    python3 serve.py [--port 8090] [--dir src]
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver

ROOT = pathlib.Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quieter log
        if "200" not in (args[1] if len(args) > 1 else ""):
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--dir", default="src")
    args = ap.parse_args()

    directory = ROOT / args.dir
    if not directory.is_dir():
        raise SystemExit(f"no such directory: {directory}")

    handler = functools.partial(Handler, directory=str(directory))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving {directory.relative_to(ROOT)} at http://localhost:{args.port}")
        print("stop with Ctrl+C")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
