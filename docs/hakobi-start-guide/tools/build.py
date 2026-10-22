"""Build a self-contained HTML attachment with actual screenshots and SVG."""
from pathlib import Path
from html.parser import HTMLParser
import base64
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]

source = (ROOT / 'guide.template.html').read_text(encoding='utf-8')
def replace_image(match):
    name = match.group(1)
    path = ROOT / 'assets' / (name + '.png')
    if not path.exists(): path = REPO / 'docs/hakobi-showcase/assets' / (name + '.png')
    labels = {'gantt-wide':'ガントの画面例', 'team-focus':'メンバーごとの担当状況',
              'discussion':'仕事の相談と返信', 'meeting-focus':'定例で決めた対応と期限',
              'tour-plan':'時間帯に並べた今日の計画', 'tour-kanban':'状態別に並べたカンバン',
              'tour-timer':'タスク詳細の計測時間と進捗', 'tour-record':'計測した作業時間の記録',
              'tour-checklist':'中の項目をチェックするToDoリスト',
              'tour-dependencies':'先行・後続のタスクをつなぐ依存関係',
              'report-focus':'期間と担当を選び、文章をコピーする報告画面',
              'personal-launcher':'個人用を選ぶ接続画面',
              'personal-gantt-focus':'個人用で登録した仕事の日程と進捗'}
    data = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'<img src="data:image/png;base64,{data}" alt="{labels[name]}" width="1000">'
source = re.sub(r'@IMAGE:([a-z-]+)@', replace_image, source)
traffic = (ROOT / 'team-traffic.svg').read_text(encoding='utf-8')
traffic = traffic.replace('<svg ', '<svg id="traffic-diagram" class="flow" ', 1)
source = source.replace('@TRAFFIC@', traffic)
(ROOT / 'index.html').write_text(source, encoding='utf-8')
(REPO / 'docs/hakobi-showcase/HAKOBI_はじめ方ガイド.html').write_text(source, encoding='utf-8')

class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.skip=0; self.parts=[]
    def handle_starttag(self, tag, attrs):
        if tag in ('style','script'): self.skip+=1
        if tag in ('h1','h2','h3','h4','p','li','summary','pre','dt','dd','figcaption','label','tr'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('style','script'): self.skip-=1
    def handle_data(self, data):
        if not self.skip: self.parts.append(data)
t=Text();t.feed(source)
(ROOT / 'guide-text.txt').write_text(re.sub(r'\n\s*\n+', '\n\n', ''.join(t.parts)).rstrip()+'\n',encoding='utf-8')

with zipfile.ZipFile(ROOT/'HAKOBI_紹介資料と導入ガイド.zip','w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('はじめに.txt','最初に「HAKOBI_紹介資料.pdf」をご覧ください。使い始めるときは「HAKOBI_はじめ方ガイド.html」をブラウザで開きます。HTMLの画像と図は内蔵されています。ネット接続が必要な操作は、アプリの入手や部品のインストール、チーム接続です。\n')
    z.write(ROOT/'index.html','HAKOBI_はじめ方ガイド.html')
    z.write(ROOT/'team-traffic.svg','team-traffic.svg')
    if (ROOT/'team-traffic.gif').exists(): z.write(ROOT/'team-traffic.gif','team-traffic.gif')
    for file,name in [('docs/hakobi-showcase/HAKOBI_紹介資料.pdf','HAKOBI_紹介資料.pdf'),('docs/hakobi-showcase/HAKOBI_紹介資料.docx','HAKOBI_紹介資料.docx'),('docs/web-setup-guide.md','Web版の立ち上げガイド.md'),('docs/HAKOBI.md','HAKOBIのチーム接続と運用.md')]:
        z.write(REPO/file,name)
print('Built HTML, text for writing checks, and attachment ZIP')
