"""Build both existing report names, stabilize the TOC, and package the guide."""
from pathlib import Path
import json, shutil, tempfile, zipfile
from build_report_docx import build,toc_path
from update_toc_pages import render_pdf,find_pages
from export_pdf import export

ROOT=Path(__file__).resolve().parents[1]
REPO=ROOT.parents[1]
source=ROOT/'HAKOBI_TECHNICAL_REPORT.md'
variant=ROOT/'HAKOBI_TECHNICAL_REPORT_推敲版.md'
out=ROOT/'output'

def release():
    out.mkdir(exist_ok=True)
    # Both retained names now carry the same reader-focused manuscript.
    variant.write_bytes(source.read_bytes())
    target=out/'HAKOBI_技術レポート.docx'
    for attempt in range(3):
        build(source,target)
        with tempfile.TemporaryDirectory(prefix='hakobi-report-toc-') as folder:
            current=find_pages(source,render_pdf(target,Path(folder)))
        file=toc_path(source)
        previous=json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
        if current==previous:break
        file.write_text(json.dumps(current,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    else:raise RuntimeError('TOC did not stabilize')
    shutil.copyfile(toc_path(source),toc_path(variant))
    revised=out/'HAKOBI_技術レポート_推敲版.docx'
    build(variant,revised)
    export(source,target,target.with_suffix('.pdf'))
    export(variant,revised,revised.with_suffix('.pdf'))
    shutil.copyfile(REPO/'docs/hakobi-start-guide/index.html',out/'HAKOBI_はじめ方ガイド.html')
    with zipfile.ZipFile(out/'HAKOBI_レポートと導入ガイド.zip','w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('はじめに.txt','最初にHAKOBI_技術レポート.pdfを開いてください。編集にはWordを使えます。\nZIPをすべて展開し、PDF・Word・HAKOBI_はじめ方ガイド.htmlを同じフォルダに置いてください。\n詳しい操作とビルド・配置はHTMLにあります。PDFからリンクを開けない場合はHTMLを直接開きます。\n')
        for name in ['HAKOBI_技術レポート.pdf','HAKOBI_技術レポート.docx','HAKOBI_はじめ方ガイド.html']:
            z.write(out/name,name)
        for name in ['team-traffic.svg','team-traffic.gif']:
            z.write(REPO/'docs/hakobi-start-guide'/name,name)
    print('Built both report variants and the distribution ZIP')

if __name__=='__main__':release()
