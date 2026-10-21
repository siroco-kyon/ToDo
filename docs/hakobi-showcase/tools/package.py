"""Package the checked introduction and existing setup guides for sharing."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]

files = {
    'HAKOBI_紹介資料.pdf': ROOT / 'HAKOBI_紹介資料.pdf',
    'HAKOBI_紹介資料.docx': ROOT / 'HAKOBI_紹介資料.docx',
    '導入を担当する方へ.md': ROOT / '導入を担当する方へ.md',
    'Web版の立ち上げガイド.md': REPO / 'docs/web-setup-guide.md',
    'HAKOBIのチーム接続と運用.md': REPO / 'docs/HAKOBI.md',
}
for file in files.values():
    if not file.is_file():
        raise FileNotFoundError(file)

with ZipFile(ROOT / 'HAKOBI_紹介セット.zip', 'w', ZIP_DEFLATED) as archive:
    archive.writestr('はじめに.txt',
        'HAKOBI 紹介セット\n\n'
        'まず「HAKOBI_紹介資料.pdf」をご覧ください。\n'
        '内容を編集するときはWord版を使えます。\n'
        '試用の準備を相談する方には「導入を担当する方へ.md」と、起動・運用ガイドを渡してください。\n'
        '起動・運用ガイドは2026年10月21日時点のリポジトリから同封しています。\n')
    for name, file in files.items():
        archive.write(file, name)
print(ROOT / 'HAKOBI_紹介セット.zip')
