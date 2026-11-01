"""Render docs/guides/*.md to styled HTML and print them to PDF with headless Chrome."""

import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

HERE = Path(__file__).resolve().parent
GUIDES = {
    "installation-guide.md": "Aquarium-Installation-Guide.pdf",
    "user-guide.md": "Aquarium-User-Guide.pdf",
}


def split_front_matter(text: str) -> tuple[dict, str]:
    meta: dict = {}
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
        text = text[m.end():]
    return meta, text


def render(src: Path, css: str, version: str) -> str:
    meta, body = split_front_matter(src.read_text(encoding="utf-8"))
    md = markdown.Markdown(
        extensions=["tables", "fenced_code", "toc", "attr_list", "md_in_html", "sane_lists"],
        extension_configs={"toc": {"toc_depth": "1-2"}},
    )
    content = md.convert(body)
    title = html.escape(meta.get("title", src.stem))
    subtitle = html.escape(meta.get("subtitle", ""))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>{css}
@page {{ @top-right {{ content: "{title}"; }} }}
@page :first {{ @top-right {{ content: none; }} }}</style></head>
<body>
<section class="cover">
  <div class="brand">Aquarium</div>
  <h1 class="title">{title}</h1>
  <p class="subtitle">{subtitle}</p>
  <p class="version">{html.escape(version)}</p>
</section>
<nav class="toc"><h2>Contents</h2>{md.toc}</nav>
<main>{content}</main>
</body></html>"""


def find_chrome() -> str:
    for name in (os.environ.get("CHROME"), "google-chrome", "google-chrome-stable",
                 "chromium", "chromium-browser"):
        if name and shutil.which(name):
            return shutil.which(name)
    sys.exit("headless Chrome/Chromium not found; set CHROME=/path/to/chrome")


def main() -> None:
    chrome = find_chrome()
    css = (HERE / "guide.css").read_text(encoding="utf-8")
    version = os.environ.get("GUIDE_VERSION", "")
    out_dir = HERE / "pdf"
    out_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for src_name, pdf_name in GUIDES.items():
            page = Path(tmp) / (Path(src_name).stem + ".html")
            page.write_text(render(HERE / src_name, css, version), encoding="utf-8")
            pdf = out_dir / pdf_name
            subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                 "--no-pdf-header-footer", f"--user-data-dir={tmp}/profile",
                 f"--print-to-pdf={pdf}", page.as_uri()],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print(f"wrote {pdf.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
