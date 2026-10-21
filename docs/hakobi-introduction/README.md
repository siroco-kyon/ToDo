# HAKOBI 利用案内

## 初めて見る方向けの紹介資料

進捗の共有、相談、定例、週報を一つの仕事の例で紹介する6ページの資料を、別フォルダに作成しました。実際のアプリで撮影したライト表示のデモを使っています。

- [HAKOBI 紹介資料](../hakobi-showcase/HAKOBI_紹介資料.pdf)
- [原稿・Word・別エージェントの評価記録](../hakobi-showcase/README.md)

## 社内レポート版（2026年10月）

作った目的、チームで使うと変わること、導入の進め方を社内レポートの形でまとめた、全12ページの資料です。

- [配布用PDF](HAKOBI_社内レポート.pdf)
- [編集用Word](HAKOBI_社内レポート.docx)
- [本文原稿](report-internal.md)

```powershell
python docs/hakobi-introduction/build_internal.py
```

`report-internal.md` から `HAKOBI_社内レポート.docx` と図（`assets-current/` の `record-hub.png` など）を生成します。PDFはWordから出力します（下の「Wordの再生成」と同じパッケージとフォントを使います）。

## 利用案内（16ページ版）

他の係やグループへHAKOBIを紹介するときに使う、全16ページの資料です。

- [配布用PDF](HAKOBI_利用案内_推敲版.pdf)
- [編集用Word](HAKOBI_利用案内_推敲版.docx)
- [本文原稿](report-readable.md)

個人用とチーム用の違い、ガントを中心とした日程管理、進捗ログ、定例での相談、個人用データの取り込みを説明しています。週報作成は、報告タブのMarkdownをコピーしてMicrosoft 365 Copilotのエージェントへ渡し、本人が下書きを確認する手順です。

画面例は2026年10月17日に撮影したダークモードのデモです。登場するメンバーと業務は架空のものです。画像は `assets-current/` に保存しています。

## Wordの再生成

Windowsの游ゴシック（`C:/Windows/Fonts/YuGothR.ttc` と `YuGothB.ttc`）とPythonを使います。必要なPythonパッケージは `python-docx`、`Pillow`、`pypdfium2`、`reportlab` です。

```powershell
python docs/hakobi-introduction/build_report.py
```

既定では `report-readable.md` から `HAKOBI_利用案内_推敲版.docx` を生成します。`--source` と `--output` で別のファイルも指定できます。相対パスはこのフォルダを基準に扱います。中間ファイルはGit管理外の `.build/` に生成されます。

PDFは生成したWordをPDF形式で出力してください。原稿や配置を変更したときは全ページを描画し、改行、表、画像、ページ番号を確認してください。
