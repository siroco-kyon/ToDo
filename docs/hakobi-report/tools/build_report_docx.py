"""Build the HAKOBI technical report (Word) from HAKOBI_TECHNICAL_REPORT.md.

Adapted from the Watashi report tools. Headings use Word heading styles, so the
PDF export gets bookmarks and the TOC field can collect them. Figures are placed
with [[FIGURE:key]] and captioned below (図N); tables are captioned above (表N).

Usage:
    python docs/hakobi-report/tools/build_report_docx.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.part import Part
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from lxml import etree

from report_diagrams import build_diagrams

# Colors follow the app icon: navy ground, teal bars and an amber accent.
NAVY = "0F1B2D"
TEAL = "0E8C80"
TEAL_DARK = "0B6E66"
TEAL_LIGHT = "E7F5F3"
MINT = "7FE3D3"
MID_GRAY = "5B6B78"
BODY = "263238"
LINK = "0B6E66"

SVG_NS = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"
SVG_EXT_URI = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
FULL_WIDTH = 6.15
TABLE_WIDTH = 9360
# Heading levels in the TOC field. The cached result and update_toc_pages.py use the same levels,
# so updating the field in Word does not add entries and move the chapters.
TOC_LEVELS = 2
# 概要・目次の見出しに使う、目次に集められないスタイル。
FRONT_HEADING = "Front Heading"
DOCUMENT_LANGUAGE = "ja-JP"
REPORT_NAME = "HAKOBI 技術レポート"
ICON = Path(__file__).resolve().parents[3] / "build" / "icon.png"
# Where the cover breaks the title, so no word is split across lines.
COVER_TITLE_BREAKS = ("見える化する", "業務管理ツール")

# Every figure the Markdown can place with [[FIGURE:key]]. Diagrams come from
# report_diagrams.py (SVG + PNG); screens are PNGs made by prepare_screens.py.
FIGURES = {
    "timeline": {"alt": "2026年3〜4月の個人用デスクトップアプリから、5月30日のチーム用サーバー、6〜9月の進捗共有と報告タブ、10月のチーム接続のデスクトップ版と定例モードまでの開発の流れ"},
    "architecture": {"alt": "個人用はデスクトップ版の画面がIPCでPC内のSQLiteを使い、チーム用はブラウザとデスクトップ版の同じ画面がHTTPとWebSocketで社内LANのサーバーを使う構成図"},
    "sync-flow": {"alt": "画面で保存、サーバーで確認、DBを更新、WebSocketで変更を知らせる、各画面が取り直す、の5段階の流れ"},
    "record-hub": {"alt": "作業の区切りに残す日々の記録が、チームの状況確認、定例での相談、週報の下書きの三つに使われることを示す図"},
    "dependency": {"alt": "AからBとCへ分岐し、BとCがDで合流してEへ続く依存関係。Aの期限を延ばすとC、D、Eの日程が順に計算し直される"},
    "weekly-flow": {"alt": "報告タブで期間と担当を選び、Markdownをコピーして週報用エージェントに渡し、下書きを本人が確認して提出する流れ"},
    "gantt": {"image": "screens/gantt.png", "alt": "ガントの画面。業務改善、設備・手順、定例・報告の各カテゴリのタスクとサブタスクが日程のバーで並び、依存関係の矢印と今日の列が表示されている"},
    "team": {"image": "screens/team.png", "width": 4.6, "alt": "チーム画面。いま稼働中の2人の計測中の仕事、期限を過ぎた仕事1件、メンバー3人の進行中・保留中・超過の件数と今日の作業時間"},
    "progress": {"image": "screens/progress.png", "width": 4.3, "alt": "進捗の画面。ひな形を入れた入力欄と、ほかのメンバーの進捗ログが日付ごとに並ぶ"},
    "report": {"image": "screens/report.png", "alt": "報告タブ。期間の選択、Markdownをコピー、CSV、定例モードのボタン、担当者ごとのタスクと期間中の進捗の変化、メモ、進捗ログ"},
    "meeting": {"image": "screens/meeting.png", "alt": "定例モード。担当者ごとの要相談とタスク、経過時間と持ち時間、決まったことをタスクにする欄と定例メモ"},
    "checklist": {"image": "screens/checklist.png", "width": 5.6, "alt": "ToDoの画面の今日やること。平日・毎週・毎月の項目が周期ごとにまとまり、チェック済みの項目に線が引かれている"},
    "plan": {"image": "screens/plan.png", "width": 5.2, "alt": "計画の画面。日付、予定・未定・合計時間と、時間割に置いたタスク"},
}


def set_east_asia(run, font_name: str) -> None:
    run.font.name = "Calibri"
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), "Calibri")
    rfonts.set(qn("w:hAnsi"), "Calibri")
    rfonts.set(qn("w:eastAsia"), font_name)


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_width(cell, width_twips: int) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(width_twips))
    tc_w.set(qn("w:type"), "dxa")


def set_cell_borders(cell, color: str | None, left: tuple[int, str] | None = None) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for side in ("top", "left", "bottom", "right"):
        node = OxmlElement(f"w:{side}")
        spec = left if side == "left" and left else ((4, color) if color else None)
        if spec is None:
            node.set(qn("w:val"), "nil")
        else:
            node.set(qn("w:val"), "single")
            node.set(qn("w:sz"), str(spec[0]))
            node.set(qn("w:color"), spec[1])
        borders.append(node)
    tc_pr.append(borders)


def set_table_geometry(table, widths: list[int], indent: int = 0) -> None:
    tbl_pr = table._tbl.tblPr
    for tag, attrs in (("w:tblW", {"w:w": str(sum(widths)), "w:type": "dxa"}),
                       ("w:tblLayout", {"w:type": "fixed"}),
                       ("w:tblInd", {"w:w": str(indent), "w:type": "dxa"})):
        node = tbl_pr.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            tbl_pr.append(node)
        for key, value in attrs.items():
            node.set(qn(key), value)

    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)

    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            set_cell_width(cell, widths[min(idx, len(widths) - 1)])
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def keep_row_together(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    cant_split.set(qn("w:val"), "true")
    tr_pr.append(cant_split)


def add_field(paragraph, instruction: str, placeholder: str = "") -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = placeholder
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, separate, text, end])
    return run


def add_toc_with_static_result(doc: Document, entries: list[tuple[int, str, str]]) -> None:
    """Create an updatable TOC field whose cached result lists the same levels the field collects."""
    first = doc.add_paragraph()
    begin_run = first.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f'TOC \\o "1-{TOC_LEVELS}" \\h \\z \\u'
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    begin_run._r.extend([begin, instr, separate])

    p = first
    for idx, (level, title, page) in enumerate(entries):
        p = first if idx == 0 else doc.add_paragraph()
        chapter = level == 1
        size = 10.5 if chapter else 10
        p.paragraph_format.left_indent = Inches(0.1 if chapter else 0.45)
        p.paragraph_format.space_before = Pt(5 if chapter and idx else 0)
        p.paragraph_format.space_after = Pt(1.5)
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        add_inline(p, title, size)
        for run in p.runs:
            run.bold = chapter
            if chapter:
                run.font.color.rgb = RGBColor.from_string(NAVY)
            set_east_asia(run, "Yu Gothic" if chapter else "Yu Mincho")
        for text in ("\t", page):
            r = p.add_run(text)
            r.font.size = Pt(size)
            set_east_asia(r, "Yu Gothic")

    end_run = p.add_run()
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run._r.append(end)


def add_hyperlink(paragraph, label: str, url: str, font_size: float | None = None):
    rel_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), rel_id)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    rfonts = OxmlElement("w:rFonts")
    rfonts.set(qn("w:ascii"), "Calibri")
    rfonts.set(qn("w:hAnsi"), "Calibri")
    rfonts.set(qn("w:eastAsia"), "Yu Mincho")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), LINK)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rpr.extend([rfonts, color, underline])
    if font_size:
        for tag in ("w:sz", "w:szCs"):
            size = OxmlElement(tag)
            size.set(qn("w:val"), str(round(font_size * 2)))
            rpr.append(size)
    run.append(rpr)
    text = OxmlElement("w:t")
    text.text = label
    run.append(text)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


TOKEN_RE = re.compile(r"(\[[^\]]+\]\(https?://[^)]+\)|\*\*[^*]+\*\*|`[^`]+`)")


def add_inline(paragraph, text: str, font_size: float | None = None) -> None:
    def plain(value: str) -> None:
        run = paragraph.add_run(value)
        set_east_asia(run, "Yu Mincho")
        if font_size:
            run.font.size = Pt(font_size)

    pos = 0
    for match in TOKEN_RE.finditer(text):
        if match.start() > pos:
            plain(text[pos:match.start()])
        token = match.group(0)
        if token.startswith("[") and "](http" in token:
            label, url = token[1:].split("](", 1)
            add_hyperlink(paragraph, label, url[:-1], font_size)
        elif token.startswith("**"):
            run = paragraph.add_run(token[2:-2])
            run.bold = True
            set_east_asia(run, "Yu Gothic")
            if font_size:
                run.font.size = Pt(font_size)
        else:
            run = paragraph.add_run(token[1:-1])
            run.font.name = "Consolas"
            run.font.color.rgb = RGBColor.from_string(TEAL_DARK)
            run.font.size = Pt((font_size or 10.5) - 0.5)
        pos = match.end()
    if pos < len(text):
        plain(text[pos:])


def set_document_language(doc: Document) -> None:
    """Mark the report as Japanese; the PDF export takes its /Lang (used by screen readers) from here."""
    rpr_default = doc.styles.element.find(qn("w:docDefaults")).find(qn("w:rPrDefault")).find(qn("w:rPr"))
    lang = rpr_default.find(qn("w:lang"))
    if lang is None:
        lang = OxmlElement("w:lang")
        rpr_default.append(lang)
    lang.set(qn("w:val"), DOCUMENT_LANGUAGE)
    lang.set(qn("w:eastAsia"), DOCUMENT_LANGUAGE)
    doc.core_properties.language = DOCUMENT_LANGUAGE


def bottom_rule(style_or_paragraph_element, color: str, size: int) -> None:
    ppr = style_or_paragraph_element.get_or_add_pPr()
    border = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for key, value in (("val", "single"), ("sz", str(size)), ("space", "4"), ("color", color)):
        bottom.set(qn(f"w:{key}"), value)
    border.append(bottom)
    ppr.append(border)


def configure_styles(doc: Document) -> None:
    set_document_language(doc)
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(BODY)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Yu Mincho")
    normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    normal.paragraph_format.line_spacing = 1.4
    normal.paragraph_format.space_after = Pt(7)
    normal.paragraph_format.widow_control = True

    for name, size, color, before, after in (
        ("Title", 26, "FFFFFF", 0, 10),
        ("Subtitle", 13, "FFFFFF", 0, 6),
        ("Heading 1", 16, NAVY, 20, 10),
        ("Heading 2", 12.5, NAVY, 12, 5),
        ("Heading 3", 11.5, NAVY, 8, 4),
    ):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.font.bold = name != "Subtitle"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Yu Gothic")
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.keep_together = True
        style.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        # The bundled Word template can add a blue rule to the Title style.
        for border in style.element.findall(".//" + qn("w:pBdr")):
            border.getparent().remove(border)
    bottom_rule(doc.styles["Heading 1"].element, TEAL, 12)

    # Looks like Heading 1 but has no outline level, so the TOC field (\o, \u) does not collect it.
    front = doc.styles.add_style(FRONT_HEADING, WD_STYLE_TYPE.PARAGRAPH)
    front.base_style = doc.styles["Normal"]
    front.font.name = "Calibri"
    front.font.size = Pt(16)
    front.font.bold = True
    front.font.color.rgb = RGBColor.from_string(NAVY)
    front.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Yu Gothic")
    front.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
    front.paragraph_format.space_before = Pt(6)
    front.paragraph_format.space_after = Pt(12)
    front.paragraph_format.keep_with_next = True
    bottom_rule(front.element, TEAL, 12)

    caption = doc.styles["Caption"]
    caption.font.name = "Calibri"
    caption.font.size = Pt(9.5)
    caption.font.italic = False
    caption.font.color.rgb = RGBColor.from_string(MID_GRAY)
    caption._element.rPr.rFonts.set(qn("w:eastAsia"), "Yu Gothic")
    caption.paragraph_format.space_before = Pt(4)
    caption.paragraph_format.space_after = Pt(6)
    caption.paragraph_format.keep_with_next = True


def add_page_number_footer(section) -> None:
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"{REPORT_NAME}  |  ")
    run.font.size = Pt(8.5)
    run.font.color.rgb = RGBColor.from_string(MID_GRAY)
    set_east_asia(run, "Yu Gothic")
    field = add_field(p, "PAGE", "1")
    field.font.size = Pt(8.5)


def add_running_header(section, text: str) -> None:
    p = section.header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = p.add_run(text)
    run.font.size = Pt(8.5)
    run.font.color.rgb = RGBColor.from_string(MID_GRAY)
    set_east_asia(run, "Yu Gothic")
    p.paragraph_format.space_after = Pt(4)


def configure_page(section) -> None:
    # A4 portrait. The text width (6.61 in) holds full-width tables (9360 twips = 6.5 in).
    section.page_width = Inches(8.27)
    section.page_height = Inches(11.69)
    section.top_margin = Inches(0.85)
    section.bottom_margin = Inches(0.8)
    section.left_margin = Inches(0.83)
    section.right_margin = Inches(0.83)
    section.header_distance = Inches(0.4)
    section.footer_distance = Inches(0.4)


def set_update_fields(doc: Document) -> None:
    settings = doc.settings._element
    update = settings.find(qn("w:updateFields"))
    if update is None:
        update = OxmlElement("w:updateFields")
        settings.append(update)
    update.set(qn("w:val"), "true")


def attach_svg_fallback(doc: Document, inline_shape, svg_path: Path) -> None:
    package = doc.part.package
    partname = package.next_partname("/word/media/image%d.svg")
    svg_part = Part(partname, "image/svg+xml", svg_path.read_bytes(), package)
    rel_id = doc.part.relate_to(svg_part, RT.IMAGE)
    blips = inline_shape._inline.xpath(".//a:blip")
    if not blips:
        raise RuntimeError(f"Could not locate drawing blip for {svg_path}")
    ext_list = OxmlElement("a:extLst")
    ext = OxmlElement("a:ext")
    ext.set("uri", SVG_EXT_URI)
    svg_blip = etree.Element(f"{{{SVG_NS}}}svgBlip", nsmap={"asvg": SVG_NS})
    svg_blip.set(qn("r:embed"), rel_id)
    ext.append(svg_blip)
    ext_list.append(ext)
    blips[0].append(ext_list)


def add_picture_with_alt(doc, path: Path, width: float, alt_text: str, svg_path: Path | None = None) -> None:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.line_spacing = 1.0
    inline_shape = p.add_run().add_picture(str(path), width=Inches(width))
    inline_shape._inline.docPr.set("descr", alt_text)
    if svg_path is not None:
        attach_svg_fallback(doc, inline_shape, svg_path)


def add_front_heading(doc, text: str):
    """A heading before the body (概要, 目次) that the TOC field leaves out."""
    p = doc.add_paragraph(style=FRONT_HEADING)
    set_east_asia(p.add_run(text), "Yu Gothic")
    return p


def add_caption(doc, text: str, above=False) -> None:
    p = doc.add_paragraph(style="Caption")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT if above else WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = above
    p.paragraph_format.keep_together = True
    p.paragraph_format.space_after = Pt(3 if above else 10)
    add_inline(p, text, 9.5)
    for run in p.runs:
        set_east_asia(run, "Yu Gothic")
        run.font.color.rgb = RGBColor.from_string(NAVY if above else MID_GRAY)
        run.bold = above


def clean_cell(text: str) -> str:
    return re.sub(r"[`*_]", "", text.strip())


def widths_for_table(cols: int) -> list[int]:
    base = TABLE_WIDTH // cols
    return [base] * (cols - 1) + [TABLE_WIDTH - base * (cols - 1)]


def estimated_height(rows: list[list[str]], widths: list[int]) -> float:
    """Rough printed height in inches: 8.5 pt text is about 170 twips per full-width character."""
    height = 0.0
    for values in rows:
        lines = max(max(1, -(-len(text) // max(1, (width - 240) // 170))) for text, width in zip(values, widths))
        height += lines * 0.16 + 0.1
    return height


def keep_table_together(table) -> None:
    """Short tables move to the next page whole instead of leaving one row behind."""
    for row in table.rows[:-1]:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.keep_with_next = True


def add_markdown_table(doc, lines: list[str], widths: list[int] | None) -> None:
    rows = []
    for line in lines:
        values = [clean_cell(v) for v in line.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", v.replace(" ", "")) for v in values):
            continue
        rows.append(values)
    if not rows:
        return
    cols = len(rows[0])
    if widths is not None and len(widths) != cols:
        raise ValueError(f"TABLE-WIDTHS has {len(widths)} columns but the table has {cols}: {rows[0]}")
    table = doc.add_table(rows=len(rows), cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    table.autofit = False
    for r_idx, values in enumerate(rows):
        keep_row_together(table.rows[r_idx])
        for c_idx in range(cols):
            cell = table.cell(r_idx, c_idx)
            cell.text = ""
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            p.paragraph_format.space_after = Pt(1.5)
            p.paragraph_format.line_spacing = 1.15
            add_inline(p, values[c_idx] if c_idx < len(values) else "", 8.5)
            set_cell_borders(cell, "C9D3DB")
            if r_idx == 0:
                set_cell_shading(cell, NAVY)
                for run in p.runs:
                    run.bold = True
                    run.font.color.rgb = RGBColor.from_string("FFFFFF")
                    set_east_asia(run, "Yu Gothic")
            elif c_idx == 0:
                set_cell_shading(cell, TEAL_LIGHT)
                for run in p.runs:
                    run.bold = True
                    run.font.color.rgb = RGBColor.from_string(NAVY)
                    set_east_asia(run, "Yu Gothic")
            elif r_idx % 2 == 0:
                set_cell_shading(cell, "FAFBFC")
    repeat_table_header(table.rows[0])
    widths = widths or widths_for_table(cols)
    set_table_geometry(table, widths, indent=60)
    if estimated_height(rows, widths) <= 2.5:
        keep_table_together(table)
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)
    spacer.paragraph_format.line_spacing = 1.0


def create_numbering_instance(doc: Document, ordered: bool) -> int:
    numbering = doc.part.numbering_part.element
    abstract_ids = [int(x.get(qn("w:abstractNumId"))) for x in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(x.get(qn("w:numId"))) for x in numbering.findall(qn("w:num"))]
    abstract_id = (max(abstract_ids) + 1) if abstract_ids else 0
    num_id = (max(num_ids) + 1) if num_ids else 1

    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), "decimal" if ordered else "bullet")
    lvl_text = OxmlElement("w:lvlText")
    lvl_text.set(qn("w:val"), "%1." if ordered else "•")
    suff = OxmlElement("w:suff")
    suff.set(qn("w:val"), "space")
    ppr = OxmlElement("w:pPr")
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "num")
    tab.set(qn("w:pos"), "540")
    tabs.append(tab)
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), "540")
    ind.set(qn("w:hanging"), "280")
    ppr.extend([tabs, ind])
    rpr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), TEAL)
    rpr.append(color)
    lvl.extend([start, num_fmt, lvl_text, suff, ppr, rpr])
    abstract.append(lvl)
    first_num = numbering.find(qn("w:num"))
    if first_num is None:
        numbering.append(abstract)
    else:
        first_num.addprevious(abstract)

    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), str(abstract_id))
    num.append(abstract_ref)
    numbering.append(num)
    return num_id


def add_list_paragraph(doc, text: str, num_id: int) -> None:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    ppr = p._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num_id_el = OxmlElement("w:numId")
    num_id_el.set(qn("w:val"), str(num_id))
    num_pr.extend([ilvl, num_id_el])
    ppr.append(num_pr)
    p.paragraph_format.left_indent = Inches(0.375)
    p.paragraph_format.first_line_indent = Inches(-0.194)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.3
    add_inline(p, text)


def add_code_block(doc, lines: list[str]) -> None:
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_geometry(table, [TABLE_WIDTH], indent=60)
    cell = table.cell(0, 0)
    set_cell_shading(cell, "F4F6F8")
    set_cell_borders(cell, "C9D3DB")
    set_cell_margins(cell, 120, 200, 120, 200)
    for idx, line in enumerate(lines):
        p = cell.paragraphs[0] if idx == 0 else cell.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.2
        run = p.add_run(line)
        run.font.size = Pt(9)
        set_east_asia(run, "Yu Gothic")
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)


def add_figure(doc, key: str, source_dir: Path, assets: dict[str, tuple[Path, Path]]) -> None:
    spec = FIGURES[key]
    width = spec.get("width", FULL_WIDTH)
    if "image" in spec:
        add_picture_with_alt(doc, source_dir / "assets" / spec["image"], width, spec["alt"])
    else:
        png, svg = assets[key]
        add_picture_with_alt(doc, png, width, spec["alt"], svg)


def render_markdown(doc: Document, lines: list[str], source_dir: Path, assets, main_body=False) -> None:
    i = 0
    active_num_id = None
    active_list_kind = None
    pending_widths: list[int] | None = None
    first_appendix = True
    while i < len(lines):
        text = lines[i].strip()
        i += 1
        if not text or text == "---":
            continue
        if not (text.startswith("- ") or re.match(r"^\d+\.\s", text)):
            active_num_id = active_list_kind = None
        if text.startswith("```"):
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i].rstrip())
                i += 1
            i += 1
            add_code_block(doc, block)
            continue
        figure = re.fullmatch(r"\[\[FIGURE:([a-z-]+)\]\]", text)
        if figure:
            add_figure(doc, figure.group(1), source_dir, assets)
            continue
        widths = re.fullmatch(r"\[\[TABLE-WIDTHS:([\d,]+)\]\]", text)
        if widths:
            pending_widths = [int(w) for w in widths.group(1).split(",")]
            continue
        if text == "[[PAGE-BREAK]]":
            doc.add_page_break()
            continue
        if text.startswith("|"):
            table_lines = [text]
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i].strip())
                i += 1
            add_markdown_table(doc, table_lines, pending_widths)
            pending_widths = None
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", text)
        if heading:
            level, title = len(heading.group(1)), heading.group(2)
            p = doc.add_heading(title, level=level)
            if main_body and level == 1 and title.startswith("付録") and first_appendix:
                p.paragraph_format.page_break_before = True
                first_appendix = False
            for run in p.runs:
                set_east_asia(run, "Yu Gothic")
            continue
        if re.match(r"^表[A-Z]?\d+\s", text):
            add_caption(doc, text, above=True)
            continue
        if re.match(r"^図\d+\s", text):
            add_caption(doc, text)
            continue
        numbered = re.match(r"^\d+\.\s+(.+)$", text)
        bullet = re.match(r"^-\s+(.+)$", text)
        if numbered or bullet:
            kind = "ordered" if numbered else "bullet"
            if active_list_kind != kind:
                active_num_id = create_numbering_instance(doc, numbered is not None)
                active_list_kind = kind
            add_list_paragraph(doc, (numbered or bullet).group(1), active_num_id)
            continue
        add_inline(doc.add_paragraph(), text)


def read_front_matter(lines: list[str]) -> dict[str, str]:
    """The title, subtitle and dates written above the abstract."""
    meta = {"title": "", "subtitle": ""}
    for line in lines:
        text = line.strip()
        if text.startswith("# ") and not meta["title"]:
            meta["title"] = text[2:]
        elif text.startswith("## ") and not meta["subtitle"]:
            meta["subtitle"] = text[3:]
        elif re.match(r"^(作成日|対象|区分):", text):
            key, value = text.split(":", 1)
            meta[key] = value.strip()
    return meta


def add_cover(doc: Document, meta: dict[str, str]) -> None:
    # A navy band with the app icon carries the title, as on the app's own screens.
    band = doc.add_table(rows=1, cols=1)
    band.alignment = WD_TABLE_ALIGNMENT.CENTER
    band.autofit = False
    set_table_geometry(band, [TABLE_WIDTH + 120])
    cell = band.cell(0, 0)
    set_cell_shading(cell, NAVY)
    set_cell_borders(cell, None)
    set_cell_margins(cell, 560, 520, 620, 520)

    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_after = Pt(14)
    p.add_run().add_picture(str(ICON), width=Inches(0.62))

    p = cell.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_after = Pt(10)
    r = p.add_run("TECHNICAL REPORT" + (f"　／　{meta['区分']}" if meta.get("区分") else ""))
    r.font.size = Pt(10)
    r.font.bold = True
    r.font.color.rgb = RGBColor.from_string(MINT)
    set_east_asia(r, "Yu Gothic")

    p = cell.add_paragraph(style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.line_spacing = 1.15
    title = meta["title"]
    for marker in COVER_TITLE_BREAKS:
        title = title.replace(marker, marker + "\n", 1)
    for index, part in enumerate(title.strip().split("\n")):
        if index:
            p.add_run().add_break()
        run = p.add_run(part)
        run.bold = True
        run.font.size = Pt(25)
        run.font.color.rgb = RGBColor.from_string("FFFFFF")
        set_east_asia(run, "Yu Gothic")

    p = cell.add_paragraph(style="Subtitle")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_before = Pt(6)
    run = p.add_run(meta["subtitle"])
    run.font.size = Pt(13)
    run.font.color.rgb = RGBColor.from_string("E6FFFB")
    set_east_asia(run, "Yu Gothic")

    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(18)

    box = doc.add_table(rows=1, cols=1)
    box.alignment = WD_TABLE_ALIGNMENT.CENTER
    box.autofit = False
    set_table_geometry(box, [9000])
    cell = box.cell(0, 0)
    set_cell_shading(cell, TEAL_LIGHT)
    set_cell_borders(cell, None, left=(36, TEAL))
    set_cell_margins(cell, 160, 260, 160, 260)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_inline(p, "個人用：1人で使うデスクトップ版　／　チーム用：社内LANのサーバーで共有", 11)
    for run in p.runs:
        run.bold = True
        run.font.color.rgb = RGBColor.from_string(TEAL_DARK)
        set_east_asia(run, "Yu Gothic")

    for index, key in enumerate(("作成日", "対象")):
        if key not in meta:
            continue
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(4)
        if index == 0:
            p.paragraph_format.space_before = Pt(150)
        add_inline(p, f"{key}　{meta[key]}", 11 if key == "作成日" else 10)
        for run in p.runs:
            set_east_asia(run, "Yu Gothic")


def toc_headings(body_lines: list[str]) -> list[tuple[int, str]]:
    """The headings the TOC field collects (levels 1 to TOC_LEVELS), in document order."""
    headings = []
    in_code = False
    for line in body_lines:
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        heading = None if in_code else re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if heading and len(heading.group(1)) <= TOC_LEVELS:
            headings.append((len(heading.group(1)), heading.group(2)))
    titles = [title for _, title in headings]
    if len(titles) != len(set(titles)):
        raise ValueError("TOC headings must be unique to record their pages")
    return headings


def toc_path(source: Path) -> Path:
    """Where the TOC pages of a source are recorded. Each source (e.g. a revised copy) keeps its own file."""
    name = "toc_pages.json" if source.stem == "HAKOBI_TECHNICAL_REPORT" else f"toc_pages_{source.stem}.json"
    return source.parent / "tools" / name


def toc_entries(body_lines: list[str], pages: dict[str, int]) -> list[tuple[int, str, str]]:
    return [(level, title, str(pages.get(title, "–"))) for level, title in toc_headings(body_lines)]


def build(source: Path, output: Path) -> None:
    lines = source.read_text(encoding="utf-8").splitlines()
    body_idx = next(i for i, line in enumerate(lines) if re.match(r"^# 1\.", line.strip()))
    abstract_idx = next(i for i, line in enumerate(lines[:body_idx]) if line.strip() == "## 概要")
    meta = read_front_matter(lines[:abstract_idx])
    abstract_lines = lines[abstract_idx + 1:body_idx]
    body_lines = lines[body_idx:]

    toc_file = toc_path(source)
    pages = json.loads(toc_file.read_text(encoding="utf-8")) if toc_file.exists() else {}

    output.parent.mkdir(parents=True, exist_ok=True)
    assets = build_diagrams(source.parent / "assets")

    doc = Document()
    configure_styles(doc)
    configure_page(doc.sections[0])
    doc.sections[0].different_first_page_header_footer = True
    add_running_header(doc.sections[0], meta["title"])
    add_page_number_footer(doc.sections[0])
    doc.core_properties.title = meta["title"]
    doc.core_properties.subject = meta["subtitle"]
    doc.core_properties.author = ""
    doc.core_properties.keywords = "HAKOBI, ガントチャート, 進捗共有, 見える化, 定例, 週報, Electron, React, SQLite"
    doc.core_properties.comments = f"{meta.get('対象', '')}の技術報告（作成日 {meta.get('作成日', '')}）"
    set_update_fields(doc)

    add_cover(doc, meta)
    doc.add_page_break()

    add_front_heading(doc, "概要")
    render_markdown(doc, abstract_lines, source.parent, assets)
    doc.add_page_break()

    add_front_heading(doc, "目次").paragraph_format.space_after = Pt(16)
    add_toc_with_static_result(doc, toc_entries(body_lines, pages))
    doc.add_page_break()

    render_markdown(doc, body_lines, source.parent, assets, main_body=True)
    # Word needs a paragraph after the last table; make it tiny so it cannot spill onto an empty page.
    last = doc.paragraphs[-1]
    if not last.text:
        last.paragraph_format.space_before = Pt(0)
        last.paragraph_format.space_after = Pt(0)
        last.paragraph_format.line_spacing = Pt(1)
        last.add_run().font.size = Pt(1)

    for section in doc.sections:
        configure_page(section)
    doc.save(output)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_report_docx.py SOURCE.md OUTPUT.docx")
    build(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
