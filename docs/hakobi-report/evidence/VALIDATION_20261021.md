# HAKOBI 技術レポートの仕様照合と追加検証（2026年10月21日）

対象はコミット`a823ba561fa4e6d88977b8f4fd79c7fa7a45559d`、デスクトップ版のソースのバージョンは1.0.5である。今回はレポートを更新し、アプリのコードは変更していない。10月17日の検証記録は当時の結果として残す。

## 仕様と照合した箇所

| レポート | 実装と確認した内容 |
|---|---|
| 1.4節・2.5節 | 対象日を10月21日とし、10月18〜21日の変更を追加。Git履歴、`UX_LOG.md`、`UX_REPORT.md` |
| 4.1節 | `lib/scheduleHealth.ts`の遅れの条件、`GanttView.tsx`の表示位置と列幅の操作。開始日・期限の有無、保留などの除外条件を記載 |
| 4.3節・5.2節 | `TeamDashboard.tsx`のメンバーの負荷を期限一覧より先に置く順序、 `App.tsx`の`reportTodos`、報告内の担当絞り込み、`ReportView.tsx`の`buildRow`、`lib/dueChanges.ts`の延期判定 |
| 5.3節 | `ReportView.tsx`の`MEETING_KEEP_MS`と保存処理、`MeetingMode.tsx`の議事録コピーと保存の案内。定例の途中経過は端末に開始から12時間保存 |
| 6.2節 | `lib/recurrence.ts`、`lib/recurrenceUndo.ts`、`src/main/db.ts`、`server/src/db/todos.ts`。通常タスクの毎年、2/29の扱い、完了の取り消しと次回分のアーカイブ。ToDoリストの項目には毎年を追加していない |
| 6.3節 | `App.tsx`の一覧と報告の担当範囲、タスク追加の初期値、`GettingStartedModal.tsx`などの案内と操作 |
| 8.1節・8.2節 | 10月17日の検証範囲と結果を過去の実績として保持し、今回の結果を追加 |

パスを省略した画面・libは`src/renderer/src/`以下である。新しい処理・数値を加える部分は実装と照合した。従来からある設計理由、開発経緯、外部資料は全面的に再調査していない。

## 実行結果

既存のNode.js環境で、各コマンドを順に実行した。WebビルドはOSの一時フォルダへ出力し、稼働中の`dist-web/`は差し替えていない。テストは既存の一時データによる検査を用いた。

| 確認 | コマンド | 終了コード | 秒 |
|---|---|---:|---:|
| Web型チェック | `npx tsc --noEmit -p web/tsconfig.json` | 0 | 9.4 |
| main型チェック | `npx tsc --noEmit -p tsconfig.node.json --composite false` | 0 | 3.4 |
| renderer型チェック | `npx tsc --noEmit -p tsconfig.web.json --composite false --noUnusedLocals false` | 0 | 8.7 |
| server型チェック | `npm --prefix server run typecheck` | 0 | 2.7 |
| Webビルド | `npx vite build --config vite.web.config.ts --outDir <一時フォルダ>` | 0 | 4.9 |
| 年次繰り返し | `npm run test:yearly` | 0 | 3.2 |
| 進捗集計・延期・遅れ | `npm run test:progress-report` | 0 | 2.1 |
| 報告リマインド | `npm --prefix server run test:report-reminder` | 0 | 4.0 |
| 期限通知 | `npm --prefix server run test:due-notifications` | 0 | 1.1 |
| ガント表示位置 | `npm run test:gantt-scroll` | 1 | 2.2 |

追加の`npm run test:ux`は終了コード0で合格した。画面上の保存、Ctrl+Enter、毎年の値の保持、入力の保持と再試行、列追加、狭い計画、文字拡大、完了取り消し時の次回分、ガントの列幅とキーボード操作などを検査する既存のElectronテストである。

## ガント表示位置テストの失敗

`npm run test:gantt-scroll`は次の条件で失敗した。

```text
AssertionError [ERR_ASSERTION]: Fixture must view a future date away from today:
{"timeScale":"day","leftDate":"2026-10-05","leftOffset":5,"scrollLeft":15797,"scrollTop":0,"unitWidth":56}
geometry {"left":22971,"width":41795,"client":1130}
```

未来の日付へ移動した状態を作れたかを確かめる最初の条件で止まった。後続の編集・同期・ズームなどの検査には達していないため、この結果から表示位置の保持が正常とも異常とも判定しない。原因の特定とアプリまたはテストの修正は今回行っていない。

## 確認していない範囲

10月17日の全テストは再実行していない。インストーラーの再作成と配布は行っておらず、バージョン1.0.5の配布物と現在のソースが一致することは確認していない。読み上げソフト、実際のブラウザの200%表示、利用による効果の測定も今回の対象外である。本文の画面図は10月17日のデモを保持し、撮影日を1.4節で明示した。

文章の検査では、チーム画面の配置の差分を後から確認したため、推敲版は1回の修正に加えてこの仕様修正を行い、再検査した。検査スクリプトの回数制限についての表示は残している。意味が動く候補は仕様を更新する依頼に基づく変更と、内部資料名の追加が中心であり、原稿・実装と読み比べた。進捗レポートの「担当者ではなく実際に操作した人」は集計対象の違いを伝えるため残した。

## 出力の確認

原稿・推敲版のWordとPDFを再生成した。PDFは両方33ページ、文書言語ja-JP、しおり60件、タグ付き、使用フォントはすべて埋め込みである。`export_pdf.py`で、すべての章・節の開始ページと目次の記録が一致することを確認してから出力した。

PDFの全ページを画像にし、両版の一覧画像と修正した付録Bを目視で確認した。付録Bの最後の行だけが次ページへ送られたため、生成処理で付録Bを新しいページから始めるようにした。修正後の表は32ページに収まり、付録Cは33ページから始まる。Wordの別環境での表示は未確認で、Word上の目次は必要に応じてフィールドを更新する。

`render_docx.py`によるWordの描画も実行したが、同ツールの変換設定では37ページとなり、提出用PDFの33ページとは一致しなかった。提出用PDFのページ位置はリポジトリの`export_pdf.py`の設定を基準とした。Wordを別の変換設定でPDFにする場合は、目次を更新してページ位置とレイアウトを確認する必要がある。

`git diff --check`は成功し、アプリの`src/`・`web/`・`server/`に変更はない。
