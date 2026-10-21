"""Report figures: one layout produces both SVG and the Word PNG.

Every figure is 1800 wide and is placed at 6.15 inches in Word, so 38 px of text
prints at about 9.3 pt. Keep text at 34 px or larger. The figure title is the
caption under the figure (図N), so the drawing itself has no title.
"""
import math
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFont

INK = '#1E2B37'
NAVY = '#0F1B2D'
MUTED = '#5B6B78'
LINE = '#6B7C86'
BOX = '#F1F4F6'
BORDER = '#A8B6C5'
TEAL = '#0E8C80'
TEAL_DARK = '#0B6E66'
TEAL_LIGHT = '#E7F5F3'
AMBER = '#E9A21B'
AMBER_DARK = '#8A5A00'
AMBER_LIGHT = '#FFF6E0'
WIDTH = 1800


def _font(size, bold=False):
    names = ['YuGothB.ttc', 'meiryob.ttc'] if bold else ['YuGothM.ttc', 'meiryo.ttc']
    for name in names:
        path = Path('C:/Windows/Fonts') / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise FileNotFoundError('Yu Gothic or Meiryo is required')


class Figure:
    def __init__(self, title, height=900):
        self.height = height
        self.image = Image.new('RGB', (WIDTH, height), 'white')
        self.draw = ImageDraw.Draw(self.image)
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" '
                    f'viewBox="0 0 {WIDTH} {height}" role="img"><title>{escape(title)}</title>'
                    f'<rect width="{WIDTH}" height="{height}" fill="white"/>']

    def text(self, x, y, value, size=38, color=INK, center=False, bold=False, end=False):
        font = _font(size, bold)
        anchor, svg_anchor = ('ms', 'middle') if center else ('rs', 'end') if end else ('ls', 'start')
        weight = ' font-weight="bold"' if bold else ''
        for i, line in enumerate(value.split('\n')):
            baseline = y + i * (size + 14)
            self.draw.text((x, baseline), line, font=font, fill=color, anchor=anchor)
            self.svg.append(f'<text x="{x}" y="{baseline}" font-family="Yu Gothic, Meiryo, sans-serif" '
                            f'font-size="{size}"{weight} text-anchor="{svg_anchor}" fill="{color}">{escape(line)}</text>')

    def rect(self, x, y, w, h, fill=BOX, outline=BORDER, radius=16, width=3):
        self.draw.rounded_rectangle((x, y, x + w, y + h), radius=radius, fill=fill, outline=outline, width=width)
        stroke = f' stroke="{outline}" stroke-width="{width}"' if outline else ''
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}"{stroke}/>')

    def box(self, x, y, w, h, title, subtitle='', fill=BOX, outline=BORDER, title_color=NAVY, sub_color=INK,
            title_size=42, sub_size=36):
        self.rect(x, y, w, h, fill, outline)
        lines = subtitle.count('\n') + 1 if subtitle else 0
        block = title_size + (lines * (sub_size + 14) + 12 if subtitle else 0)
        top = y + (h - block) / 2 + title_size * 0.85
        self.text(x + w / 2, top, title, title_size, title_color, True, bold=True)
        if subtitle:
            self.text(x + w / 2, top + title_size * 0.35 + sub_size + 14, subtitle, sub_size, sub_color, True)

    def line(self, x1, y1, x2, y2, color=LINE, width=4):
        self.draw.line((x1, y1, x2, y2), fill=color, width=width)
        self.svg.append(f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{width}" stroke-linecap="round"/>')

    def arrow(self, x1, y1, x2, y2, label='', color=LINE, double=False):
        def head(px, py, angle):
            points = [(px, py), (px - 22 * math.cos(angle - .42), py - 22 * math.sin(angle - .42)),
                      (px - 22 * math.cos(angle + .42), py - 22 * math.sin(angle + .42))]
            self.draw.polygon(points, fill=color)
            self.svg.append('<polygon points="' + ' '.join(f'{x:.1f},{y:.1f}' for x, y in points) + f'" fill="{color}"/>')

        a = math.atan2(y2 - y1, x2 - x1)
        self.draw.line((x1, y1, x2, y2), fill=color, width=4)
        self.svg.append(f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="4"/>')
        head(x2, y2, a)
        if double:
            head(x1, y1, a + math.pi)
        if label:
            self.text((x1 + x2) / 2, (y1 + y2) / 2 - 22, label, 34, MUTED, center=True)

    def bracket(self, x1, x2, y, label, color):
        for coords in ((x1, y, x2, y), (x1, y, x1, y + 22), (x2, y, x2, y + 22)):
            self.line(*coords, color=color, width=4)
        self.text((x1 + x2) / 2, y - 22, label, 36, color, True, bold=True)

    def save(self, directory, name):
        png, svg = directory / (name + '.png'), directory / (name + '.svg')
        self.image.save(png, dpi=(240, 240))
        svg.write_text('\n'.join(self.svg + ['</svg>']), encoding='utf-8')
        return png, svg


def timeline():
    f = Figure('HAKOBIの開発の歩み（2026年）', 1060)
    rows = [
        ('3〜4月', '1人で使うデスクトップアプリ', 'ガント、依存関係、今日の計画、作業ログ\nタスクの並べ替え、説明とメモの分離', False),
        ('5〜6月', 'チーム用サーバーの追加', '5月30日 複数人で使うWeb版とサーバー\n担当者、チーム画面、アカウント発行、リアルタイム同期', True),
        ('6〜9月', '進捗の共有と見やすさ', '進捗ログの返信・いいね・通知、カンバン、タスク別レポート\n9月25日 報告タブ、ガントの見やすさの改善', False),
        ('10月9日\n〜13日', 'チーム接続のデスクトップ版', 'デスクトップ版からチームのサーバーへ接続\nOS通知・未読バッジ、配布とお知らせ（1.0.5）', False),
        ('10月14日\n〜21日', '定例と日々の作業の改善', 'ToDoリスト・定例モード・リマインド・パレット\n毎年の繰り返し、定例の再開、操作と表示の改善', False),
    ]
    for i, (when, title, detail, accent) in enumerate(rows):
        y = 40 + i * 200
        if i:
            f.line(210, y - 50, 210, y, BORDER, 5)
        f.rect(60, y, 300, 150, TEAL_LIGHT if accent else BOX, TEAL if accent else BORDER, 16, 5 if accent else 3)
        lines = when.split('\n')
        f.text(210, y + (90 if len(lines) == 1 else 64), when, 40, NAVY, True, bold=True)
        f.text(410, y + 50, title, 42, TEAL_DARK if accent else NAVY, bold=True)
        f.text(410, y + 104, detail, 35)
    return f


def architecture():
    f = Figure('個人用とチーム用の構成', 1000)
    f.text(60, 70, '個人用', 44, NAVY, bold=True)
    f.text(760, 70, 'チーム用', 44, NAVY, bold=True)
    f.line(700, 40, 700, 960, BORDER, 4)
    f.rect(60, 120, 560, 640, BOX, BORDER)
    f.text(340, 180, 'デスクトップ版（Electron）', 38, NAVY, True, bold=True)
    f.box(110, 230, 460, 170, '共通の画面', 'React・TypeScript', TEAL_LIGHT, TEAL)
    f.arrow(340, 400, 340, 540, double=True)
    f.text(370, 482, 'IPC', 34, MUTED)
    f.box(110, 540, 460, 170, 'main プロセス', 'PC内のSQLiteに保存')
    f.text(340, 840, '1人で使う。データは自分のPC内', 36, MUTED, True)

    f.box(760, 140, 440, 230, 'ブラウザ', '共通の画面', TEAL_LIGHT, TEAL)
    f.box(1290, 140, 450, 230, 'デスクトップ版', '共通の画面＋\nタイマー・通知・トレイ', TEAL_LIGHT, TEAL)
    f.box(900, 560, 700, 230, '社内LANのサーバー', 'Express・WebSocket\nSQLite（チームのデータ）', TEAL, TEAL, 'white', 'white')
    f.arrow(980, 372, 1120, 556, double=True)
    f.arrow(1515, 372, 1380, 556, double=True)
    f.text(1250, 470, 'HTTP・WebSocket', 36, MUTED, True)
    f.text(1250, 870, '同じ画面が window.api の実装だけを切り替える', 36, MUTED, True)
    return f


def sync_flow():
    f = Figure('チームでの変更が全員の画面に届くまで', 500)
    steps = [
        ('1 画面で保存', '変更した\n項目だけ送る'),
        ('2 サーバー', 'ログインと\n競合を確かめる'),
        ('3 DBを更新', '変更履歴も\n残す'),
        ('4 変更を通知', 'WebSocketで\n全員へ'),
        ('5 画面が更新', '最新の内容を\n取り直す'),
    ]
    for i, (title, sub) in enumerate(steps):
        x = 30 + i * 354
        accent = i == 3
        f.box(x, 30, 318, 280, title, sub, TEAL_LIGHT if accent else BOX, TEAL if accent else BORDER,
              title_size=38, sub_size=34)
        if i < 4:
            f.arrow(x + 320, 170, x + 352, 170)
    f.text(900, 390, '画面は、選んでいるタスクと要求の順番を確かめ、古い応答を表示しない', 36, MUTED, True)
    f.text(900, 455, '通知は「どの種類のデータが変わったか」だけで、本文は各画面が取り直す', 36, MUTED, True)
    return f


def record_hub():
    f = Figure('一度残した記録を、確認と報告に使う', 760)
    f.text(330, 70, '作業の区切りに1回残す', 38, TEAL_DARK, True, bold=True)
    f.box(60, 160, 540, 420, '日々の記録', '進捗率・進捗ログ\nメモ・作業時間', TEAL, TEAL, 'white', 'white', 54, 40)
    f.text(1290, 70, 'チームの確認と報告に何度も使う', 38, TEAL_DARK, True, bold=True)
    outputs = (
        ('チームの状況確認', 'ガント・チーム画面'),
        ('定例での相談', '報告タブ・定例モード'),
        ('週報の下書き', '報告の文章をCopilotへ'),
    )
    for i, (title, sub) in enumerate(outputs):
        y = 110 + i * 210
        f.box(860, y, 860, 170, title, sub, TEAL_LIGHT, TEAL)
        f.arrow(604, 370, 854, y + 85, color=TEAL)
    return f


def dependency():
    f = Figure('分岐と合流がある依存関係の再計算', 820)
    nodes = {
        'A': (60, 300, 'A', '期限を延ばす', AMBER_LIGHT, AMBER),
        'B': (470, 110, 'B', '', BOX, BORDER),
        'C': (470, 490, 'C', '10月7〜11日へ', TEAL_LIGHT, TEAL),
        'D': (880, 300, 'D', '10月12〜13日へ', TEAL_LIGHT, TEAL),
        'E': (1290, 300, 'E', '10月14日へ', TEAL_LIGHT, TEAL),
    }
    for key, (x, y, title, sub, fill, outline) in nodes.items():
        f.box(x, y, 300, 170, title, sub, fill, outline, title_size=48, sub_size=34)
    for a, b in (('A', 'B'), ('A', 'C'), ('B', 'D'), ('C', 'D'), ('D', 'E')):
        ax, ay = nodes[a][0] + 300, nodes[a][1] + 85
        bx, by = nodes[b][0], nodes[b][1] + 85
        f.arrow(ax + 4, ay, bx - 6, by)
    f.text(60, 730, '矢印は「前の仕事が終わってから次を始める」（Finish to Start）。待機日数も足せる。', 36, MUTED)
    f.text(60, 790, 'すべての前工程を計算してから後工程を計算するので、合流するDとその後ろのEにも正しく伝わる。', 36, MUTED)
    return f


def weekly_flow():
    f = Figure('週報の下書きを作る流れ', 520)
    steps = (
        ('報告タブ', '期間と担当を選ぶ', TEAL_LIGHT, TEAL),
        ('Markdownをコピー', '見出しつきの文章', TEAL_LIGHT, TEAL),
        ('週報用エージェント', '記録から下書き', '#EEF2F7', LINE),
        ('本人が確認', '整えて提出', AMBER_LIGHT, AMBER),
    )
    for i, (title, sub, fill, outline) in enumerate(steps):
        x = 40 + i * 440
        f.box(x, 200, 400, 230, title, sub, fill, outline, title_size=40)
        if i < 3:
            f.arrow(x + 402, 315, x + 438, 315)
    f.bracket(40, 880, 140, 'HAKOBI', TEAL_DARK)
    f.bracket(920, 1320, 140, 'Microsoft 365 Copilot', LINE)
    f.bracket(1360, 1760, 140, '担当者', AMBER_DARK)
    return f


FIGURES = {
    'timeline': timeline,
    'architecture': architecture,
    'sync-flow': sync_flow,
    'record-hub': record_hub,
    'dependency': dependency,
    'weekly-flow': weekly_flow,
}


def build_diagrams(directory):
    directory.mkdir(parents=True, exist_ok=True)
    return {name: make().save(directory, name) for name, make in FIGURES.items()}


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'assets'
    for name, (png, svg) in build_diagrams(out).items():
        print(name, png)
