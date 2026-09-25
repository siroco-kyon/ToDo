# CLAUDE.md

このファイルは、このリポジトリを扱うエージェント向けの簡易メモです。

## コマンド

```bash
# デスクトップ版（Electron）
npm install
npm run dev
npm run build
npm run dist

# チーム向けサーバー版（マルチユーザー Web）
npm --prefix server install   # サーバー依存（独立パッケージ）
npm run dev:server            # サーバー（ポート 4577）
npm run dev:web               # Web フロント（ポート 5273、/api と /ws を 4577 へプロキシ）
npm run build:web             # Web ビルド → dist-web/
npm run start:server          # dist-web/ を配信しつつサーバー起動
```

Web 版の型チェックは `npx tsc --noEmit -p web/tsconfig.json`。ルートに `typecheck` スクリプトは無い。

## アプリの方向性

- 現在はガントチャート中心のアプリ
- `カレンダー` と `概要` はメイン導線から外している
- 依存関係は Finish to Start を採用
- 依存関係はガント画面とタスク詳細画面の両方から編集できる
- 動作モードは 2 つ。デスクトップ版（Electron・1 人）と、サーバー版（社内 LAN・6 人規模のマルチユーザー Web）
- サーバー版だけの機能: 担当者割り当て、チームダッシュボード（今/期限）、管理者によるアカウント発行、リアルタイム同期
- **デスクトップ版（`src/`）を壊さないこと。** 両モードは同じ React 画面を共有する

## 技術構成

- main process
  Electron + better-sqlite3
- renderer
  React + TypeScript（デスクトップ版・サーバー版で共通）
- renderer から DB を直接触らず、`window.api` 経由でアクセスする
  - デスクトップ版: Electron IPC（`src/preload/index.ts`）
  - サーバー版: HTTP/WebSocket（`web/lib/client.ts`）
- server
  Express + ws + better-sqlite3（`tsx` で TypeScript を直接実行、ポート 4577）。`server/` は自前の `node_modules` を持つ独立パッケージ（Electron ABI と Node ABI の競合回避）

## 重要ファイル

```text
src/main/index.ts          Electron 起動とウィンドウ管理
src/main/db.ts             SQLite アクセスと依存関係の連鎖処理
src/main/ipc.ts            IPC ハンドラ
src/main/config.ts         データ保存先
src/main/shortcuts.ts      グローバルショートカット

src/preload/index.ts       renderer に公開する API（Api 契約の定義元）

src/renderer/src/App.tsx                       レイアウトと画面切り替え
src/renderer/src/components/GanttView.tsx     ガント本体
src/renderer/src/components/TodoDetail.tsx    タスク詳細
src/renderer/src/components/PlanView.tsx      今日の計画
src/renderer/src/components/WorkLogSummary.tsx 作業ログ
src/renderer/src/components/ReportView.tsx    報告タブ（定例用。担当者別に進捗ログを返信まで全文表示・鮮度判定）
src/renderer/src/components/ProgressNoteThread.tsx 進捗ログ＋返信スレッドの表示（報告タブ・概要で共通。コールバックを渡すと、いいね・編集・削除が有効になる）
src/renderer/src/components/LikeButton.tsx    いいねボタンと押した人のツールチップ（進捗タブ・報告タブ・概要で共通）
src/renderer/src/components/ProgressSlider.tsx ドラッグ・キー操作で進捗率を変えるバー（離したときに1回だけ保存）
src/renderer/src/lib/dueDate.ts               日付のみ文字列のローカル解釈と期限色分けの共通ヘルパー
src/renderer/src/components/UserManagementModal.tsx 管理者用ユーザー管理（サーバー版）

web/main.tsx               window.api を HTTP/WS 実装で差し替える Web エントリ
web/lib/client.ts          Api 契約の HTTP/WebSocket 実装
web/auth/                  ログイン画面・認証ゲート・セッション

server/src/index.ts        サーバー起動・静的配信・ルートのマウント
server/src/config.ts       ポート・データ保存先・管理者・セッション設定
server/src/auth.ts         bcrypt 認証・セッション・管理者シード
server/src/realtime.ts     WebSocket リアルタイム同期
server/src/db/             マルチユーザー対応の SQLite アクセス層
server/src/routes/         auth / data / users の REST ルート
```

## 実装メモ

- タスク日付変更時は `db.ts` 側で依存関係の連鎖を再計算する
- 依存関係の追加、待機日数変更、削除でも後続タスクを再計算する
- ガントの表示設定は `localStorage` に保存している
- ガントの自動スクロールは表示期間やズーム変更時だけ走る（今日を時間軸の左から 1/4 に置く）
- ガントのバーは `overflow: hidden` にしない。塗りは内側の切り取り用 div に入れ、タスク名は `position: sticky` で表示範囲の左端に留めている（祖先に overflow があると sticky が効かなくなる）
- ガントの土日・祝日の塗りは、全行共通の SVG 1枚を行の背景に敷いている。祝日は `@holiday-jp/holiday_jp` を動的 import（別チャンク）
- **`Api` 契約 = `typeof api`（`src/preload/index.ts`）。** メソッドを 1 つ足すと、`web/lib/client.ts` も実装しないとコンパイルが通らない（左右対称が型で強制される）。`src/main/ipc.ts` のハンドラも対で要る
- 型定義は二重管理: `src/main/db.ts`（Api 契約の元）と `src/renderer/src/types.ts`（renderer 用の独立コピー）。両者を同一構造に保つ
- 現在ユーザーの取得は `window.api.authGetCurrentUser()` を使う（デスクトップ版は `null` を返す）。`web/auth` の `useCurrentUser()` は Web 専用なので共通の `App.tsx` からは使わない
- マルチユーザー判定は `users.length > 0`、管理者判定は `currentUser?.role === 'admin'`。どちらもデスクトップ版では false
- 依存連鎖ロジックはサーバー版 `server/src/db/todos.ts` に同じものを移植している（両方を直す）
- 報告タブの「期間中の変化」は変更履歴から計算する。タスクは `TodoChangeLogs`（`updateTodo` で記録）、サブタスクは `SubTaskChangeLogs`（`updateSubTask` で progress / due_date が変わったときだけ記録）。`todoChangeGetByRange` が両方を返し、`subtask_id` で区別する

## 注意点

- `better-sqlite3` を使うので、依存インストール後にネイティブ再ビルドが必要
- 文字化けした日本語が残っていたら、README と UI 文言の両方を確認する
- ドキュメント更新時は、ガント中心の仕様と依存関係機能の説明を優先する
- UI 文言はすべて日本語
- サーバー版は社内 LAN 前提（インターネット公開は想定外、セキュリティは軽め）。アカウントは管理者が発行（自己登録なし）、パスワードは bcrypt、セッションは Cookie
- デスクトップ版（`src/`）を壊さない。共通の `App.tsx` などに手を入れるときは、サーバー版専用機能をフラグ（`multiUser` / `isAdmin`）でガードする
