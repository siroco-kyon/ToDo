"""Record the page on which each chapter and section starts, for the table of contents.

The Word TOC field is updated when the document is opened in Word, but the file
also carries a readable cached result. This script renders the generated .docx
with LibreOffice, finds every heading the TOC field collects (levels 1 to
TOC_LEVELS in build_report_docx.py) and writes tools/toc_pages.json, which
build_report_docx.py uses for that cached result. Build, run this, then build
again (the second build should not move any heading).

Usage:
    python docs/hakobi-report/tools/update_toc_pages.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from pypdf import PdfReader

from build_report_docx import toc_headings, toc_path

REPO = Path(__file__).resolve().parents[3]
SOFFICE_CANDIDATES = [
    os.environ.get("HAKOBI_SOFFICE", ""),
    "soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    # The portable copy used for the earlier HAKOBI documents (not under version control).
    str(REPO / "docs/hakobi-introduction/.build/runtime/LibreOfficePortable/App/libreoffice/program/soffice.com"),
]


def soffice() -> str:
    for candidate in SOFFICE_CANDIDATES:
        if not candidate:
            continue
        found = shutil.which(candidate) or (candidate if Path(candidate).exists() else None)
        if found:
            return found
    raise FileNotFoundError("LibreOffice (soffice) is required. Set HAKOBI_SOFFICE to its path.")


def soffice_env() -> dict[str, str]:
    env = os.environ.copy()
    # Headless rendering without the desktop plugin, as the portable copy needs.
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")
    env.setdefault("SAL_DISABLE_OPENCL", "1")
    env.setdefault("SAL_DISABLESKIA", "1")
    return env


def render_pdf(docx: Path, workdir: Path) -> Path:
    profile = (workdir / "profile").resolve().as_uri()
    subprocess.run([soffice(), f"-env:UserInstallation={profile}", "--headless", "--norestore", "--convert-to", "pdf",
                    "--outdir", str(workdir), str(docx)], check=True, capture_output=True, env=soffice_env())
    return workdir / (docx.stem + ".pdf")


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def find_pages(source: Path, pdf: Path) -> dict[str, int]:
    lines = source.read_text(encoding="utf-8").splitlines()
    body = next(i for i, line in enumerate(lines) if re.match(r"^# 1\.", line.strip()))
    # 目次のフィールドが集めるのと同じ見出し（章と節）を、同じ順で探す。
    titles = [title for _, title in toc_headings(lines[body:])]
    pages = [squash(page.extract_text() or "") for page in PdfReader(str(pdf)).pages]
    # 目次は複数ページにわたり、どの見出しも載っているため、目次の最後のページより後から探す。
    first, last = squash(titles[0]), squash(titles[-1])
    toc_page = next(i for i, text in enumerate(pages) if "目次" in text and first in text)
    toc_end = next(i for i in range(toc_page, len(pages)) if last in pages[i])
    result, cursor = {}, toc_end + 1
    for title in titles:
        needle = squash(title)
        for index in range(cursor, len(pages)):
            if needle in pages[index]:
                result[title] = index + 1  # The footer's PAGE field counts the cover as page 1.
                cursor = index
                break
        else:
            raise RuntimeError(f"Heading not found in the rendered PDF: {title}")
    return result


def main(source: Path, docx: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pdf = render_pdf(docx, Path(tmp))
        pages = find_pages(source, pdf)
    target = toc_path(source)
    target.write_text(json.dumps(pages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for title, page in pages.items():
        print(f"{page:>3}  {title}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: update_toc_pages.py SOURCE.md OUTPUT.docx")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
