#!/usr/bin/env bash
# Build docs/guides/pdf/*.pdf from the Markdown guides.
# Needs python3 and headless Chrome/Chromium (set CHROME=... if not on PATH).
# Python-Markdown is used from the environment, or fetched on the fly with uv.
set -euo pipefail
cd "$(dirname "$0")"
export GUIDE_VERSION="${GUIDE_VERSION:-$(git log -1 --format='Updated %ad' --date=format:'%Y-%m-%d' -- installation-guide.md user-guide.md 2>/dev/null || true)}"
if python3 -c 'import markdown' 2>/dev/null; then
  python3 build_pdfs.py
elif command -v uv >/dev/null; then
  uv run --no-project --with 'markdown>=3.5' python build_pdfs.py
else
  echo "Install Python-Markdown (pip install markdown) or uv, then re-run." >&2
  exit 1
fi
