#!/usr/bin/env python3
"""Bundles src/ into a single self-contained HTML file.

No dependencies, stdlib only. The output makes no external request — it opens
by double-clicking it from disk, survives being emailed, and deploys as a
single static file.

    python3 build.py [--out dist/parlay-kelly.html]
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"

LINK_RE = re.compile(r'[ \t]*<link[^>]*rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)["\'][^>]*>[ \t]*\n?')
SCRIPT_RE = re.compile(r'[ \t]*<script[^>]*src=["\']([^"\']+)["\'][^>]*>\s*</script>[ \t]*\n?')


def _read(rel: str) -> str:
    path = SRC / rel
    if not path.is_file():
        sys.exit(f"missing source file: {path}")
    return path.read_text(encoding="utf-8")


def _guard(text: str, kind: str) -> str:
    """Stops content from closing <style>/<script> ahead of time."""
    if kind == "script":
        # the only sequence that ends a script block from inside JS
        return text.replace("</script", "<\\/script")
    return text.replace("</style", "<\\/style")


def _strip_document(page: str) -> str:
    """Pulls the <style> out of the head and the <body> contents, for a host
    that supplies doctype/html/head/body itself."""
    head = page.split("<body", 1)[0]
    styles = re.findall(r"<style>.*?</style>", head, re.S)

    m = re.search(r"<body[^>]*>(.*)</body>", page, re.S)
    if not m:
        sys.exit("no <body> found — cannot build the embedded variant")

    return "\n".join(styles) + "\n" + m.group(1).strip() + "\n"


def build(out: pathlib.Path, artifact: bool = False) -> pathlib.Path:
    page = _read("index.html")
    inlined: list[str] = []

    def css_sub(m: re.Match[str]) -> str:
        rel = m.group(1)
        inlined.append(rel)
        return f"<style>\n{_guard(_read(rel), 'style')}\n</style>\n"

    def js_sub(m: re.Match[str]) -> str:
        rel = m.group(1)
        inlined.append(rel)
        return f"<script>\n{_guard(_read(rel), 'script')}\n</script>\n"

    page = LINK_RE.sub(css_sub, page)
    page = SCRIPT_RE.sub(js_sub, page)

    leftovers = re.findall(r'(?:src|href)=["\'](?!data:|#|https?://)([^"\']+\.(?:js|css))["\']', page)
    if leftovers:
        sys.exit(f"these references could not be inlined: {leftovers}")

    if artifact:
        page = _strip_document(page)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")

    print(f"inlined: {', '.join(inlined)}")
    kind = " (embedded variant, no doctype/html/head/body)" if artifact else ""
    print(f"built → {out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.1f} kB){kind}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="dist/parlay-kelly.html")
    ap.add_argument("--artifact", action="store_true",
                    help="omit doctype/html/head/body; the host supplies them")
    args = ap.parse_args()
    build(ROOT / args.out, artifact=args.artifact)


if __name__ == "__main__":
    main()
