"""Build the current 16-page HAKOBI introduction from its Markdown source.

Run with the bundled workspace Python, from a writable workspace directory.
The default source is report-readable.md, the checked readability revision.
No placeholder screenshots are generated. Crop windows and image heights are
collected in IMAGE_SPECS for the final screenshot/layout review.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Callable

from PIL import Image
import pypdfium2 as pdfium
from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.shared import Mm, Pt, RGBColor
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets-current"
BUILD = ROOT / ".build" / "current"
FONT = "Yu Gothic"
TEXT_WIDTH_MM = 174.0
BODY_PT = 10.5
BODY_LINE_PT = 15.0
BLACK = "000000"
BODY_COLOR = "172B3A"
MUTED = "526271"
TABLE_HEADER = "17364D"
DIAGRAM_INK = "233847"
DIAGRAM_ACCENT = "215B78"
DIAGRAM_LINE = "6B7C86"


@dataclass(frozen=True)
class ImageSpec:
    max_height_mm: float
    # Fractions of the original image, in left/top/right/bottom order.
    # Applied to portrait screenshots; a supplied landscape crop is preserved.
    portrait_crop: tuple[float, float, float, float] | None = None
    # Position within the crop window when a further vertical crop is required.
    # 0 preserves its top, .5 its middle, and 1 its bottom.
    vertical_anchor: float = 0.0
    alternatives: tuple[str, ...] = ()
    diagram: bool = False


# Current screenshot sources have a 1759 x 1244 viewport.
# Crop only actual UI pixels to the content explained on each page.
IMAGE_SPECS: dict[str, ImageSpec] = {
    'gantt.png': ImageSpec(103, (0.0, 0.0450161, 0.704946, 0.6270096)),
    'gantt-focus.png': ImageSpec(86, (0.0, 0.0836013, 0.704946, 0.4622186), alternatives=('gantt.png',)),
    'detail.png': ImageSpec(96, (0.0, 0.1245981, 0.764639, 0.7073955)),
    'checklist.png': ImageSpec(94, (0.1080159, 0.0522508, 0.8897101, 0.6350482)),
    'kanban.png': ImageSpec(62, (0.004548, 0.0546624, 0.9948835, 0.4903537)),
    'plan.png': ImageSpec(78, (0.0085276, 0.2122186, 0.6139852, 0.562701)),
    'worklogs-focus.png': ImageSpec(55, (0.0085276, 0.0522508, 0.5287095, 0.2692926), alternatives=('worklogs.png',)),
    'progress.png': ImageSpec(87, (0.2615122, 0.1366559, 0.7305287, 0.4541801)),
    'team.png': ImageSpec(60, (0.0085276, 0.0522508, 0.9920409, 0.4863344)),
    'command.png': ImageSpec(48, (0.3155202, 0.1165595, 0.6850483, 0.2572347)),
    'report.png': ImageSpec(116, (0.1051734, 0.0522508, 0.8857305, 0.7918006)),
    'meeting.png': ImageSpec(85, (0.0, 0.0, 0.9977259807, 0.4823151125)),
    'daily-flow.png': ImageSpec(45, diagram=True),
    'architecture.png': ImageSpec(69, diagram=True),
    'weekly-flow.png': ImageSpec(43, diagram=True),
    'migration-flow.png': ImageSpec(34, diagram=True),
}

GENERATED_FIGURES = {
    "daily-flow.png", "architecture.png", "weekly-flow.png", "migration-flow.png"
}


def xml_bool(parent, name: str, value: bool) -> None:
    for element in list(parent.findall(qn("w:" + name))):
        parent.remove(element)
    element = OxmlElement("w:" + name)
    element.set(qn("w:val"), "1" if value else "0")
    parent.append(element)


def clear_decoration(parent) -> None:
    for name in ("pBdr", "shd"):
        for element in list(parent.findall(qn("w:" + name))):
            parent.remove(element)


def disable_grid(paragraph) -> None:
    properties = paragraph._p.get_or_add_pPr()
    xml_bool(properties, "snapToGrid", False)
    clear_decoration(properties)


def set_font(properties, *, size: float, bold: bool = False, color: str = BODY_COLOR) -> None:
    """Set all scripts explicitly, without inherited theme fonts/colors."""
    rfonts = properties.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        properties.insert(0, rfonts)
    for name in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn("w:" + name), FONT)
    for name in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme", "csTheme"):
        rfonts.attrib.pop(qn("w:" + name), None)
    for name in ("sz", "szCs"):
        for old in list(properties.findall(qn("w:" + name))):
            properties.remove(old)
        element = OxmlElement("w:" + name)
        element.set(qn("w:val"), str(round(size * 2)))
        properties.append(element)
    for old in list(properties.findall(qn("w:color"))):
        properties.remove(old)
    element = OxmlElement("w:color")
    element.set(qn("w:val"), color)
    properties.append(element)
    xml_bool(properties, "b", bold)
    xml_bool(properties, "bCs", bold)
    xml_bool(properties, "i", False)
    xml_bool(properties, "iCs", False)


def style_font(style, size: float, *, bold: bool = False, color: str = BODY_COLOR) -> None:
    style.font.name = FONT
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.italic = False
    style.font.color.rgb = RGBColor.from_string(color)
    set_font(style.element.get_or_add_rPr(), size=size, bold=bold, color=color)


def prepare_document():
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.top_margin = section.bottom_margin = Mm(17)
    section.left_margin = section.right_margin = Mm(18)
    section.header_distance, section.footer_distance = Mm(5), Mm(8)
    # Remove the document grid and opt every paragraph style out of grid snapping.
    for grid in list(section._sectPr.findall(qn("w:docGrid"))):
        section._sectPr.remove(grid)
    for style in doc.styles:
        if style.type == 1:
            properties = style.element.get_or_add_pPr()
            xml_bool(properties, "snapToGrid", False)
            clear_decoration(properties)

    normal = doc.styles["Normal"]
    style_font(normal, BODY_PT)
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    normal.paragraph_format.line_spacing = Pt(BODY_LINE_PT)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.widow_control = True

    for name, size, leading, before, after in (
        ("Title", 26, 32, 0, 8),
        ("Subtitle", 12, 17, 0, 6),
        ("Heading 1", 19, 25, 0, 7),
        ("Heading 2", 12.5, 18, 8, 4),
        ("Heading 3", 11.5, 17, 6, 3),
    ):
        style = doc.styles[name]
        style_font(style, size, bold=name != "Subtitle", color=BLACK)
        style.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        style.paragraph_format.line_spacing = Pt(leading)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    caption = doc.styles["Caption"]
    style_font(caption, 8.5, color=MUTED)
    caption.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    caption.paragraph_format.line_spacing = Pt(12)
    caption.paragraph_format.space_before = Pt(0)
    caption.paragraph_format.space_after = Pt(7)

    # A normal indented paragraph, with no shading, rule, box, or monospace font.
    for name, size, leading in (("Code Text", 9.5, 13), ("Quote Text", 10.5, 15)):
        if name not in doc.styles:
            doc.styles.add_style(name, 1)
        style = doc.styles[name]
        style.base_style = normal
        style_font(style, size)
        style.paragraph_format.left_indent = Mm(4)
        style.paragraph_format.right_indent = Mm(2)
        style.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        style.paragraph_format.line_spacing = Pt(leading)
        style.paragraph_format.space_before = style.paragraph_format.space_after = Pt(0)
        style.paragraph_format.keep_with_next = False
        style.paragraph_format.keep_together = True

    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        style_font(style, BODY_PT)
        style.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        style.paragraph_format.line_spacing = Pt(BODY_LINE_PT)
        style.paragraph_format.space_before = Pt(0)
        style.paragraph_format.space_after = Pt(4)
        style.paragraph_format.keep_with_next = False

    doc.core_properties.title = "HAKOBI 利用案内"
    doc.core_properties.subject = "日々のタスク管理 進捗共有 定例と週報への活用"
    doc.core_properties.author = ""
    doc.core_properties.comments = ""
    doc.core_properties.keywords = "HAKOBI ガント タスク 進捗 定例 週報"

    footer = section.footer.paragraphs[0]
    disable_grid(footer)
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    footer.paragraph_format.space_after = footer.paragraph_format.space_before = Pt(0)
    footer.paragraph_format.line_spacing = Pt(11)
    run = footer.add_run("HAKOBI 利用案内    ")
    set_font(run._r.get_or_add_rPr(), size=8, color=MUTED)
    for index, instruction in enumerate(("PAGE", "NUMPAGES")):
        if index:
            run = footer.add_run(" / ")
            set_font(run._r.get_or_add_rPr(), size=8, color=MUTED)
        field = OxmlElement("w:fldSimple")
        field.set(qn("w:instr"), instruction)
        field_run = OxmlElement("w:r")
        properties = OxmlElement("w:rPr")
        set_font(properties, size=8, color=MUTED)
        field_run.append(properties)
        value = OxmlElement("w:t")
        value.text = "1" if instruction == "PAGE" else "16"
        field_run.append(value)
        field.append(field_run)
        footer._p.append(field)
    return doc


INLINE_PATTERN = re.compile(r"(\*\*.*?\*\*|`[^`]+`|\[[^\]]+\]\([^\)]+\))")


def inline_text(paragraph, text: str, *, size: float | None = None, color: str | None = None) -> None:
    """Keep prose editable, and emit actual OOXML hyperlinks for Markdown links."""
    for piece in INLINE_PATTERN.split(text):
        if not piece:
            continue
        link = re.fullmatch(r"\[([^\]]+)\]\(([^\)]+)\)", piece)
        if link:
            node = OxmlElement("w:hyperlink")
            node.set(qn("r:id"), paragraph.part.relate_to(link.group(2), RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
            run_node = OxmlElement("w:r")
            properties = OxmlElement("w:rPr")
            set_font(properties, size=size or BODY_PT, color=color or "215B78")
            run_node.append(properties)
            value = OxmlElement("w:t")
            value.text = link.group(1)
            run_node.append(value)
            node.append(run_node)
            paragraph._p.append(node)
            continue
        bold = piece.startswith("**") and piece.endswith("**")
        if bold:
            piece = piece[2:-2]
        elif piece.startswith("`") and piece.endswith("`"):
            piece = piece[1:-1]
        run = paragraph.add_run(piece)
        if bold:
            run.bold = True
        if size is not None:
            run.font.size = Pt(size)
        if color is not None:
            run.font.color.rgb = RGBColor.from_string(color)


def add_paragraph(doc, text: str = "", *, style: str | None = None):
    paragraph = doc.add_paragraph(style=style)
    disable_grid(paragraph)
    inline_text(paragraph, text)
    # Tighten only these paragraphs slightly, to avoid a final line of
    # one or two Japanese characters. This changes typography, not the text.
    if text.startswith((
        "毎回同じ形式の週報を作るなら、",
        "チームの管理者が設定の「チーム管理」から",
        "チーム用はサーバーへの接続が必要です。",
        "デスクトップ版のチーム接続には、",
        "カンバンは仕事を状態ごとのカードで見る画面です。",
        "タスクにひも付けて計測すると、",
    )):
        for run in paragraph.runs:
            spacing = OxmlElement("w:spacing")
            spacing.set(qn("w:val"), "-8" if text.startswith("チームの管理者が設定の") else "-4")
            run._r.get_or_add_rPr().append(spacing)
    return paragraph


def new_numbering(doc, *, decimal: bool, start: int = 1) -> int:
    """Create a real Word list, with independent numbering for each list."""
    root = doc.part.numbering_part.element
    abstract_ids = [int(e.get(qn("w:abstractNumId"))) for e in root.findall(qn("w:abstractNum"))]
    num_ids = [int(e.get(qn("w:numId"))) for e in root.findall(qn("w:num"))]
    abstract_id, num_id = max(abstract_ids, default=-1) + 1, max(num_ids, default=0) + 1
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multilevel = OxmlElement("w:multiLevelType")
    multilevel.set(qn("w:val"), "singleLevel")
    abstract.append(multilevel)
    level = OxmlElement("w:lvl")
    level.set(qn("w:ilvl"), "0")
    for name, value in (("start", str(start)), ("numFmt", "decimal" if decimal else "bullet"), ("lvlText", "%1." if decimal else "•"), ("lvlJc", "left")):
        element = OxmlElement("w:" + name)
        element.set(qn("w:val"), value)
        level.append(element)
    properties = OxmlElement("w:pPr")
    indent = OxmlElement("w:ind")
    indent.set(qn("w:left"), "300")
    indent.set(qn("w:hanging"), "235")
    properties.append(indent)
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "num")
    tab.set(qn("w:pos"), "300")
    tabs.append(tab)
    properties.append(tabs)
    level.append(properties)
    abstract.append(level)
    # OOXML places abstract definitions before the concrete <w:num> instances.
    first_number = root.find(qn("w:num"))
    if first_number is None:
        root.append(abstract)
    else:
        root.insert(list(root).index(first_number), abstract)
    number = OxmlElement("w:num")
    number.set(qn("w:numId"), str(num_id))
    reference = OxmlElement("w:abstractNumId")
    reference.set(qn("w:val"), str(abstract_id))
    number.append(reference)
    root.append(number)
    return num_id


def list_paragraph(doc, text: str, *, number_id: int, decimal: bool):
    paragraph = add_paragraph(doc, text, style="List Number" if decimal else "List Bullet")
    properties = paragraph._p.get_or_add_pPr()
    for old in list(properties.findall(qn("w:numPr"))):
        properties.remove(old)
    number = OxmlElement("w:numPr")
    for name, value in (("ilvl", "0"), ("numId", str(number_id))):
        element = OxmlElement("w:" + name)
        element.set(qn("w:val"), value)
        number.append(element)
    properties.append(number)
    return paragraph


def add_table(doc, rows: list[list[str]]) -> None:
    columns = len(rows[0])
    if any(len(row) != columns for row in rows):
        raise ValueError("Markdown table rows have inconsistent cell counts")
    ratios = {
        "比較する項目": (0.23, 0.31, 0.46),
        "入力する場所": (0.16, 0.28, 0.56),
        "使い分け": (0.28, 0.34, 0.38),
    }.get(rows[0][0], tuple(1 / columns for _ in range(columns)))
    table = doc.add_table(rows=0, cols=columns)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for column, ratio in zip(table.columns, ratios):
        column.width = Mm(TEXT_WIDTH_MM * ratio)
    properties = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for name in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement("w:" + name)
        for key, value in (("val", "single"), ("sz", "4"), ("color", "D9D9D9")):
            element.set(qn("w:" + key), value)
        borders.append(element)
    properties.append(borders)
    for row_index, values in enumerate(rows):
        row = table.add_row()
        row_properties = row._tr.get_or_add_trPr()
        row_properties.append(OxmlElement("w:cantSplit"))
        if row_index == 0:
            row_properties.append(OxmlElement("w:tblHeader"))
        for column_index, (cell, value) in enumerate(zip(row.cells, values)):
            cell.width = Mm(TEXT_WIDTH_MM * ratios[column_index])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            cell_properties = cell._tc.get_or_add_tcPr()
            shading = OxmlElement("w:shd")
            shading.set(qn("w:fill"), TABLE_HEADER if row_index == 0 else ("F3F6F9" if row_index % 2 == 0 else "FFFFFF"))
            cell_properties.append(shading)
            margins = OxmlElement("w:tcMar")
            for name, value_twips in (("top", 90), ("bottom", 90), ("left", 105), ("right", 105)):
                element = OxmlElement("w:" + name)
                element.set(qn("w:w"), str(value_twips))
                element.set(qn("w:type"), "dxa")
                margins.append(element)
            cell_properties.append(margins)
            paragraph = cell.paragraphs[0]
            disable_grid(paragraph)
            paragraph.paragraph_format.space_before = paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
            paragraph.paragraph_format.line_spacing = Pt(13.5)
            paragraph.paragraph_format.keep_with_next = row_index == 0
            paragraph.paragraph_format.keep_together = True
            inline_text(paragraph, value, size=9.5, color="FFFFFF" if row_index == 0 else BODY_COLOR)
            if row_index == 0:
                for run in paragraph.runs:
                    run.bold = True
    gap = add_paragraph(doc)
    gap.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    gap.paragraph_format.line_spacing = Pt(2)
    gap.paragraph_format.space_after = Pt(3)
    gap.add_run().font.size = Pt(2)


def register_diagram_fonts() -> None:
    pdfmetrics.registerFont(TTFont("YuCurrent", "C:/Windows/Fonts/YuGothR.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("YuCurrentBold", "C:/Windows/Fonts/YuGothB.ttc", subfontIndex=0))


def diagram_text(c, x: float, y: float, value: str, *, size: float = 10, bold: bool = False, center: bool = False, color: str = DIAGRAM_INK) -> None:
    c.setFillColor(colors.HexColor("#" + color))
    c.setFont("YuCurrentBold" if bold else "YuCurrent", size)
    (c.drawCentredString if center else c.drawString)(x, y, value)


def arrow(c, x1: float, y1: float, x2: float, y2: float, *, double: bool = False) -> None:
    c.setStrokeColor(colors.HexColor("#" + DIAGRAM_LINE))
    c.setFillColor(colors.HexColor("#" + DIAGRAM_LINE))
    c.setLineWidth(1)
    c.line(x1, y1, x2, y2)
    angle = math.atan2(y2 - y1, x2 - x1)
    def head(x, y, a):
        path = c.beginPath()
        path.moveTo(x, y)
        path.lineTo(x - 5 * math.cos(a - .45), y - 5 * math.sin(a - .45))
        path.lineTo(x - 5 * math.cos(a + .45), y - 5 * math.sin(a + .45))
        path.close()
        c.drawPath(path, fill=1, stroke=0)
    head(x2, y2, angle)
    if double:
        head(x1, y1, angle + math.pi)


def process(c, x: float, y: float, width: float, height: float, title: str, detail: tuple[str, ...] = ()) -> None:
    # Rectangles here are process/system nodes connected by arrows, not prose cards.
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.HexColor("#" + DIAGRAM_LINE))
    c.setLineWidth(.8)
    c.rect(x, y, width, height, stroke=1, fill=0)
    title_y = y + height - (21 if detail else height / 2 + 4)
    diagram_text(c, x + width / 2, title_y, title, size=11, bold=True, center=True)
    for index, line in enumerate(detail):
        diagram_text(c, x + width / 2, title_y - 19 - index * 15, line, size=9, center=True)


def draw_daily(c) -> None:
    titles = ("朝の予定", "作業の区切り", "定例で相談", "週報の下書き")
    details = (("ガントで確認",), ("短い進捗ログ",), ("決定をタスクへ",), ("記録をCopilotへ",))
    for index, (title, detail) in enumerate(zip(titles, details)):
        x = 5 + index * 130
        process(c, x, 26, 112, 64, title, detail)
        if index < 3:
            arrow(c, x + 115, 58, x + 127, 58)
    diagram_text(c, 256, 7, "一度残した記録を次の確認や報告に使う", size=9, center=True)


def draw_architecture(c) -> None:
    diagram_text(c, 18, 184, "個人用", size=12, bold=True)
    diagram_text(c, 218, 184, "チーム用", size=12, bold=True)
    c.setStrokeColor(colors.HexColor("#D9D9D9"))
    c.line(191, 15, 191, 185)
    process(c, 18, 71, 150, 84, "自分のPC", ("デスクトップ版", "PC内にデータを保存"))
    diagram_text(c, 93, 39, "1人で使う", size=10, center=True)
    process(c, 217, 116, 124, 45, "ブラウザ")
    process(c, 368, 116, 129, 45, "デスクトップ版")
    process(c, 268, 17, 174, 61, "LANサーバー", ("タスク・進捗・作業記録",))
    arrow(c, 279, 115, 316, 79, double=True)
    arrow(c, 432, 115, 395, 79, double=True)
    diagram_text(c, 356, 92, "同じデータへ接続", size=8.5, center=True)


def draw_weekly(c) -> None:
    titles = ("報告タブ", "文章をコピー", "週報エージェント", "本人が確認")
    details = (("期間・担当を選ぶ",), ("Markdown",), ("記録から下書き",), ("整えて提出",))
    for index, (title, detail) in enumerate(zip(titles, details)):
        x = 5 + index * 130
        process(c, x, 26, 112, 64, title, detail)
        if index < 3:
            arrow(c, x + 115, 58, x + 127, 58)
    diagram_text(c, 125, 103, "HAKOBI", size=9, bold=True, center=True)
    diagram_text(c, 380, 103, "Microsoft 365 Copilot", size=9, bold=True, center=True)
    diagram_text(c, 256, 7, "人が報告Markdownを渡し 下書きの内容を確認する運用", size=9, center=True)


def draw_migration(c) -> None:
    for x, title, detail in (
        (5, "個人用データ", ("todo.dbを用意",)),
        (180, "管理者が確認", ("メンバー指定・ドライラン",)),
        (355, "チーム用へ取り込み", ("以後はチームに接続",)),
    ):
        process(c, x, 25, 151, 61, title, detail)
        if x < 355:
            arrow(c, x + 155, 55, x + 171, 55)
    diagram_text(c, 256, 6, "個人用DBとチーム用DBは自動同期しません", size=9, center=True)


def generate_figures() -> None:
    register_diagram_fonts()
    ASSETS.mkdir(parents=True, exist_ok=True)
    figure_directory = BUILD / "figures"
    figure_directory.mkdir(parents=True, exist_ok=True)
    figures: tuple[tuple[str, int, int, Callable], ...] = (
        ("daily-flow.png", 512, 120, draw_daily),
        ("architecture.png", 512, 202, draw_architecture),
        ("weekly-flow.png", 512, 120, draw_weekly),
        ("migration-flow.png", 512, 100, draw_migration),
    )
    for name, width, height, draw in figures:
        pdf_path = figure_directory / (Path(name).stem + ".pdf")
        c = canvas.Canvas(str(pdf_path), pagesize=(width, height))
        c.setFillColor(colors.white)
        c.rect(0, 0, width, height, fill=1, stroke=0)
        draw(c)
        c.save()
        pdf = pdfium.PdfDocument(str(pdf_path))
        page = pdf[0]
        bitmap = page.render(scale=3)
        bitmap.to_pil().save(ASSETS / name)
        bitmap.close()
        page.close()
        pdf.close()


def resolve_image(reference: str) -> Path:
    requested = ROOT / reference
    if requested.is_file():
        return requested
    spec = IMAGE_SPECS.get(requested.name)
    for alternative in spec.alternatives if spec else ():
        candidate = requested.parent / alternative
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"Required screenshot is missing: {requested}")


def prepare_image(reference: str, manifest: list[dict]) -> Path:
    requested = Path(reference)
    source = resolve_image(reference)
    spec = IMAGE_SPECS.get(requested.name, ImageSpec(85))
    with Image.open(source) as original:
        original.load()
        width, height = original.size
        left, top, right, bottom = 0, 0, width, height
        if not spec.diagram and spec.portrait_crop:
            a, b, c, d = spec.portrait_crop
            left, top, right, bottom = round(width * a), round(height * b), round(width * c), round(height * d)
        if not (0 <= left < right <= width and 0 <= top < bottom <= height):
            raise ValueError(f"Invalid crop bounds for {source.name}: {(left, top, right, bottom)}")
        cropped_width = right - left
        max_pixels_high = max(1, round(cropped_width * spec.max_height_mm / TEXT_WIDTH_MM))
        if bottom - top > max_pixels_high:
            if spec.diagram:
                raise ValueError(f"Diagram {source.name} is too tall for its configured height; adjust its diagram design")
            surplus = bottom - top - max_pixels_high
            top += round(surplus * spec.vertical_anchor)
            bottom = top + max_pixels_high
        cropped = original.crop((left, top, right, bottom))
        destination = BUILD / "crops" / requested.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(destination)
        displayed_height = TEXT_WIDTH_MM * cropped.height / cropped.width
    manifest.append({
        "reference": reference,
        "source": str(source),
        "source_pixels": [width, height],
        "crop_pixels": [left, top, right, bottom],
        "display_width_mm": TEXT_WIDTH_MM,
        "display_height_mm": round(displayed_height, 2),
    })
    return destination


def add_image(doc, reference: str, caption: str, manifest: list[dict]) -> None:
    image_path = prepare_image(reference, manifest)
    paragraph = add_paragraph(doc)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # An inline image needs an automatic line box. Exact text leading clips it.
    paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    paragraph.paragraph_format.line_spacing = 1
    paragraph.paragraph_format.space_before = Pt(1)
    paragraph.paragraph_format.space_after = Pt(3)
    paragraph.paragraph_format.keep_with_next = True
    picture = paragraph.add_run().add_picture(str(image_path), width=Mm(TEXT_WIDTH_MM))
    picture._inline.docPr.set("descr", caption)
    caption_paragraph = add_paragraph(doc, caption, style="Caption")
    caption_paragraph.paragraph_format.keep_together = True


def table_separator(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-+:?", value.replace(" ", "")) for value in cells)


def source_counts(lines: list[str]) -> tuple[int, int]:
    chapters = tables = 0
    previous_table = in_code = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            previous_table = False
            continue
        if in_code:
            continue
        if stripped.startswith("## "):
            chapters += 1
        is_table = stripped.startswith("|")
        if is_table and not previous_table:
            tables += 1
        previous_table = is_table
    if in_code:
        raise ValueError("Markdown source has an unclosed fenced code block")
    return chapters, tables


def build_document(source: Path, output: Path) -> dict:
    raw = source.read_bytes()
    text_source = raw.decode("utf-8-sig")
    lines = text_source.splitlines()
    chapter_count, table_count = source_counts(lines)
    if chapter_count != 16 or table_count != 3:
        raise ValueError(f"Expected 16 chapters and 3 tables; found {chapter_count} chapters and {table_count} tables")
    # Validate screenshots before creating figures or changing the final DOCX.
    for line in lines:
        match = re.fullmatch(r"!\[(.*?)\]\((.*?)\)", line.strip())
        if match and Path(match.group(2)).name not in GENERATED_FIGURES:
            resolve_image(match.group(2))
    BUILD.mkdir(parents=True, exist_ok=True)
    generate_figures()
    doc = prepare_document()
    index = chapter_number = 0
    manifest: list[dict] = []
    while index < len(lines):
        line = lines[index].strip()
        if not line or line.startswith("# "):
            index += 1
            continue
        if line.startswith("## "):
            chapter_number += 1
            if chapter_number == 1:
                add_paragraph(doc, "HAKOBI 利用案内", style="Title")
            heading = add_paragraph(doc, line[3:], style="Heading 1")
            heading.paragraph_format.page_break_before = chapter_number > 1
            index += 1
            continue
        if line.startswith("### "):
            add_paragraph(doc, line[4:], style="Heading 2")
            index += 1
            continue
        if line.startswith("```"):
            index += 1
            block_paragraphs = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                paragraph = doc.add_paragraph(style="Code Text")
                disable_grid(paragraph)
                paragraph.add_run(lines[index])
                block_paragraphs.append(paragraph)
                index += 1
            if block_paragraphs:
                block_paragraphs[0].paragraph_format.space_before = Pt(3)
                block_paragraphs[-1].paragraph_format.space_after = Pt(6)
            index += 1
            continue
        if line.startswith("|"):
            rows = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [value.strip() for value in lines[index].strip().strip("|").split("|")]
                if not table_separator(cells):
                    rows.append(cells)
                index += 1
            add_table(doc, rows)
            continue
        match = re.fullmatch(r"!\[(.*?)\]\((.*?)\)", line)
        if match:
            add_image(doc, match.group(2), match.group(1), manifest)
            index += 1
            continue
        decimal = re.match(r"^(\d+)\.\s+(.+)$", line)
        bullet = re.match(r"^-\s+(.+)$", line)
        if decimal or bullet:
            is_decimal = bool(decimal)
            start = int(decimal.group(1)) if decimal else 1
            number_id = new_numbering(doc, decimal=is_decimal, start=start)
            while index < len(lines):
                next_line = lines[index].strip()
                item = re.match(r"^(\d+)\.\s+(.+)$", next_line) if is_decimal else re.match(r"^-\s+(.+)$", next_line)
                if not item:
                    break
                list_paragraph(doc, item.group(2) if is_decimal else item.group(1), number_id=number_id, decimal=is_decimal)
                index += 1
            continue
        if line.startswith("> "):
            paragraph = add_paragraph(doc, line[2:], style="Quote Text")
            paragraph.paragraph_format.space_after = Pt(6)
            index += 1
            continue
        add_paragraph(doc, line)
        index += 1
    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)
    result = {
        "docx": str(output),
        "source": str(source),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "source_characters": len(text_source),
        "planned_pages": chapter_count,
        "table_count": table_count,
        "font": FONT,
        "body_pt": BODY_PT,
        "body_exact_line_pt": BODY_LINE_PT,
        "images": manifest,
        "render_required": True,
    }
    (BUILD / "build-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "report-readable.md")
    parser.add_argument("--output", type=Path, default=ROOT / "HAKOBI_利用案内_推敲版.docx")
    arguments = parser.parse_args()
    source = arguments.source if arguments.source.is_absolute() else ROOT / arguments.source
    output = arguments.output if arguments.output.is_absolute() else ROOT / arguments.output
    result = build_document(source, output)
    print(json.dumps({key: value for key, value in result.items() if key != "images"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
