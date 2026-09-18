---
name: pdf-to-markdown
description: Convert PDFs to Markdown on disk and read only the parts that matter, instead of loading the whole document into context. Use when the user uploads or points at a PDF, asks to read, summarize, search, quote, or extract from a PDF, or asks to convert a PDF to Markdown or text.
origin: ECC
---

# PDF to Markdown

Reading a PDF directly is the most expensive way to answer a question about it. A
300-page contract or judgment is 150K+ tokens; the answer usually lives in two
paragraphs. This skill converts the PDF to Markdown **on disk** with a script, so
the conversion costs nothing in context, and then reads only the sections the
question actually needs.

## When to Use

- The user uploads a PDF or gives a path to one.
- The user asks to read, summarize, search, quote, or extract data from a PDF.
- The user explicitly asks for a PDF converted to Markdown or plain text.
- A PDF must be reused across turns — converting once makes every later question cheap.

Do **not** use it when the PDF's visual layout is the point (a scanned signature to
inspect, a chart to describe, a form's geometry). Those need the image, not the text.

## How It Works

`scripts/pdf2md.py` writes three files under `.cache/pdf-md/<slug>/` and prints only
a five-line summary to stdout — that summary is all that enters the conversation:

| File | Purpose |
|------|---------|
| `document.md` | Full Markdown, with `<!-- page N -->` markers |
| `outline.md` | Heading index with line and page numbers — read this first |
| `meta.json` | Pages, chars, estimated tokens, backend, sha256 |

The script picks the best available backend (`pymupdf4llm` → `pymupdf` →
`markitdown` → `pdfplumber` → `pdftotext` → `pdfminer`), falling through to the next
one if any fails. It strips headers and footers repeated across pages, rejoins
hyphenated words, collapses blank runs, and caches by sha256 so a re-run on an
unchanged PDF is instant.

### Workflow

1. **Never `Read` the `.pdf` itself.** That is the thing this skill exists to avoid.
2. Convert. Use `python3` on macOS and Linux, `python` on Windows (`python3`
   there hits the Microsoft Store stub and fails):

   ```bash
   python3 <skill>/scripts/pdf2md.py "/path/to/file.pdf"
   ```

   `<skill>` is wherever this skill is installed - `~/.claude/skills/pdf-to-markdown`
   when installed globally, `%USERPROFILE%\.claude\skills\pdf-to-markdown` on
   Windows, or `skills/pdf-to-markdown` when working inside the ECC repo.

3. Read `outline.md`. It is a few hundred tokens and tells you where everything is.
4. Pull only what you need, using the line numbers from the outline:

   ```bash
   sed -n '340,410p' .cache/pdf-md/file/document.md     # one section
   grep -n -i -C3 'indemnizacion' .cache/pdf-md/file/document.md   # locate a term
   ```

5. Answer, citing the page number from the nearest `<!-- page N -->` marker.

### Token budget

Use `est_tokens` from the summary to decide:

- **under ~5K** — read `document.md` whole, the selective dance is not worth it.
- **5K–50K** — read `outline.md`, then `sed` the relevant sections.
- **over 50K** — outline first, then `grep -n` for the key terms, then `sed` narrow
  windows around the hits. Never read the whole file.

### Options

```text
--out DIR           output root (default: .cache/pdf-md)
--backend NAME      force a backend instead of auto-detecting
--pages RANGE       convert only "1-20" or "3,7,10-12"
--split-pages       also write pages/page-NNNN.md, one file per page
--keep-furniture    keep repeated headers/footers (default: strip them)
--force             reconvert even if the cache is current
--json              machine-readable summary
```

### Setup

The script needs at least one backend. Install the best one once:

```bash
pip install pymupdf4llm          # recommended: headings, tables, real Markdown
pip install 'markitdown[pdf]'    # also handles DOCX, XLSX, PPTX
apt-get install poppler-utils    # pdftotext, fastest, layout only
```

On Windows use `python -m pip install pymupdf4llm`, and drop the quotes around
`markitdown[pdf]` in CMD. The PATH warning pip prints about `Scripts\` is
harmless here - the skill imports the library, it never calls those .exe files.

With none installed the script exits 2 and prints these instructions — it never
crashes and never falls back to reading the PDF into context.

### Scanned PDFs

If the summary warns `only N chars/page - this PDF looks scanned`, the PDF holds
images, not text. OCR it first, then convert the result:

```bash
ocrmypdf --skip-text --language spa "scan.pdf" "scan-ocr.pdf"
python3 skills/pdf-to-markdown/scripts/pdf2md.py "scan-ocr.pdf"
```

Pass `--language spa+eng` for mixed-language documents.

## Examples

**Question about one clause in a long contract**

```bash
python3 skills/pdf-to-markdown/scripts/pdf2md.py "contrato.pdf"
# Pages: 84  Chars: 210,433  ~Tokens: 52,608  Headings: 61
grep -n -i -C5 'clausula de no competencia' .cache/pdf-md/contrato/document.md
```

Roughly 400 tokens read instead of 52,000.

**Structured reading of a judgment**

```bash
python3 skills/pdf-to-markdown/scripts/pdf2md.py "sentencia.pdf"
cat .cache/pdf-md/sentencia/outline.md
# outline shows FUNDAMENTOS DE DERECHO at line 212 and FALLO at line 486
sed -n '212,300p;486,520p' .cache/pdf-md/sentencia/document.md
```

**Only the summary pages of a report**

```bash
python3 skills/pdf-to-markdown/scripts/pdf2md.py "informe.pdf" --pages 1-12
```

**Many PDFs at once**

```bash
for f in docs/*.pdf; do
  python3 skills/pdf-to-markdown/scripts/pdf2md.py "$f"
done
grep -rn -i 'vencimiento' .cache/pdf-md/*/document.md
```

## Notes

- `.cache/` is already gitignored in this repo. Elsewhere, add it or pass `--out`
  to a directory that is.
- The converted Markdown stays on disk between turns; re-running is a cache hit,
  so later questions about the same PDF cost nothing to set up.
- `est_tokens` is a `chars / 4` estimate — a planning figure, not an exact count.
- The converter has its own tests, runnable with no backend installed:
  `python3 skills/pdf-to-markdown/tests/test_pdf2md.py`.
- Console output is forced to UTF-8, so a filename with an em dash or a curly
  quote cannot crash the run on a legacy Windows codepage.
- Text extraction from PDFs is imperfect. Before quoting verbatim in anything
  that matters, check the quote against the page it came from.
