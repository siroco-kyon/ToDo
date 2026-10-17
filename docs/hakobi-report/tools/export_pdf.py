"""Export the generated Word report to the PDF that is submitted.

The PDF is rendered with LibreOffice, the same renderer update_toc_pages.py
uses, so the page numbers in the table of contents match the PDF. It is a
tagged PDF (figure alt text is kept) marked as Japanese, with bookmarks for
every chapter and section heading.

Usage:
    python docs/hakobi-report/tools/export_pdf.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx docs/hakobi-report/output/HAKOBI_技術レポート.pdf
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from pypdf import PdfReader

from build_report_docx import DOCUMENT_LANGUAGE, toc_path
from update_toc_pages import find_pages, soffice, soffice_env

PDF_OPTIONS = {
    "UseTaggedPDF": {"type": "boolean", "value": "true"},
    "ExportBookmarks": {"type": "boolean", "value": "true"},
    "EmbedStandardFonts": {"type": "boolean", "value": "true"},
    "UseLosslessCompression": {"type": "boolean", "value": "true"},
}


def export(source: Path, docx: Path, target: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        profile = (workdir / "profile").resolve().as_uri()
        subprocess.run([soffice(), f"-env:UserInstallation={profile}", "--headless", "--norestore",
                        "--convert-to", "pdf:writer_pdf_Export:" + json.dumps(PDF_OPTIONS),
                        "--outdir", str(workdir), str(docx)], check=True, capture_output=True, env=soffice_env())
        pdf = workdir / (docx.stem + ".pdf")
        # 読み上げソフトが日本語の音声を選べるよう、文書の言語が日本語になっていることを確かめる。
        language = PdfReader(str(pdf)).root_object.get("/Lang")
        if language != DOCUMENT_LANGUAGE:
            raise RuntimeError(f"The PDF language is {language!r}, not {DOCUMENT_LANGUAGE}. Rebuild the .docx first.")
        # 目次に書いたページ番号と、書き出したPDFの見出しのページが合っていることを確かめてから置く。
        recorded = json.loads(toc_path(source).read_text(encoding="utf-8"))
        if find_pages(source, pdf) != recorded:
            raise RuntimeError("The TOC page numbers do not match the exported PDF. Run update_toc_pages.py and rebuild first.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf, target)
    print(f"wrote {target}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: export_pdf.py SOURCE.md REPORT.docx OUTPUT.pdf")
    export(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
