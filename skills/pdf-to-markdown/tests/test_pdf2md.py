#!/usr/bin/env python3
"""Tests for the pdf2md converter.

Self-contained and backend-free: everything here exercises the pure text
handling, so it runs with nothing installed.

    python3 skills/pdf-to-markdown/tests/test_pdf2md.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

import pdf2md  # noqa: E402


class TestSlugify(unittest.TestCase):
    def test_strips_accents_and_punctuation(self):
        self.assertEqual(pdf2md.slugify("/tmp/Sentencia Nº 123 (TS).pdf"), "sentencia-no-123-ts")

    def test_falls_back_when_nothing_survives(self):
        self.assertEqual(pdf2md.slugify("/tmp/---.pdf"), "document")


class TestParsePages(unittest.TestCase):
    def test_none_for_empty(self):
        self.assertIsNone(pdf2md.parse_pages(None))
        self.assertIsNone(pdf2md.parse_pages(""))

    def test_ranges_and_singles_merge_and_sort(self):
        self.assertEqual(pdf2md.parse_pages("10-12,3,7"), [3, 7, 10, 11, 12])

    def test_duplicates_collapse(self):
        self.assertEqual(pdf2md.parse_pages("2-4,3"), [2, 3, 4])


class TestNormalizeLine(unittest.TestCase):
    def test_digits_collapse_so_paginated_footers_match(self):
        self.assertEqual(
            pdf2md.normalize_line("Page 3 of 40"),
            pdf2md.normalize_line("Page 4 of 40"),
        )


class TestStripFurniture(unittest.TestCase):
    # Real body text differs from page to page; the header and footer are the
    # only lines that repeat. Deliberately digit-free, since normalize_line
    # collapses digits and a numbered template would repeat after it.
    WORDS = (
        "alfa bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
        "mike november oscar papa quebec romeo sierra tango uniform victor whisky "
        "xray yankee zulu ancla barco cielo duna"
    ).split()

    @classmethod
    def _page(cls, number):
        chunk = cls.WORDS[(number - 1) * 5 : (number - 1) * 5 + 5]
        body = "\n".join("clausula %s del contrato" % word for word in chunk)
        return "BOLETIN OFICIAL DEL ESTADO\n%s\nPagina %d de 6" % (body, number)

    @classmethod
    def _first_body_line(cls, number):
        return "clausula %s del contrato" % cls.WORDS[(number - 1) * 5]

    def test_removes_repeated_header_and_footer(self):
        pages = [self._page(i) for i in range(1, 7)]
        cleaned, furniture = pdf2md.strip_furniture(pages)
        self.assertTrue(furniture)
        for index, page in enumerate(cleaned, start=1):
            self.assertNotIn("BOLETIN OFICIAL", page)
            self.assertNotIn("Pagina", page)
            self.assertIn(self._first_body_line(index), page)

    def test_never_empties_a_page_that_is_all_furniture(self):
        pages = [self._page(i) for i in range(1, 7)]
        pages.append("BOLETIN OFICIAL DEL ESTADO\nPagina 7 de 6")
        cleaned, _ = pdf2md.strip_furniture(pages)
        self.assertEqual(cleaned[-1], pages[-1])

    def test_keeps_body_text_that_merely_repeats_twice(self):
        pages = ["shared line\nbody %d" % i for i in range(1, 7)]
        pages[2] = "different\nbody 3"
        cleaned, _ = pdf2md.strip_furniture(pages)
        for index, page in enumerate(cleaned, start=1):
            self.assertIn("body %d" % index, page)

    def test_short_documents_are_left_alone(self):
        pages = ["header\nbody", "header\nbody"]
        cleaned, furniture = pdf2md.strip_furniture(pages)
        self.assertEqual(cleaned, pages)
        self.assertEqual(furniture, [])


class TestTidy(unittest.TestCase):
    def test_rejoins_hyphenated_words(self):
        self.assertEqual(pdf2md.tidy("indemni-\nzacion"), "indemnizacion")

    def test_collapses_blank_runs_and_trailing_space(self):
        self.assertEqual(pdf2md.tidy("a   \n\n\n\nb"), "a\n\nb")

    def test_drops_soft_hyphens_and_normalizes_newlines(self):
        self.assertEqual(pdf2md.tidy("a­b\r\nc"), "ab\nc")


class TestBuildOutline(unittest.TestCase):
    def test_markdown_headings_carry_level_line_and_page(self):
        md = "<!-- page 1 -->\n# Title\n\ntext\n<!-- page 2 -->\n## Sub\n"
        entries = pdf2md.build_outline(md)
        self.assertEqual(entries, [(1, "Title", 2, 1), (2, "Sub", 6, 2)])

    def test_detects_legal_divisions_without_markdown(self):
        md = "Articulo 5\ncuerpo\nFUNDAMENTOS DE DERECHO\ncuerpo\n"
        titles = [entry[1] for entry in pdf2md.build_outline(md)]
        self.assertIn("Articulo 5", titles)
        self.assertIn("FUNDAMENTOS DE DERECHO", titles)

    def test_ignores_headings_inside_code_fences(self):
        md = "```\n# not a heading\n```\n# real heading\n"
        titles = [entry[1] for entry in pdf2md.build_outline(md)]
        self.assertEqual(titles, ["real heading"])

    def test_prose_is_not_mistaken_for_a_heading(self):
        md = "Linea 0 de contenido de la seccion con texto de relleno.\n"
        self.assertEqual(pdf2md.build_outline(md), [])

    def test_weak_matches_are_dropped_when_they_flood_the_outline(self):
        # A flat document where every line looks like decimal numbering: past
        # MAX_GENERIC these are noise, and only real headings should survive.
        md = "# Real\n" + "".join("1.%d Item here\n" % i for i in range(pdf2md.MAX_GENERIC + 10))
        titles = [entry[1] for entry in pdf2md.build_outline(md)]
        self.assertEqual(titles, ["Real"])


class TestRenderOutline(unittest.TestCase):
    META = {
        "source_name": "x.pdf",
        "pages": 2,
        "chars": 10,
        "est_tokens": 2,
        "backend": "pymupdf",
        "markdown_path": "/tmp/x/document.md",
    }

    def test_flat_documents_say_so_instead_of_an_empty_table(self):
        out = pdf2md.render_outline([], self.META)
        self.assertIn("No headings detected", out)

    def test_escapes_pipes_so_the_table_survives(self):
        out = pdf2md.render_outline([(1, "a | b", 3, 1)], self.META)
        self.assertIn(r"a \| b", out)


class TestHaveModule(unittest.TestCase):
    def test_missing_module_is_false_not_an_error(self):
        self.assertFalse(pdf2md.have_module("definitely_not_a_real_module_xyz"))

    def test_existing_module_is_true(self):
        self.assertTrue(pdf2md.have_module("json"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
