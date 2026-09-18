#!/usr/bin/env python3
"""Convert a PDF to Markdown on disk so the agent never has to read the raw PDF.

The whole point is token economy: the conversion happens outside the model's
context. Only the short summary printed on stdout enters the conversation; the
Markdown, the outline and the metadata are written to files the agent reads
selectively (grep / sed) afterwards.

Backends are tried in order of Markdown quality and the first available one
wins. Nothing here is mandatory at import time - the script degrades instead of
crashing, and always exits 0 unless the input itself is unusable.

Usage:
    python3 pdf2md.py INPUT.pdf [options]

Options:
    --out DIR           Output root (default: .cache/pdf-md)
    --backend NAME      auto | pymupdf4llm | pymupdf | markitdown | pdfplumber
                        | pdftotext | pdfminer   (default: auto)
    --pages RANGE       Only convert these pages, e.g. "1-20" or "3,7,10-12"
    --split-pages       Also write pages/page-NNNN.md files
    --keep-furniture    Do not strip repeated headers/footers
    --force             Reconvert even if the cache is up to date
    --json              Print the summary as JSON instead of text
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone

DEFAULT_OUT = os.path.join(".cache", "pdf-md")
# Below this many characters per page the PDF is almost certainly a scan.
OCR_CHARS_PER_PAGE = 120
# A line repeated on at least this share of pages is running furniture.
FURNITURE_RATIO = 0.6
# How many lines at each edge of a page can be header/footer.
EDGE_LINES = 2
# A page must have at least one line outside the edge windows, or every line
# on it looks like furniture and there is no signal to learn from. Such
# pages are still cleaned, they just do not vote.
MIN_LINES_FOR_EDGES = EDGE_LINES + 1
PAGE_MARK = re.compile(r"^<!-- page (\d+) -->$")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def log(msg):
    print("[pdf2md] %s" % msg, file=sys.stderr)


def slugify(name):
    base = os.path.splitext(os.path.basename(name))[0]
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    return base or "document"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_pages(spec):
    """"1-20" / "3,7,10-12" -> sorted list of 1-based page numbers."""
    if not spec:
        return None
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            pages.update(range(int(start), int(end) + 1))
        else:
            pages.add(int(part))
    return sorted(p for p in pages if p > 0)


def have_module(name):
    # Broad on purpose: a half-installed optional dependency can raise things
    # that are not Exception subclasses (pyo3 PanicException, for one), and a
    # backend we merely probed for must never take the whole run down.
    try:
        __import__(name)
        return True
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        return False


def available_backends():
    found = []
    if have_module("pymupdf4llm"):
        found.append("pymupdf4llm")
    if have_module("pymupdf") or have_module("fitz"):
        found.append("pymupdf")
    if have_module("markitdown") or shutil.which("markitdown"):
        found.append("markitdown")
    if have_module("pdfplumber"):
        found.append("pdfplumber")
    if shutil.which("pdftotext"):
        found.append("pdftotext")
    if have_module("pdfminer") or shutil.which("pdf2txt.py"):
        found.append("pdfminer")
    return found


INSTALL_HINT = """No PDF backend found. Install one (best first):

  pip install pymupdf4llm      # best Markdown structure, headings and tables
  pip install 'markitdown[pdf]'  # Microsoft MarkItDown, also does DOCX/XLSX/PPTX
  pip install pdfplumber       # good tables, slower
  apt-get install poppler-utils  # pdftotext, fastest, layout only

For scanned PDFs you also need OCR:
  pip install ocrmypdf   (plus the tesseract binary and its language packs)"""


# --------------------------------------------------------------------------
# backends: each returns a list of per-page strings
# --------------------------------------------------------------------------


def _open_fitz(path):
    try:
        import pymupdf  # noqa: PLC0415
    except Exception:
        import fitz as pymupdf  # noqa: PLC0415  (older releases)
    return pymupdf.open(path)


def backend_pymupdf4llm(path, pages):
    import pymupdf4llm  # noqa: PLC0415

    kwargs = {"page_chunks": True}
    if pages:
        kwargs["pages"] = [p - 1 for p in pages]
    chunks = pymupdf4llm.to_markdown(path, **kwargs)
    return [(c.get("text") or "") for c in chunks]


def backend_pymupdf(path, pages):
    doc = _open_fitz(path)
    wanted = [p - 1 for p in pages] if pages else range(doc.page_count)
    out = []
    for index in wanted:
        if 0 <= index < doc.page_count:
            out.append(doc[index].get_text("text"))
    doc.close()
    return out


def backend_markitdown(path, pages):
    text = None
    try:
        from markitdown import MarkItDown  # noqa: PLC0415

        text = MarkItDown().convert(path).text_content
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:  # see have_module - broken deps can panic, not raise
        binary = shutil.which("markitdown")
        if binary:
            text = subprocess.run(
                [binary, path], capture_output=True, text=True, check=False
            ).stdout
    if not text:
        raise RuntimeError("markitdown produced no output")
    # MarkItDown returns one blob; page boundaries are unavailable.
    return [text]


def backend_pdfplumber(path, pages):
    import pdfplumber  # noqa: PLC0415

    out = []
    with pdfplumber.open(path) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            if pages and number not in pages:
                continue
            out.append(page.extract_text() or "")
    return out


def backend_pdftotext(path, pages):
    cmd = ["pdftotext", "-layout", "-enc", "UTF-8"]
    if pages:
        cmd += ["-f", str(pages[0]), "-l", str(pages[-1])]
    cmd += [path, "-"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "pdftotext failed")
    # pdftotext separates pages with form feed.
    return result.stdout.split("\f")


def backend_pdfminer(path, pages):
    from pdfminer.high_level import extract_text  # noqa: PLC0415

    kwargs = {}
    if pages:
        kwargs["page_numbers"] = [p - 1 for p in pages]
    return extract_text(path, **kwargs).split("\f")


BACKENDS = {
    "pymupdf4llm": backend_pymupdf4llm,
    "pymupdf": backend_pymupdf,
    "markitdown": backend_markitdown,
    "pdfplumber": backend_pdfplumber,
    "pdftotext": backend_pdftotext,
    "pdfminer": backend_pdfminer,
}
# Order matters: best Markdown fidelity first.
PREFERENCE = ["pymupdf4llm", "pymupdf", "markitdown", "pdfplumber", "pdftotext", "pdfminer"]


# --------------------------------------------------------------------------
# cleanup
# --------------------------------------------------------------------------


def normalize_line(line):
    """Collapse variable parts so "Page 3 of 40" and "Page 4 of 40" match."""
    line = re.sub(r"\d+", "#", line.strip())
    return re.sub(r"\s+", " ", line).lower()


def strip_furniture(pages):
    """Drop headers/footers repeated across most pages - pure token waste.

    Deliberately timid: a header sits in the top two lines and a footer in the
    bottom two, so only those are candidates, and at most EDGE_LINES come off
    each end. A page that would be emptied is returned untouched - losing real
    content is far worse than carrying a few repeated lines.
    """
    if len(pages) < 4:
        return pages, []

    counts = {}
    for index, text in enumerate(pages):
        lines = [ln for ln in text.splitlines() if ln.strip()]
        if len(lines) < MIN_LINES_FOR_EDGES:
            continue
        for candidate in lines[:EDGE_LINES] + lines[-EDGE_LINES:]:
            key = normalize_line(candidate)
            if 3 <= len(key) <= 120:
                counts.setdefault(key, set()).add(index)
    threshold = max(3, int(len(pages) * FURNITURE_RATIO))
    furniture = {key for key, seen in counts.items() if len(seen) >= threshold}
    if not furniture:
        return pages, []

    cleaned, used = [], set()
    for text in pages:
        lines = text.splitlines()
        head, removed = 0, 0
        while head < len(lines) and removed < EDGE_LINES:
            if not lines[head].strip():
                head += 1
                continue
            key = normalize_line(lines[head])
            if key not in furniture:
                break
            used.add(key)
            head += 1
            removed += 1
        tail, removed = len(lines), 0
        while tail > head and removed < EDGE_LINES:
            if not lines[tail - 1].strip():
                tail -= 1
                continue
            key = normalize_line(lines[tail - 1])
            if key not in furniture:
                break
            used.add(key)
            tail -= 1
            removed += 1
        kept = "\n".join(lines[head:tail])
        cleaned.append(text if text.strip() and not kept.strip() else kept)
    return cleaned, sorted(used)


def tidy(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("­", "")  # soft hyphen
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Words split across a line break by hyphenation.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    return text.strip()


# --------------------------------------------------------------------------
# outline
# --------------------------------------------------------------------------

# Named divisions, the strongest signal in documents with no Markdown headings
# (statutes, judgments, contracts): "Articulo 5", "CAPITULO II", "Clause 7".
KEYWORD = re.compile(
    r"^\s*(?:art[ií]culo|article|artigo|cap[ií]tulo|chapter|secci[oó]n|section|"
    r"t[ií]tulo|title|anexo|annex|disposici[oó]n|clause|cl[aá]usula|"
    r"fundamentos?|antecedentes?|fallo|exponen|estipulaciones?)\b[^\n]{0,80}$",
    re.IGNORECASE,
)
# Weaker signals: decimal numbering ("3.2 Scope", "4) Payment") and short
# all-caps lines. Case-sensitive on purpose - the caps *are* the signal.
GENERIC = re.compile(
    r"^\s*(?:"
    r"\d+(?:\.\d+){1,3}[.)]?\s+\S.{0,80}"
    r"|\d+[.)]\s+\S.{0,80}"
    r"|[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 ,.;:()/'\"-]{7,80}"
    r")\s*$"
)
# A flat document can match GENERIC on nearly every line; past this many the
# weak matches are noise and only real headings are kept.
MAX_GENERIC = 300


def build_outline(markdown):
    """Heading index with line numbers so the agent can sed only what it needs."""
    entries = []
    page = 1
    fenced = False
    generic_count = 0
    for number, line in enumerate(markdown.splitlines(), start=1):
        if line.startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        mark = PAGE_MARK.match(line)
        if mark:
            page = int(mark.group(1))
            continue
        heading = re.match(r"^(#{1,6})\s+(.*\S)\s*$", line)
        if heading:
            entries.append(("md", len(heading.group(1)), heading.group(2), number, page))
        elif len(line) <= 90 and line.strip():
            if KEYWORD.match(line):
                entries.append(("keyword", 3, line.strip(), number, page))
            elif GENERIC.match(line):
                entries.append(("generic", 4, line.strip(), number, page))
                generic_count += 1
    if generic_count > MAX_GENERIC:
        entries = [e for e in entries if e[0] != "generic"]
    return [e[1:] for e in entries]


def render_outline(entries, meta):
    out = [
        "# Outline - %s" % meta["source_name"],
        "",
        "%d pages | %s chars | ~%s tokens | backend: %s"
        % (
            meta["pages"],
            f"{meta['chars']:,}",
            f"{meta['est_tokens']:,}",
            meta["backend"],
        ),
        "",
        "Read a section without loading the whole file:",
        "`sed -n 'START,ENDp' %s`" % meta["markdown_path"],
        "",
    ]
    if not entries:
        out.append("_No headings detected - the document is flat. Use grep to locate terms._")
        return "\n".join(out) + "\n"
    out.append("| Line | Page | Level | Heading |")
    out.append("|-----:|-----:|------:|---------|")
    for level, title, line, page in entries:
        clean = title.replace("|", "\\|")
        out.append("| %d | %d | %d | %s |" % (line, page, level, clean[:120]))
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def convert(args):
    source = os.path.abspath(args.input)
    if not os.path.isfile(source):
        log("not a file: %s" % source)
        return None, 1

    pages_filter = parse_pages(args.pages)
    out_dir = os.path.join(os.path.abspath(args.out), slugify(source))
    md_path = os.path.join(out_dir, "document.md")
    outline_path = os.path.join(out_dir, "outline.md")
    meta_path = os.path.join(out_dir, "meta.json")
    digest = sha256(source)

    if not args.force and os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as handle:
                cached = json.load(handle)
            if cached.get("sha256") == digest and os.path.isfile(md_path):
                cached["cached"] = True
                return cached, 0
        except Exception:
            pass

    found = available_backends()
    if not found:
        log(INSTALL_HINT)
        return None, 2

    order = [args.backend] if args.backend != "auto" else [b for b in PREFERENCE if b in found]
    if args.backend != "auto" and args.backend not in found:
        log("backend '%s' is not installed; available: %s" % (args.backend, ", ".join(found)))
        return None, 2

    raw_pages, backend, errors = None, None, []
    for name in order:
        try:
            raw_pages = BACKENDS[name](source, pages_filter)
            backend = name
            break
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # try the next backend rather than give up
            errors.append("%s: %s" % (name, exc))
            log("backend %s failed (%s), trying next" % (name, exc))
    if raw_pages is None:
        log("every backend failed:\n  " + "\n  ".join(errors))
        return None, 2

    furniture = []
    if not args.keep_furniture:
        raw_pages, furniture = strip_furniture(raw_pages)

    body = []
    for number, text in enumerate(raw_pages, start=1):
        page_no = pages_filter[number - 1] if pages_filter and number <= len(pages_filter) else number
        cleaned = tidy(text)
        if not cleaned:
            continue
        body.append("<!-- page %d -->" % page_no)
        body.append("")
        body.append(cleaned)
        body.append("")
    markdown = "# %s\n\n" % os.path.basename(source) + "\n".join(body).rstrip() + "\n"

    os.makedirs(out_dir, exist_ok=True)
    with open(md_path, "w", encoding="utf-8") as handle:
        handle.write(markdown)

    text_only = re.sub(r"<!-- page \d+ -->", "", markdown)
    chars = len(text_only)
    page_count = len(raw_pages)
    meta = {
        "source": source,
        "source_name": os.path.basename(source),
        "sha256": digest,
        "backend": backend,
        "pages": page_count,
        "chars": chars,
        # ~4 chars per token is the usual rule of thumb for prose.
        "est_tokens": chars // 4,
        "markdown_path": md_path,
        "outline_path": outline_path,
        "out_dir": out_dir,
        "converted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stripped_furniture": furniture,
        "page_filter": args.pages or None,
        "cached": False,
    }
    density = chars / page_count if page_count else 0
    meta["likely_scanned"] = density < OCR_CHARS_PER_PAGE
    meta["chars_per_page"] = round(density, 1)

    entries = build_outline(markdown)
    meta["headings"] = len(entries)
    with open(outline_path, "w", encoding="utf-8") as handle:
        handle.write(render_outline(entries, meta))

    if args.split_pages:
        pages_dir = os.path.join(out_dir, "pages")
        os.makedirs(pages_dir, exist_ok=True)
        for number, text in enumerate(raw_pages, start=1):
            page_no = (
                pages_filter[number - 1]
                if pages_filter and number <= len(pages_filter)
                else number
            )
            target = os.path.join(pages_dir, "page-%04d.md" % page_no)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(tidy(text) + "\n")
        meta["pages_dir"] = pages_dir

    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2, ensure_ascii=False)
    return meta, 0


def report(meta):
    lines = [
        "Converted: %s" % meta["source_name"],
        "Markdown:  %s" % meta["markdown_path"],
        "Outline:   %s" % meta["outline_path"],
        "Pages:     %d   Chars: %s   ~Tokens: %s   Headings: %d"
        % (
            meta["pages"],
            f"{meta['chars']:,}",
            f"{meta['est_tokens']:,}",
            meta.get("headings", 0),
        ),
        "Backend:   %s%s" % (meta["backend"], "  (cached)" if meta.get("cached") else ""),
    ]
    if meta.get("stripped_furniture"):
        lines.append("Stripped:  %d repeated header/footer lines" % len(meta["stripped_furniture"]))
    if meta.get("likely_scanned"):
        lines.append(
            "WARNING:   only %s chars/page - this PDF looks scanned. OCR it first:\n"
            "           ocrmypdf --skip-text '%s' ocr.pdf && rerun on ocr.pdf"
            % (meta["chars_per_page"], meta["source"])
        )
    return "\n".join(lines)


def widen_console():
    """Stop a legacy console codepage from killing the run.

    A Windows console defaults to cp850/cp1252, so printing a filename with an
    em dash or a curly quote raises UnicodeEncodeError - after the conversion
    already succeeded. Reporting is never worth failing over.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main():
    widen_console()
    parser = argparse.ArgumentParser(description="Convert a PDF to Markdown on disk.")
    parser.add_argument("input", help="path to the PDF")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output root (default: %s)" % DEFAULT_OUT)
    parser.add_argument("--backend", default="auto", choices=["auto"] + PREFERENCE)
    parser.add_argument("--pages", help='page range, e.g. "1-20" or "3,7,10-12"')
    parser.add_argument("--split-pages", action="store_true", help="also write pages/page-NNNN.md")
    parser.add_argument("--keep-furniture", action="store_true", help="keep repeated headers/footers")
    parser.add_argument("--force", action="store_true", help="ignore the cache")
    parser.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = parser.parse_args()

    meta, code = convert(args)
    if meta is None:
        return code
    print(json.dumps(meta, indent=2, ensure_ascii=False) if args.json else report(meta))
    return 0


if __name__ == "__main__":
    sys.exit(main())
