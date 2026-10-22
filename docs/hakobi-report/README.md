# HAKOBI レポート

HAKOBIを初めて見る人に、作成したツールの機能と仕事での使い方を紹介する資料です。2026年10月22日に、個人での開始、チームでの状況確認と相談、定例・週報、日々の段取り、構成、使い始める案内へ組み直しました。

- [レポートPDF](output/HAKOBI_技術レポート.pdf)
- [編集用Word](output/HAKOBI_技術レポート.docx)
- [レポートと導入ガイドの配布ZIP](output/HAKOBI_レポートと導入ガイド.zip)
- [同封HTMLガイド](output/HAKOBI_はじめ方ガイド.html)
- [本文原稿](HAKOBI_TECHNICAL_REPORT.md)
- [紹介用サムネイル（800×600px・PNG）](output/HAKOBI_thumbnail_800x600_v2.png)

従来のリンクを保つため、PDF・Wordのファイル名には「技術レポート」を残しています。内容は機能と利用場面を中心にした紹介レポートです。原稿版と推敲版は同じ最新版にそろえています。

配布する際はZIPをすべて展開し、PDF・Word・HTMLを同じフォルダに置きます。PDF内のリンクからガイド01〜05と機能紹介へ進めます。PDFリーダーからHTMLを開けない場合は、同封HTMLをブラウザで直接開いてください。

## 読みやすさの見直し

表紙にガントの実画面と使い道を置き、概要に読者別の読む順番を示しました。本文では個人用の起動と登録から始め、仕事をチームへ引き継ぎ、相談・定例・報告へ進む流れを紹介します。各画面に見る所と読み取れることを添えました。仕組みの説明は、個人用とチーム用を支える構成に絞っています。

画面は既存の紹介資料と導入ガイドで撮影した実アプリの操作例です。架空の人名・業務を使い、個人用は2026年10月22日、チーム用と共通機能は10月21日に撮影しています。UIの数値や文字は画像編集で描き直していません。

執筆者とは別の評価者が、[固定基準](evidence/READER_CRITERIA_20261022.md)で[改稿前](evidence/BASELINE_REVIEW_20261022.md)と[改稿後](evidence/READER_REVIEW_20261022.md)を確認しました。7つの基準による評価は77点から95点／100点となり、配布可の判定です。配布本文と、作成者向けの評価・出力確認記録は分けています。

## 編集と再生成

本文は `HAKOBI_TECHNICAL_REPORT.md` を編集します。下のコマンドで推敲版も同期し、両方のWord・PDF、HTML、配布ZIPを作ります。

```powershell
python docs/hakobi-report/tools/build_reader_release.py
python docs/hakobi-report/tools/check_reader_release.py
```

必要なPythonパッケージは `requirements.txt` を参照してください。図の描画にはPillow、Wordにはpython-docx、PDF確認にはpypdfを使います。PDF書き出しにはLibreOfficeが必要です。見つからない場合は環境変数 `HAKOBI_SOFFICE` にsofficeの場所を指定します。

目次のページ番号は、WordをPDFへ変換した結果から確定します。本文や図を直した後は全ページを画像で確認し、目次、図表、リンクも検査してください。説明図は `tools/report_diagrams.py`、採用する画面と代替テキストは `tools/build_report_docx.py` の `FIGURES` で管理します。画像の元は `docs/hakobi-showcase/assets/` と `docs/hakobi-start-guide/assets/` です。

以前の原稿とチェックシートは `evidence/BEFORE_READER_*` と `evidence/CHECKLIST_BEFORE_READER_20261022.md` に保存しています。過去の検証記録も作成者向け資料として残しています。
