# AGENTS.md

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
npm run publish:desktop       # npm run dist の後、dist/ のインストーラーをサーバーの配布フォルダへ公開
```

Web 版の型チェックは `npx tsc --noEmit -p web/tsconfig.json`。ルートに `typecheck` スクリプトは無い。

## アプリの方向性

- 現在はガントチャート中心のアプリ
- `カレンダー` と `概要` はメイン導線から外している
- 依存関係は Finish to Start を採用
- 依存関係はガント画面とタスク詳細画面の両方から編集できる
- データの動作モードは 2 つ。個人用（Electron・ローカル DB）と、チーム用（社内 LAN・サーバー DB）。チーム用はブラウザと HAKOBI デスクトップ版の両方から利用できる
- チーム接続の機能: 担当者割り当て、チームダッシュボード（今/期限）、管理者によるアカウント発行、リアルタイム同期。ブラウザとデスクトップ版で共通
- **デスクトップ版（`src/`）を壊さないこと。** 両モードは同じ React 画面を共有する

## 技術構成

- main process
  Electron + better-sqlite3
- renderer
  React + TypeScript（デスクトップ版・サーバー版で共通）
- renderer から DB を直接触らず、`window.api` 経由でアクセスする
  - 個人用デスクトップ版: Electron IPC（`src/preload/index.ts`）
  - チーム接続（ブラウザ・デスクトップ版）: HTTP/WebSocket（`web/lib/client.ts`）。デスクトップ版はサーバーで配信する Web 画面を読み込む
- server
  Express + ws + better-sqlite3（`tsx` で TypeScript を直接実行、ポート 4577）。`server/` は自前の `node_modules` を持つ独立パッケージ（Electron ABI と Node ABI の競合回避）

## 重要ファイル

```text
src/main/index.ts          Electron 起動とウィンドウ管理
src/main/db.ts             SQLite アクセスと依存関係の連鎖処理
src/main/ipc.ts            IPC ハンドラ
src/main/config.ts         データ保存先
src/main/desktop-controller.ts チーム接続のウィンドウ・タイマー管理
src/main/desktop-config.ts 接続先・デスクトップ設定
src/main/shortcuts.ts      グローバルショートカット

src/preload/index.ts       renderer に公開する API（Api 契約の定義元）
src/preload/desktop.ts     チーム画面に公開するデスクトップ機能

src/renderer/src/App.tsx                       レイアウトと画面切り替え
src/renderer/src/components/GanttView.tsx     ガント本体
src/renderer/src/components/TodoDetail.tsx    タスク詳細
src/renderer/src/components/PlanView.tsx      今日の計画
src/renderer/src/components/WorkLogSummary.tsx 作業ログ
src/renderer/src/components/UserManagementModal.tsx 管理者用ユーザー管理（サーバー版）
src/renderer/src/lib/desktopRelease.ts        配布中のデスクトップ版の取得・検証とバージョン比較（React 非依存）

web/main.tsx               window.api を HTTP/WS 実装で差し替える Web エントリ
web/lib/client.ts          Api 契約の HTTP/WebSocket 実装
web/auth/                  ログイン画面・認証ゲート・セッション
web/desktop/               デスクトップ版のタイマー・進捗入力画面
web/desktop/desktopFeed.ts OS 通知に出す新着の判定と、トレイ・タスクバーに出すタスクの選定
web/desktop/DesktopUpdateNotice.tsx 新しい版のお知らせ（デスクトップ版のメイン画面だけ。左下のカード）
web/download/DesktopDownloadPage.tsx ログイン不要のダウンロードページ（/download）
src/main/desktop-glyphs.ts 未読バッジ・トレイの赤丸・タスクバーのボタン画像を生成（DB に依存しない icon-pixels.ts を使う）

server/src/index.ts        サーバー起動・静的配信・ルートのマウント
server/src/config.ts       ポート・データ保存先・管理者・セッション設定
server/src/auth.ts         bcrypt 認証・セッション・管理者シード
server/src/realtime.ts     WebSocket リアルタイム同期
server/src/db/             マルチユーザー対応の SQLite アクセス層
server/src/routes/         auth / data / users の REST ルート
server/src/desktopRelease.ts latest.yml の解析とインストーラーの検証（サイズ・sha512）、結果のキャッシュ
server/src/routes/desktopRelease.ts /api/desktop-release（ログイン不要。配布中の版の情報とダウンロード）
server/scripts/publish-desktop.ts npm run publish:desktop の本体（dist/ を検証して配布フォルダへ公開）
```

## 実装メモ

- タスク日付変更時は `db.ts` 側で依存関係の連鎖を再計算する
- 依存関係の追加、待機日数変更、削除でも後続タスクを再計算する
- ガントの表示設定は `localStorage` に保存している
- ガントは初回表示と「今日に戻る」の操作で今日へ移動する。編集・同期・期間変更・ズーム・表示幅変更では、現在見ている日付を保つ
- **`Api` 契約 = `typeof api`（`src/preload/index.ts`）。** メソッドを 1 つ足すと、`web/lib/client.ts` も実装しないとコンパイルが通らない（左右対称が型で強制される）。`src/main/ipc.ts` のハンドラも対で要る
- 型定義は二重管理: `src/main/db.ts`（Api 契約の元）と `src/renderer/src/types.ts`（renderer 用の独立コピー）。両者を同一構造に保つ
- 現在ユーザーの取得は `window.api.authGetCurrentUser()` を使う（個人用では `null`、チーム接続では認証済みユーザーを返す）。`web/auth` の `useCurrentUser()` は Web エントリ専用なので共通の `App.tsx` からは使わない
- マルチユーザー判定は `users.length > 0`、管理者判定は `currentUser?.role === 'admin'`。個人用ではどちらも false、デスクトップ版のチーム接続ではブラウザと同じ判定を使う
- 依存連鎖ロジックはサーバー版 `server/src/db/todos.ts` に同じものを移植している（両方を直す）
- チーム接続のデスクトップ版の OS 通知・未読バッジ・トレイのタスク一覧は、非表示のメイン画面の `DesktopCompanion` が判定して `window.desktop` へ渡す。main 側はサーバー API を呼ばない。新着かどうかは端末の localStorage（`hakobi-desktop-notified:<userId>`）で判定し、初回は既存の通知を出さない
- サーバーが配信する画面とインストール済みのデスクトップ版は別々に更新される。`DesktopBridge` に足したメソッドは任意（`notify?`）にして存在を確かめてから呼び、`DesktopState` に足した項目は古い画面が送らない前提で扱う
- デスクトップ版の配布（`/api/desktop-release`）はログイン不要。`server/src/index.ts` で `/api/health` の直後、`/api/auth`・`/api/users`・`dataRouter`（`/api` 以下はすべて認証必須）と SPA のフォールバックより前にマウントする。配布できない理由（配布フォルダのパスを含む）は管理者にだけ返す
- 配信するのは、検証済みの `latest.yml` に書かれた exe 1つだけ（ファイル名のパターン・サイズ・sha512 を確認）。リクエストのパスからファイル名を作らない。`latest.yml` やインストーラーが差し替わると、サーバーを再起動せずに読み直す
- 公開は `npm run publish:desktop`（`server/scripts/publish-desktop.ts`）だけで行う。インストーラーを先に置き、`latest.yml` を最後に差し替える。古いインストーラーは消さない。`electron-builder.yml` の `publish:` は `dist/latest.yml` を出力させるために残す（自動更新はしない）
- `DesktopContext.appVersion`（`src/shared/desktop.ts`）は任意。1.0.4 以前のアプリは送らないので、無いときは 1.0.4 以前として扱う（`LAST_VERSION_WITHOUT_APP_VERSION`）
- `/download` はログイン不要のページ。`web/main.tsx` で `AuthGate` より前に分岐して描画する
- 更新のお知らせ（`DesktopUpdateNotice`）はデスクトップ版のメイン画面（`isDesktopMain`）だけで出し、`App.tsx` には入れない。「後で」で閉じた版は localStorage の `hakobi-desktop-update-dismissed` に保存する
- タスク一覧の絞り込み（担当・カテゴリ・検索）はガント・カンバン・計画・概要・報告にも効く。効いているときは各画面の見出しの横に「絞り込み中」のチップ（`ListFilterChips`、`App.tsx` の `listFilters` を各画面に渡す）を出し、その場で解除できる。1行を取る帯にはしない。報告タブには一覧の担当絞り込みをかけず（`reportTodos`）、報告タブ自身の担当絞り込みで決める。進捗タブの投稿先の選択肢も絞り込み前のタスクから選ぶ
- タスク追加（`QuickAddModal`）の初期値は、担当＝一覧の担当絞り込みの人（絞っていなければ自分）、カテゴリ＝左で選んでいるもの、開始日＝今日。追加したタスクが今の絞り込みで見えないときは、`handleAdded` が「絞り込みを解除して開く」付きで知らせる
- 上部のタブは、表示中のタブをもう一度押しても画面を変えない（以前はタスク詳細へ戻るトグルだった）
- 進捗率のバーは `ProgressSlider` に揃えている（タスク詳細・サブタスク・報告タブ）。ドラッグは要素の pointer イベントで受け、ウィンドウ全体にリスナーを付けない
- ガントの保留ボタンは、保留中のタスクだけ紫の「▶」を常に出す。保留していない行の「Ⅱ」は `.tarbo-gantt-hold-toggle`（行にマウスを乗せたときだけ表示）
- 「集計から外す」カテゴリ（`is_private`）はアクセス制限ではない。画面では「プライベート」と書かず「集計外」と表記する。上部の「すべて表示／集計外を隠す」は集計外カテゴリがあるときだけ出す
- 用語は「期限」（締切と書かない）、「進捗ログ」（進捗メモと書かない）に揃える。説明＝目的、メモ＝今の状況（上書き）、進捗ログ＝日付つきで積み上がる報告
- 進捗タブの「新着」は、前回タブを見た時刻（`progressTimeline.lastSeenAt:<userId>`、`lib/progressActivity.ts`）より後にほかの人が書いた投稿・返信。タブを開いた時点と離れる時点で `serverNow()` を書き込む。上部タブの件数は `useProgressUnseenCount`（サーバー版のみ、`onDataChanged('progress')` で取り直す）
- 「@名前」の判定はサーバーの `server/src/mention.ts` と画面の `lib/progressActivity.ts`（`mentionsUser`・`MENTION_BEFORE`）で同じ規則にする（片方だけ直さない）。入力欄の候補は `MentionTextarea`
- 進捗ログ・返信のリアクションは `ReactionBar`（`LikeButton.tsx`）。👍 は常に出し、🎉 👀 🙏 は「☺＋」から。サーバー・デスクトップの DB は任意の絵文字を受け付ける

## 注意点

- `better-sqlite3` を使うので、依存インストール後にネイティブ再ビルドが必要
- 文字化けした日本語が残っていたら、README と UI 文言の両方を確認する
- ドキュメント更新時は、ガント中心の仕様と依存関係機能の説明を優先する
- UI 文言はすべて日本語
- サーバー版は社内 LAN 前提（インターネット公開は想定外、セキュリティは軽め）。アカウントは管理者が発行（自己登録なし）、パスワードは bcrypt、セッションは Cookie
- 個人用デスクトップ版（`src/`）を壊さない。共通の `App.tsx` などに手を入れるときは、チーム用機能をフラグ（`multiUser` / `isAdmin`）でガードする
