# HAKOBI 技術レポートの検証記録（2026年10月17日）

本文の「8. 品質の確認」に書いた結果の元になる記録である。運用中のサーバー、DB、Windowsサービス、インストール済みアプリは変更していない。Webのビルドは稼働中の `dist-web/` ではなく、作業用の一時フォルダへ出力した。

## 対象と環境

| 項目 | 内容 |
|---|---|
| 対象 | `main` のコミット `f9c1bc6`（アプリのコードの最終変更は `520f6dd`、2026年10月17日）。下の「時間切れの原因と修正」の後は、これに `src/main/ipc.ts` の修正を加えたもの |
| デスクトップ版 | 1.0.5（`package.json`） |
| OS | Windows 11 Home（Microsoft Windows [Version 10.0.26300.9711]） |
| Node.js | v22.16.0 |
| 主な部品（インストール済みの版） | Electron 29.4.6、React 18.3.1、TypeScript 5.9.3、Vite 5.4.21、Express 4.22.2、ws 8.21.0、better-sqlite3 11.10.0（サーバー）、bcryptjs 2.4.3、tsx 4.22.3 |
| 実行方法 | 下表のコマンドを順に1回ずつ実行し、終了コードと所要時間（秒）を記録した |

## 結果（2026年10月17日 9時06分〜9時09分）

| 区分 | コマンド | 終了コード | 所要時間 | 結果 |
|---|---|---:|---:|---|
| 型チェック | `npx tsc --noEmit -p web/tsconfig.json` | 0 | 17秒 | 合格 |
| 型チェック | `npx tsc --noEmit -p tsconfig.node.json --composite false` | 0 | 4秒 | 合格 |
| 型チェック | `npx tsc --noEmit -p tsconfig.web.json --composite false --noUnusedLocals false` | 0 | 8秒 | 合格 |
| 型チェック | `npm --prefix server run typecheck` | 0 | 3秒 | 合格 |
| ビルド | `npx vite build --config vite.web.config.ts --outDir <一時フォルダ>` | 0 | 5秒 | 成功 |
| 自動テスト | `npm run test:quality` | 1 | 61秒 | 不合格（下記） |
| 自動テスト | `npm run test:hakobi` | 0 | 73秒 | 合格 |
| 自動テスト | `npm run test:progress-timeline` | 0 | 2秒 | 合格 |
| 自動テスト | `npm run test:progress-report` | 0 | 2秒 | 合格 |
| 自動テスト | `npm run test:links-members` | 0 | 3秒 | 合格 |
| 自動テスト | `npm run test:on-hold` | 0 | 2秒 | 合格 |
| 自動テスト | `npm run test:todo-list` | 0 | 3秒 | 合格 |
| 自動テスト | `npm run test:reorder` | 0 | 1秒 | 合格 |
| 自動テスト | `npm run test:url` | 0 | 1秒未満 | 合格 |
| 自動テスト | `npm run test:gantt-scroll` | 0 | 7秒 | 合格 |
| 自動テスト | `npm run test:installer` | 0 | 3秒 | 合格 |
| 自動テスト | `npm --prefix server run test:mention` | 0 | 1秒 | 合格 |
| 自動テスト | `npm --prefix server run test:report-reminder` | 0 | 1秒 | 合格 |
| 自動テスト | `npm --prefix server run test:backup` | 0 | 2秒 | 合格 |
| 自動テスト | `npm --prefix server run test:overview` | 0 | 1秒 | 合格 |

自動テスト15コマンドのうち14コマンドが合格した。

## test:quality の内訳（2026年10月17日 9時10分〜）

`test:quality` は6つのテストを順に実行し、1つが失敗すると残りを実行しない。1回目は最初のテストで止まったため、6つを個別に実行し直した。

| テスト | 終了コード | 所要時間 | 結果 |
|---|---:|---:|---|
| `node tests/local-data-regressions.cjs` | 1 | 60秒 | 不合格。11項目の `PASS` と「Local data regression checks passed」を出力した後、Electron（Node.jsとして実行）のプロセスが60秒の制限時間内に終了せず、`spawnSync ... ETIMEDOUT` となった。1回目と同じ結果 |
| `node tests/task-data-regressions.cjs` | 0 | 2秒 | 合格（個人用とサーバーのタスクデータ） |
| `node tests/timer-sync-regressions.cjs` | 0 | 1秒 | 合格 |
| `npm --prefix server run test:auth-import` | 0 | 3秒 | 合格 |
| `node tests/server-deployment.cjs` | 0 | 1秒未満 | 合格 |
| `node tests/hakobi-detail-electron.cjs` | 0 | 14秒 | 合格（実Electronの詳細画面） |

この時点では、`local-data-regressions` の時間切れの原因を調べていなかった。検査の項目そのものは合格を出力しているが、テストとしては不合格として扱った。原因と修正は下の「時間切れの原因と修正」に記録した。

## 時間切れの原因と修正（2026年10月17日 10時ごろ）

### 原因の確認

`tests/local-data-regressions.cjs` を作業用フォルダにコピーし、リポジトリのコードは変えずに次の2つを試した。

| 試したこと | 結果 |
|---|---|
| 検査の終わりに、残っている処理（`process.getActiveResourcesInfo()`）を表示する | `PipeWrap, PipeWrap, Timeout`。3秒後も同じで、プロセスは終わらなかった（PipeWrap は標準出力などの通り道） |
| 同じコピーで、`setInterval` で作るタイマーだけを `unref` にする | 作られたタイマーは60,000ミリ秒（1分）の1つだけ。残る処理は `PipeWrap, PipeWrap` だけになり、テストは3秒で自然に終わった（終了コード0） |

残っていたタイマーは、`src/main/ipc.ts` の `registerIpcHandlers` にある1分ごとの点検である。日付が変わったら、ToDoリストの繰り返しの項目を未チェックに戻す。この点検は2026年10月14日の #70（コミット `2226b41`）で加わった。テストは検査の途中で `registerIpcHandlers` を呼ぶため、検査の後もタイマーが残り、プロセスが終わらなかった。10月9日の全体確認の時点では、このタイマーはなかった。

### 修正

`src/main/ipc.ts` のこのタイマーに `unref()` を付け、プロセスの終了を引き止めないようにした。アプリはウィンドウとトレイで動き続けるので、アプリが動いているあいだは点検をこれまでどおり行う。

### 修正後の結果（2026年10月17日 10時07分〜10時10分）

| 区分 | コマンド | 終了コード | 所要時間 | 結果 |
|---|---|---:|---:|---|
| 型チェック | `npx tsc --noEmit -p tsconfig.node.json --composite false` | 0 | 4秒 | 合格 |
| 自動テスト | `npm run test:quality` | 0 | 23秒 | 合格（`local-data-regressions` を含む6テスト） |
| 自動テスト | `npm run test:todo-list` | 0 | 2秒 | 合格 |
| 自動テスト | `npm run test:hakobi` | 0 | 69秒 | 合格 |
| 自動テスト | `npm run test:progress-timeline` | 0 | 3秒 | 合格 |
| 自動テスト | `npm run test:progress-report` | 0 | 2秒 | 合格 |
| 自動テスト | `npm run test:links-members` | 0 | 3秒 | 合格 |
| 自動テスト | `npm run test:on-hold` | 0 | 3秒 | 合格 |
| 自動テスト | `npm run test:reorder` | 0 | 1秒未満 | 合格 |
| 自動テスト | `npm run test:url` | 0 | 1秒未満 | 合格 |
| 自動テスト | `npm run test:gantt-scroll` | 0 | 7秒 | 合格 |
| 自動テスト | `npm run test:installer` | 0 | 3秒 | 合格 |
| 自動テスト | `npm --prefix server run test:mention` | 0 | 1秒 | 合格 |
| 自動テスト | `npm --prefix server run test:report-reminder` | 0 | 2秒 | 合格 |
| 自動テスト | `npm --prefix server run test:backup` | 0 | 2秒 | 合格 |
| 自動テスト | `npm --prefix server run test:overview` | 0 | 1秒 | 合格 |

自動テスト15コマンドすべてが合格した。修正はmainプロセスのコードだけで、Webの画面とサーバーには触れていないため、Web・サーバーの型チェックとWebのビルドは最初の実行の結果のままとした。

## テストの構成（ファイル数）

- `tests/`：Node.jsで実行するスクリプト36ファイル（`*.cjs`）。一部は実際のElectronを非表示で起動する。
- `server/tests/`：Node.jsのテストランナー（`node:test`、`tsx --test`）で実行するテスト12ファイル。
- テストはそれぞれ独立した一時DB・一時フォルダ・一時サーバーを使う（`docs/HAKOBI.md` の「開発時の確認」）。

## 数えた値と数え方

| 値 | 数え方 |
|---|---|
| コミット159件、PR番号87件 | `git log --oneline | wc -l`、`main` の first-parent の件名に含まれる `#番号` の種類 |
| 開発開始 2026年3月4日 | 最初のコミットの日付 |
| テーブル 個人用15・サーバー23 | `src/main/db.ts` と `server/src/` の `CREATE TABLE IF NOT EXISTS` の名前の種類 |
| window.api のメソッド99 | `src/preload/index.ts` の `api` オブジェクトの直下のキー |
| ソースの行数 | `.ts`・`.tsx`・`.cjs`・`.css` の行数（`wc -l`）。main 5,855行、preload 356行、共通画面 29,052行、Web 2,264行、サーバー 6,497行、テスト 7,223行 |

## 参考資料の確認（2026年10月17日）

参考文献に挙げた外部のURLは、すべてHTTPの状態コード200で開けることを確かめた。SQLiteの「同時に書き込めるのは1つ」（When To Use）、WALで読み取りと書き込みが互いを妨げないこと（Write-Ahead Logging）、OWASPがArgon2idを勧め、bcryptを使う既存のシステムには作業係数10以上を求めていることは、各ページの本文で確かめた。

## レポートの生成と確認（2026年10月17日）

| 確認 | 結果 |
|---|---|
| 目次のページ番号 | `update_toc_pages.py` を2回実行し、2回目で見出しのページが変わらないことを確かめた |
| 提出用PDF | 30ページ。しおり60件（章と節）、文書の言語 ja-JP、タグ付きPDF、使用フォント（Yu Gothic、Yu Mincho、Calibri、Consolas）はすべて埋め込み、全ページから本文を抽出できる |
| 目視の確認 | 全30ページを画像にして確かめた。図とキャプションの分離、表の切れ、孤立した見出し、空白ページ、文字のはみ出しはない |
| 文字数 | 概要739字。本文（1章〜10章）は表を除いて11,620字、表を含めて14,304字（空白・記号を除いて数えた） |
| 図表の参照 | 図13点・表12点のすべてを本文から番号で参照している |
| 略語 | 概要と本文のそれぞれで、初めて使う箇所に正式名称を添えた（付録Aに一覧） |
| 画面の図 | `docs/hakobi-introduction/assets-current/` のデモの画面だけを使った。人名・業務名・記録は架空で、実在のホスト名やパスは写っていない |
