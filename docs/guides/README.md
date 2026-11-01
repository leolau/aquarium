# Aquarium guides

- [Installation Guide](installation-guide.md) — for the operator who sets up a server
  ([PDF](pdf/Aquarium-Installation-Guide.pdf))
- [User Guide](user-guide.md) — for everyone who uses the app
  ([PDF](pdf/Aquarium-User-Guide.pdf))

Edit the Markdown, then rebuild the PDFs and commit both:

```bash
docs/guides/build_pdfs.sh
```

The script renders each guide with Python-Markdown (`markdown`, or fetched via `uv`)
and `guide.css`, then prints it with headless Chrome/Chromium (`CHROME=/path` to
override). Use only placeholder hosts such as `home.example.com` — this repository is
public.
