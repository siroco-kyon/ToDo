# HAKOBI 技術レポートの生成手順

ERチェックシートに沿って書いたHAKOBIの技術レポートである。提出するのはPDF（`output/HAKOBI_技術レポート.pdf`）で、`HAKOBI_TECHNICAL_REPORT.md` を原稿とする。`tools/build_report_docx.py` でWord（`output/HAKOBI_技術レポート.docx`）を生成してから、`tools/export_pdf.py` でPDFに書き出す。生成の仕組みはWatashiの技術レポートの手順を移したものである。

紹介用の社内レポート（`docs/hakobi-introduction/HAKOBI_社内レポート.pdf`）とは別の資料である。チェックシートに照らした自己判定は [HAKOBI_REPORT_CHECKLIST.md](HAKOBI_REPORT_CHECKLIST.md)、品質確認の記録は [evidence/VALIDATION_20261017.md](evidence/VALIDATION_20261017.md) にある。

## 必要環境

- Windows 11（図の文字に Yu Gothic を使う）
- Python 3.11以降と `requirements.txt` の部品（`python-docx`、Pillow、lxml、pypdf）
- LibreOffice（目次のページ番号の確認とPDFの書き出しに使う）。インストールしていない場合は、環境変数 `HAKOBI_SOFFICE` に `soffice` の場所を指定する。指定がなければ、`docs/hakobi-introduction/.build/runtime/` のLibreOffice Portableも探す

```powershell
python -m pip install -r docs/hakobi-report/requirements.txt
```

## 生成の流れ

1. **画面の図（必要なときだけ）**：`docs/hakobi-introduction/assets-current/` のデモの画面（架空のメンバーとタスク）から、各図で説明する部分を切り出す。

   ```powershell
   python docs/hakobi-report/tools/prepare_screens.py
   ```

2. **Wordの生成**：説明図（SVGとPNG）を `tools/report_diagrams.py` の定義から作り直し、Wordを組み立てる。

   ```powershell
   python docs/hakobi-report/tools/build_report_docx.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx
   ```

3. **目次のページ番号**：LibreOfficeでPDFにして、目次に載せる各見出し（章と節）の開始ページを `tools/toc_pages.json` に書く。もう一度2を実行し、もう一度3を実行してもページ番号が変わらないことを確かめる。

   ```powershell
   python docs/hakobi-report/tools/update_toc_pages.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx
   ```

4. **提出用PDFの書き出し**：タグ付きPDF（図の代替テキスト付き、文書の言語は日本語）に書き出す。章と節はPDFのしおりになる。見出しのページが `toc_pages.json` と一致しない場合や、文書の言語が日本語でない場合は、書き出さずに止まる。

   ```powershell
   python docs/hakobi-report/tools/export_pdf.py docs/hakobi-report/HAKOBI_TECHNICAL_REPORT.md docs/hakobi-report/output/HAKOBI_技術レポート.docx docs/hakobi-report/output/HAKOBI_技術レポート.pdf
   ```

Wordの目次はフィールドなので、Wordで開いて「フィールドの更新」を行えば、Word上のページ位置に合わせて更新される。提出するPDFは、Wordではなく4で書き出す。

## 図と表の書き方

- 図は本文に `[[FIGURE:キー]]` と書き、次の行に `図N 題名` を書く（題名は図の下に付く）。キーと代替テキスト・幅は `tools/build_report_docx.py` の `FIGURES` に登録する。
- 説明図は `tools/report_diagrams.py` に描画を足す。SVGだけを直接編集しない。`assets/*.png` は再生成物なので版管理しない。
- 画面の図は `tools/prepare_screens.py` で `assets/screens/` に作る。
- 表は `表N 題名` の行（表の上に付く）、必要なら `[[TABLE-WIDTHS:幅,幅,…]]`（twip、合計9360）、Markdownの表の順に書く。
- 改ページは `[[PAGE-BREAK]]` で入れる。

## 書き方の決まり

- 常体で書き、略語は概要と本文のそれぞれで初出時に正式名称を添える（付録Aにも一覧がある）。
- 件数や実施日のある事実（テストの結果など）は、実行した結果を `evidence/` に記録してから本文に書く。
- 導入の効果や利用者数など、記録のない事実は書かない。

## 推敲版

`HAKOBI_TECHNICAL_REPORT_推敲版.md` は、元の原稿の主張と数値を保ったまま、読みやすさを整えた原稿である（主述のかみ合わせ、分かりにくい言い回し、見出しの読点など）。Word とPDFは `output/HAKOBI_技術レポート_推敲版.docx`・`.pdf` で、上と同じ手順で原稿と出力の名前を替えて作る。目次のページ番号は `tools/toc_pages_HAKOBI_TECHNICAL_REPORT_推敲版.json` に記録する。推敲で補った語句の出典は `HAKOBI_TECHNICAL_REPORT_推敲版.md.material.txt` にある。
