"""Check the six-page report and offline guide links in both distribution ZIPs."""
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile
import hashlib,json,re,unicodedata
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1]
GUIDE=ROOT.parent/'hakobi-start-guide'
normalize=lambda s:re.sub(r'\s+','',unicodedata.normalize('NFKC',s))
reader=PdfReader(ROOT/'HAKOBI_紹介資料.pdf')
assert len(reader.pages)==6
text=normalize(''.join(p.extract_text() for p in reader.pages))
missing=[]
for line in (ROOT/'introduction.md').read_text(encoding='utf-8').splitlines():
    if not line.strip():continue
    line=re.sub(r'^#+\s+','',line)
    line=re.sub(r'^!\[([^\]]*)\]\([^)]*\)$',r'\1',line)
    line=re.sub(r'\[([^\]]+)\]\([^)]*\)',r'\1',line)
    if normalize(line) not in text:missing.append(line)
assert not missing,missing
guide=(ROOT/'HAKOBI_はじめ方ガイド.html').read_text(encoding='utf-8')
assert guide==(GUIDE/'index.html').read_text(encoding='utf-8')
anchors=set(re.findall(r'\bid="([^"]+)"',guide))
links=[]
for p in reader.pages:
    for entry in p.get('/Annots',[]):
        action=entry.get_object().get('/A',{})
        if action.get('/S')!='/URI':continue
        uri=unquote(action['/URI']);parts=urlsplit(uri)
        assert not parts.scheme,uri
        assert (ROOT/parts.path).is_file(),uri
        if parts.fragment:assert parts.fragment in anchors,uri
        links.append(uri)
assert len(links)>=8
zip_results={}
for archive in [ROOT/'HAKOBI_紹介セット.zip',GUIDE/'HAKOBI_紹介資料と導入ガイド.zip']:
    with ZipFile(archive) as z:
        assert z.testzip() is None
        for name in ['HAKOBI_紹介資料.pdf','HAKOBI_紹介資料.docx','HAKOBI_はじめ方ガイド.html']:
            assert z.read(name)==(ROOT/name).read_bytes(),(archive,name)
        zip_results[archive.name]={'files':len(z.namelist()),'currentArtifactsMatch':True}
files={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['introduction.md','HAKOBI_紹介資料.pdf','HAKOBI_紹介資料.docx','HAKOBI_はじめ方ガイド.html']}
result={'pages':6,'allManuscriptParagraphsInPdf':True,'pdfGuideLinks':links,'zipChecks':zip_results,'sha256':files}
output=ROOT/'review/relaunch-output-check.json';output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'pages':6,'textComplete':True,'validPdfLinks':len(links),'zipChecks':zip_results},ensure_ascii=False))
