"""Check report text, figures, PDF guide links, TOC and distribution contents."""
from pathlib import Path
from urllib.parse import unquote,urlsplit
from zipfile import ZipFile
import hashlib,json,re,unicodedata
from pypdf import PdfReader
from build_report_docx import toc_path
from update_toc_pages import find_pages

ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'output'
def squash(s):return re.sub(r'\s+','',unicodedata.normalize('NFKC',s))

def check():
    results={}; hashes={}
    html=(out/'HAKOBI_はじめ方ガイド.html').read_text(encoding='utf-8')
    ids=set(re.findall(r'\bid="([^"]+)"',html))
    assert html==(ROOT.parent/'hakobi-start-guide/index.html').read_text(encoding='utf-8')
    texts=[]
    for stem,source_name in [('HAKOBI_技術レポート','HAKOBI_TECHNICAL_REPORT.md'),('HAKOBI_技術レポート_推敲版','HAKOBI_TECHNICAL_REPORT_推敲版.md')]:
        source=ROOT/source_name; pdf=out/(stem+'.pdf'); reader=PdfReader(pdf)
        assert reader.root_object.get('/Lang')=='ja-JP'
        assert reader.root_object.get('/StructTreeRoot') is not None
        assert reader.outline
        assert find_pages(source,pdf)==json.loads(toc_path(source).read_text(encoding='utf-8'))
        text=squash(''.join(page.extract_text() for page in reader.pages));texts.append(text)
        assert not any(word in text for word in ['テスト失敗','効果未測定','未測定である','時間切れ','不具合を再現'])
        missing=[]
        for line in source.read_text(encoding='utf-8').splitlines():
            if not line.strip() or line.startswith('[['):continue
            if re.match(r'^(作成日|対象):',line):line=line.replace(':','',1)
            if line.startswith('|'):
                if re.match(r'^\|[-:| ]+\|$',line):continue
                chunks=line.strip('|').split('|')
            else:chunks=[re.sub(r'^(?:#+\s+|-\s+)','',line)]
            for chunk in chunks:
                chunk=re.sub(r'\[([^\]]+)\]\([^)]*\)',r'\1',chunk).replace('`','').replace('**','')
                if squash(chunk) and squash(chunk) not in text:missing.append(chunk)
        assert not missing,missing
        links=[]
        for page in reader.pages:
            for annot in page.get('/Annots',[]):
                action=annot.get_object().get('/A',{})
                if action.get('/S')!='/URI':continue
                uri=unquote(action['/URI']);parts=urlsplit(uri)
                assert not parts.scheme,uri
                assert (out/parts.path).is_file(),uri
                assert not parts.fragment or parts.fragment in ids,uri
                links.append(uri)
        assert len(links)==6
        results[stem]={'pages':len(reader.pages),'allSourceTextPresent':True,'tocMatches':True,'language':'ja-JP','tagged':True,'guideLinks':links}
        for p in [source,pdf,out/(stem+'.docx')]:hashes[str(p.relative_to(ROOT))]=hashlib.sha256(p.read_bytes()).hexdigest()
    assert texts[0]==texts[1]
    with ZipFile(out/'HAKOBI_レポートと導入ガイド.zip') as z:
        assert z.testzip() is None
        for name in ['HAKOBI_技術レポート.pdf','HAKOBI_技術レポート.docx','HAKOBI_はじめ方ガイド.html']:
            assert z.read(name)==(out/name).read_bytes()
    result={'reports':results,'bothPdfTextsMatch':True,'zipContentsMatch':True,'sha256':hashes}
    (ROOT/'evidence/OUTPUT_CHECK_20261022.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v['pages'] for k,v in results.items()},ensure_ascii=False));print('Text, TOC, six guide links and ZIP checks passed')

if __name__=='__main__':check()
