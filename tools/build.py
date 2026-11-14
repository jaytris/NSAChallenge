"""Inline css/ui.css and js/*.js into one self-contained dist/sar-atlas.html.

Usage: python tools/build.py
CesiumJS and Google Fonts stay on their pinned CDN URLs (the app falls back
to a canvas globe and system fonts if they cannot load).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "index.html").read_text(encoding="utf-8")

css = (ROOT / "css" / "ui.css").read_text(encoding="utf-8")
html = re.sub(r"<!--CSS-->.*?<!--/CSS-->", lambda m: f"<style>\n{css}\n</style>", html, flags=re.S)

def inline_js(match):
    parts = []
    for src in re.findall(r'<script src="(js/[^"]+)"></script>', match.group(0)):
        code = (ROOT / src).read_text(encoding="utf-8")
        assert "</script" not in code.lower(), f"{src} contains a closing script tag"
        parts.append(f"<script>/* ---- {src} ---- */\n{code}\n</script>")
    return "\n".join(parts)

html = re.sub(r"<!--JS-->.*?<!--/JS-->", inline_js, html, flags=re.S)
out = ROOT / "dist" / "sar-atlas.html"
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
