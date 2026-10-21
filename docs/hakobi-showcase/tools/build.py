"""Build the six-page, editable HAKOBI introduction and its PDF from Markdown.

Use the bundled Python runtime. Screens are actual app captures produced by
capture.cjs. This builder only crops the source pixels; it does not redraw UI.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
FONT = 'Yu Gothic'
CROPS = {
    'gantt-wide': ('gantt', (0, 60, 1440, 430), 174),
    'gantt-task': ('gantt', (10, 329, 1428, 425), 174),
    'team-focus': ('team', (515, 276, 1420, 575), 174),
    'discussion': ('progress', (560, 348, 1377, 674), 174),
    'log-entry': ('detail', (518, 469, 1404, 540), 174),
    'meeting-focus': ('meeting', None, 174),
    'meeting-task': ('gantt-after-meeting', (0, 60, 1440, 470), 174),
    'report-focus': ('report-settings', (514, 76, 1410, 282), 174),
    'quickadd-focus': ('quickadd', None, 140),
}

def font(run, size=11, bold=False, color='233544'):
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)
    props = run._element.get_or_add_rPr()
    fonts = props.find(qn('w:rFonts'))
    if fonts is None:
        fonts = OxmlElement('w:rFonts'); props.insert(0, fonts)
    for key in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
        fonts.set(qn('w:' + key), FONT)
    for key in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme'):
        fonts.attrib.pop(qn('w:' + key), None)

def add_text(doc, text, *, style=None):
    p = doc.add_paragraph(style=style)
    # Keep actual body text editable, including numbered steps.
    font(p.add_run(text), 11)
    return p

def prepare():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin, sec.bottom_margin = Mm(18), Mm(17)
    sec.left_margin = sec.right_margin = Mm(18)
    sec.header_distance, sec.footer_distance = Mm(7), Mm(7)
    for grid in list(sec._sectPr.findall(qn('w:docGrid'))):
        sec._sectPr.remove(grid)
    for s in doc.styles:
        if s.type != 1: continue
        s.font.name = FONT
        s.font.color.rgb = RGBColor(0, 0, 0)
        s.paragraph_format.line_spacing = Pt(16.5)
        s.paragraph_format.space_after = Pt(6)
        ppr = s.element.get_or_add_pPr()
        for decoration in list(ppr):
            if decoration.tag in (qn('w:pBdr'),qn('w:shd')):ppr.remove(decoration)
        snap = OxmlElement('w:snapToGrid'); snap.set(qn('w:val'),'0');ppr.append(snap)
    for name, size in [('Title',20),('Heading 1',20),('Heading 2',12.5)]:
        s=doc.styles[name];s.font.name=FONT;s.font.size=Pt(size);s.font.color.rgb=RGBColor(0,0,0)
        s.paragraph_format.keep_with_next=True
        s.paragraph_format.space_before=Pt(8);s.paragraph_format.space_after=Pt(8)
    lang=doc.styles['Normal'].element.get_or_add_rPr()
    el=OxmlElement('w:lang');el.set(qn('w:val'),'ja-JP');el.set(qn('w:eastAsia'),'ja-JP');lang.append(el)
    defaults=doc.styles.element.find(qn('w:docDefaults')).find(qn('w:rPrDefault')).find(qn('w:rPr'))
    lang=defaults.find(qn('w:lang'))
    if lang is None:lang=OxmlElement('w:lang');defaults.append(lang)
    lang.set(qn('w:val'),'ja-JP');lang.set(qn('w:eastAsia'),'ja-JP')
    doc.core_properties.language='ja-JP'
    header=sec.header.paragraphs[0]
    font(header.add_run('HAKOBI  /  チームで進捗と相談を共有する'),8,color='526271')
    footer=sec.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.RIGHT
    font(footer.add_run('2026年10月  |  '),8,color='526271')
    field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
    doc.core_properties.author=''
    doc.core_properties.title='HAKOBI チームで進捗と相談を共有する'
    return doc

def build(source, stem):
    assets=ROOT/'assets'; out=ROOT/'.build';out.mkdir(exist_ok=True)
    for name,(origin,box,width) in CROPS.items():
        with Image.open(assets/(origin+'.png')) as image:
            if box is not None:
                image.crop(box).save(assets/(name+'.png'))
            elif name=='meeting-focus':
                # Separate, disclosed crops of the same actual meeting screen.
                canvas=Image.new('RGB',(744,267),'white')
                canvas.paste(image.crop((20,10,430,56)),(0,0))
                canvas.paste(image.crop((20,330,430,490)),(0,58))
                canvas.paste(image.crop((1115,76,1425,130)),(434,0))
                canvas.paste(image.crop((1115,201,1425,274)),(434,65))
                canvas.paste(image.crop((1115,290,1425,405)),(434,150))
                canvas.save(assets/(name+'.png'))
            elif name=='quickadd-focus':
                canvas=Image.new('RGB',(660,293),'white')
                canvas.paste(image.crop((390,200,1050,315)),(0,0))
                canvas.paste(image.crop((390,478,1050,548)),(0,127))
                canvas.paste(image.crop((390,550,1050,634)),(0,209))
                canvas.save(assets/(name+'.png'))
    doc=prepare(); sections=0; index=0
    lines=source.read_text(encoding='utf-8').splitlines()
    while index<len(lines):
        line=lines[index].strip();index+=1
        if not line or line.startswith('# '):continue
        if line.startswith('## '):
            sections+=1
            if sections>1:doc.add_page_break()
            if sections==1:
                p=doc.add_paragraph(style='Title');font(p.add_run('HAKOBI'),30,True,'000000')
                p=doc.add_paragraph();font(p.add_run('チームで進捗と相談を共有する'),11,color='526271')
            p=doc.add_paragraph(style='Heading 1');font(p.add_run(line[3:]),20,True,'000000')
            continue
        if line.startswith('### '):
            p=doc.add_paragraph(style='Heading 2');font(p.add_run(line[4:]),12.5,True,'000000');continue
        match=re.fullmatch(r'!\[(.*?)\]\((.*?)\)',line)
        if match:
            caption,ref=match.groups();key=Path(ref).stem;width=CROPS[key][2]
            p=doc.add_paragraph();p.alignment=WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.line_spacing=1.0
            p.paragraph_format.keep_with_next=True
            shape=p.add_run().add_picture(str(ROOT/ref),width=Mm(width))
            shape._inline.docPr.set('descr',caption)
            p=doc.add_paragraph();p.paragraph_format.space_after=Pt(8)
            p.paragraph_format.line_spacing=Pt(12)
            font(p.add_run(caption),8.5,color='526271');continue
        if re.match(r'^\d+\. ',line):
            add_text(doc,line);continue
        paragraph=[line]
        while index<len(lines) and lines[index].strip() and not lines[index].startswith(('#','!')):
            paragraph.append(lines[index].strip());index+=1
        add_text(doc,''.join(paragraph))
    if sections!=6:raise ValueError('Expected six sections')
    target=ROOT/(stem+'.docx');target.parent.mkdir(parents=True,exist_ok=True);doc.save(target)
    manifest={'source':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'docx':str(target),'sections':sections}
    (out/(Path(stem).name+'-manifest.json')).write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    return target

def export(docx):
    # Use the repository's established renderer and explicit Japanese PDF settings.
    sys.path.insert(0,str(REPO/'docs/hakobi-report/tools'))
    from update_toc_pages import soffice, soffice_env
    options={'UseTaggedPDF':{'type':'boolean','value':'true'},'ExportBookmarks':{'type':'boolean','value':'true'},'EmbedStandardFonts':{'type':'boolean','value':'true'}}
    with tempfile.TemporaryDirectory() as tmp:
        directory=Path(tmp)
        subprocess.run([soffice(),'-env:UserInstallation='+(directory/'profile').as_uri(),'--headless','--norestore','--convert-to','pdf:writer_pdf_Export:'+json.dumps(options),'--outdir',tmp,str(docx)],check=True,capture_output=True,env=soffice_env(),timeout=180)
        pdf=directory/(docx.stem+'.pdf')
        reader=PdfReader(pdf)
        print(json.dumps({'pages':len(reader.pages),'language':reader.root_object.get('/Lang')},ensure_ascii=False))
        docx.with_suffix('.pdf').write_bytes(pdf.read_bytes())

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=ROOT/'introduction.md')
    parser.add_argument('--stem',default='HAKOBI_紹介資料')
    parser.add_argument('--pdf',action='store_true')
    args=parser.parse_args();docx=build(args.source.resolve(),args.stem)
    if args.pdf:export(docx)
    print(docx)
