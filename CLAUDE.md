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
npm run publish:desktop       # npm run dist の後、dist/ のインストーラーをサーバーの配布フォルダへ公開
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
src/main/desktop-controller.ts チーム接続のウィンドウ・タイマー・トレイ・OS 通知・タスクバー
src/main/desktop-glyphs.ts 未読バッジ・トレイの赤丸・タスクバーのボタン画像を生成（DB に依存しない icon-pixels.ts を使う）

src/preload/index.ts       renderer に公開する API（Api 契約の定義元）

src/renderer/src/App.tsx                       レイアウトと画面切り替え
src/renderer/src/components/GanttView.tsx     ガント本体
src/renderer/src/components/TodoDetail.tsx    タスク詳細
src/renderer/src/components/PlanView.tsx      今日の計画
src/renderer/src/components/WorkLogSummary.tsx 作業ログ
src/renderer/src/components/ReportView.tsx    報告タブ（定例用。担当者別に進捗ログを返信まで全文表示・鮮度判定）
src/renderer/src/components/ReportSettingsPanel.tsx 報告タブの表示設定（カテゴリ・状態・対象・サブタスク・小見出し・隠したタスク）
src/renderer/src/lib/reportViewSettings.ts     報告タブの表示設定の型と保存（見ている人ごと。キーにユーザーID）
src/renderer/src/components/MeetingMode.tsx    報告タブの定例モード（1人ずつ表示・持ち時間・その場でタスク作成・議事録のコピー）
src/renderer/src/components/ProgressNoteHelpers.tsx 進捗ログの投稿欄の「ひな形」「予定どおり」（詳細・報告タブ・進捗タブで共通）
src/renderer/src/components/ProgressNoteThread.tsx 進捗ログ＋返信スレッドの表示（報告タブ・概要で共通。コールバックを渡すと、いいね・編集・削除が有効になる）
src/renderer/src/components/LikeButton.tsx    いいねボタンと押した人のツールチップ（進捗タブ・報告タブ・概要で共通）
src/renderer/src/components/ProgressSlider.tsx ドラッグ・キー操作で進捗率を変えるバー（離したときに1回だけ保存）
src/renderer/src/lib/dueDate.ts               日付のみ文字列のローカル解釈と期限色分けの共通ヘルパー
src/renderer/src/components/TodoChecklist.tsx ToDoリスト（中の項目をチェックして使うタスク）の項目の表示・チェック・追加・編集
src/renderer/src/lib/todoList.ts              ToDoリストの項目の繰り返しの選択肢と「今回 3/5・残り2」の集計
src/renderer/src/lib/todoListReport.ts        報告タブの ToDoリストの実施状況（終わった回と今の回を分けて数える。React 非依存）
server/src/shared/recurring-period.ts         ToDoリストの項目の周期の計算（サーバー版・デスクトップ版で共通）
src/renderer/src/lib/desktopRelease.ts        配布中のデスクトップ版の取得・検証とバージョン比較（React 非依存）
src/renderer/src/components/UserManagementModal.tsx 管理者用ユーザー管理（サーバー版）

web/main.tsx               window.api を HTTP/WS 実装で差し替える Web エントリ
web/lib/client.ts          Api 契約の HTTP/WebSocket 実装
web/auth/                  ログイン画面・認証ゲート・セッション
web/desktop/DesktopCompanion.tsx 非表示のメイン画面で動き、トレイの状態・OS 通知・トレイからの計測操作を担当
web/desktop/desktopFeed.ts OS 通知に出す新着の判定と、トレイ・タスクバーに出すタスクの選定
web/desktop/DesktopUpdateNotice.tsx 新しい版のお知らせ（デスクトップ版のメイン画面だけ。左下のカード）
web/download/DesktopDownloadPage.tsx ログイン不要のダウンロードページ（/download）

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
- ガントの自動スクロールは表示期間やズーム変更時だけ走る（今日を時間軸の左から 1/4 に置く）
- ガントのバーは `overflow: hidden` にしない。塗りは内側の切り取り用 div に入れ、タスク名は `position: sticky` で表示範囲の左端に留めている（祖先に overflow があると sticky が効かなくなる）。サブタスクのバーも同じ構造
- ガントの土日・祝日の塗りは、全行共通の SVG 1枚を行の背景に敷いている。祝日は `@holiday-jp/holiday_jp` を動的 import（別チャンク）
- ガントの依存関係を引くつかみ（オレンジの丸）はバーの右端の外に置く。バーの中に置くと、期限を変える右端のつかみに重なってドラッグできなくなる
- ガントの遅れ判定は「予定の進捗（経過日数の割合）」と実績の差を日数に換算して、表示設定の日数（既定2日）以上なら遅れ。土日・祝日を除いて数える設定もある
- **`Api` 契約 = `typeof api`（`src/preload/index.ts`）。** メソッドを 1 つ足すと、`web/lib/client.ts` も実装しないとコンパイルが通らない（左右対称が型で強制される）。`src/main/ipc.ts` のハンドラも対で要る
- 型定義は二重管理: `src/main/db.ts`（Api 契約の元）と `src/renderer/src/types.ts`（renderer 用の独立コピー）。両者を同一構造に保つ
- 現在ユーザーの取得は `window.api.authGetCurrentUser()` を使う（デスクトップ版は `null` を返す）。`web/auth` の `useCurrentUser()` は Web 専用なので共通の `App.tsx` からは使わない
- マルチユーザー判定は `users.length > 0`、管理者判定は `currentUser?.role === 'admin'`。どちらもデスクトップ版では false
- 依存連鎖ロジックはサーバー版 `server/src/db/todos.ts` に同じものを移植している（両方を直す）
- チーム接続のデスクトップ版の OS 通知・未読バッジ・トレイのタスク一覧は、非表示のメイン画面の `DesktopCompanion` が判定して `window.desktop` へ渡す。main 側はサーバー API を呼ばない。新着かどうかは端末の localStorage（`hakobi-desktop-notified:<userId>`）で判定し、初回は既存の通知を出さない
- サーバーが配信する画面とインストール済みのデスクトップ版は別々に更新される。`DesktopBridge` に足したメソッドは任意（`notify?`）にして存在を確かめてから呼び、`DesktopState` に足した項目は古い画面が送らない前提で扱う
- デスクトップ版の配布（`/api/desktop-release`）はログイン不要。`server/src/index.ts` で `/api/health` の直後、`/api/auth`・`/api/users`・`dataRouter`（`/api` 以下はすべて認証必須）と SPA のフォールバックより前にマウントする。配布できない理由（配布フォルダのパスを含む）は管理者にだけ返す
- 配信するのは、検証済みの `latest.yml` に書かれた exe 1つだけ（ファイル名のパターン・サイズ・sha512 を確認）。リクエストのパスからファイル名を作らない。`latest.yml` やインストーラーが差し替わると、サーバーを再起動せずに読み直す
- 公開は `npm run publish:desktop`（`server/scripts/publish-desktop.ts`）だけで行う。インストーラーを先に置き、`latest.yml` を最後に差し替える。古いインストーラーは消さない。`electron-builder.yml` の `publish:` は `dist/latest.yml` を出力させるために残す（自動更新はしない）
- `DesktopContext.appVersion`（`src/shared/desktop.ts`）は任意。1.0.4 以前のアプリは送らないので、無いときは 1.0.4 以前として扱う（`LAST_VERSION_WITHOUT_APP_VERSION`）
- `/download` はログイン不要のページ。`web/main.tsx` で `AuthGate` より前に分岐して描画する
- 更新のお知らせ（`DesktopUpdateNotice`）はデスクトップ版のメイン画面（`isDesktopMain`）だけで出し、`App.tsx` には入れない。「後で」で閉じた版は localStorage の `hakobi-desktop-update-dismissed` に保存する
- 進捗レポート（`ProgressReportModal`）は「やった人」で数える。タスク別レポートには集計したメンバー（`digest.users`）が書いた進捗ログ・返信だけを載せる（副担当など他の人のログを自分の報告に混ぜない。デスクトップ版は絞らない）。サーバー版の完了タスクは完了にした人（`completed_at` と同じ時刻の `TodoChangeLogs` の status → done の操作者。アーカイブからの復元は完了日時を変えないので数えない）、追加サブタスクは `SubTasks.created_by` で数え、記録がない古いデータだけ主担当で数える。サブタスクに合わせて親の期限を延ばした変更も、サブタスクを操作した人の変更として記録する
- ToDoリスト（`Todos.list_mode = 1`）は繰り返し（次回分の作成）を持たない（`applyTodoUpdate` は SQL 側でも止める）。期限は持てるが、なしでもよい。項目の期限に合わせた親の期限延長はしない。依存関係の再計算では、期限のないリストは開始日だけずらし、期限を入れない（`shiftListToStart`）。タスクを ToDoリストにしても期限は消さない。両 DB に同じ規則がある
- ToDoリストの項目（サブタスク）の `recurrence`（daily / weekly / monthly、平日だけは `recurrence_workdays`）は、周期が変わると未チェックに戻す。戻すのは `resetRecurringSubTasks`（サブタスクの読み書きの前と、日付が変わったときの1分ごとの点検。点検で戻したら `subtask` の変更を全画面に知らせる）。チェックの記録は `SubTaskChecks`（周期ごとに1件）に残し、`SubTaskChangeLogs` の進捗の変化には数えない
- ToDoリストの繰り返さない項目は開始日と期限を持てる。開始日が来たか、期限が今日か過ぎていれば「今日やること」に出す（`isTodayItem`・`todayItemsOf`）。繰り返しの項目には開始日・期限を持たせない（ガントに毎日のバーが並ぶため。画面で繰り返しにすると両方を空にして保存する）
- 報告タブの ToDoリストのカードは、周期（毎日・平日／毎週／毎月）ごとに「終わった回の実施（昨日まで 18/20回）」と「今の回（今日 1/5）」を分けて出す。数え方は `lib/todoListReport.ts`（画面・Markdown・CSV で共通）。今日を含む回（`subtaskCheckSummaryGetByRange` の `current_key`）はチェックしても実施の回数に入れない（入れると作ったばかりのリストが1件のチェックで 1/1回＝100% になる）。率（%）は終わった回が5回以上のときだけ出す。カード上部に一覧の「今回 3/5」は出さない
- `subtaskCheckSummaryGetByRange` は、期間に重なる周期（項目を作った日から今日まで）と、そのうち `SubTaskChecks` がある周期、今日を含む周期（`current_key`。先週を選んでも今月の分のように続いていれば返す）を返す。両 DB に同じ処理がある
- 報告タブの「期間中の変化」は変更履歴から計算する。タスクは `TodoChangeLogs`（`updateTodo` で記録）、サブタスクは `SubTaskChangeLogs`（`updateSubTask` で progress / due_date が変わったときだけ記録）。`todoChangeGetByRange` が両方を返し、`subtask_id` で区別する
- タスク一覧の絞り込み（担当・カテゴリ・検索）はガント・カンバン・計画・概要・報告にも効く。効いているときは各画面の見出しの横に「絞り込み中」のチップ（`ListFilterChips`、`App.tsx` の `listFilters` を各画面に渡す）を出し、その場で解除できる。1行を取る帯にはしない。報告タブには一覧の担当絞り込みをかけず（`reportTodos`）、報告タブ自身の担当絞り込みで決める。進捗タブの投稿先の選択肢も絞り込み前のタスクから選ぶ
- タスク追加（`QuickAddModal`）の初期値は、担当＝一覧の担当絞り込みの人（絞っていなければ自分）、カテゴリ＝左で選んでいるもの、開始日＝今日。追加したタスクが今の絞り込みで見えないときは、`handleAdded` が「絞り込みを解除して開く」付きで知らせる
- 上部のタブは、表示中のタブをもう一度押しても画面を変えない（以前はタスク詳細へ戻るトグルだった）
- 画面は `React.lazy` で分けて読み込む（ガント・一覧・詳細・ツールバー以外の画面と、設定などの小窓）。分けた部品は `ViewBoundary` で包む（読み込み中の表示と、読めなかったときの再読み込みの案内）。分けた部品のファイルから定数などを App に import すると分けた意味がなくなるので、`lib/` に置く（例: `lib/fontSettings.ts`）
- 計測中の経過秒数は `useTimer` では持たない。表示する部品が `useElapsedSeconds(startTime)`（`RunningTimerDisplay` など）で数え、App を毎秒描き直さない
- ガント（`GanttView`）と一覧の行（`TodoRow`）は `React.memo`。App から渡す関数は `useCallback`・ref で固定し、JSX（絞り込みのチップなど）は `useMemo` で作る。毎回新しい関数や要素を渡すと、タスクを選ぶたびにガントの全行を描き直す
- 進捗率のバーは `ProgressSlider` に揃えている（タスク詳細・サブタスク・報告タブ）。ドラッグは要素の pointer イベントで受け、ウィンドウ全体にリスナーを付けない
- ガントの保留ボタンは、保留中のタスクだけ紫の「▶」を常に出す。保留していない行の「Ⅱ」は `.tarbo-gantt-hold-toggle`（行にマウスを乗せたときだけ表示）
- 「集計から外す」カテゴリ（`is_private`）はアクセス制限ではない。画面では「プライベート」と書かず「集計外」と表記する。上部の「すべて表示／集計外を隠す」は集計外カテゴリがあるときだけ出す
- 用語は「期限」（締切と書かない）、「進捗ログ」（進捗メモと書かない）に揃える。説明＝目的、メモ＝今の状況（上書き）、進捗ログ＝日付つきで積み上がる報告
- 進捗タブの「新着」は、前回タブを見た時刻（`progressTimeline.lastSeenAt:<userId>`、`lib/progressActivity.ts`）より後にほかの人が書いた投稿・返信。タブを開いた時点と離れる時点で `serverNow()` を書き込む。上部タブの件数は `useProgressUnseenCount`（サーバー版のみ、`onDataChanged('progress')` で取り直す）
- 「@名前」の判定はサーバーの `server/src/mention.ts` と画面の `lib/progressActivity.ts`（`mentionsUser`・`MENTION_BEFORE`）で同じ規則にする（片方だけ直さない）。入力欄の候補は `MentionTextarea`
- 報告のリマインド（サーバー版だけ）は、設定 `reportMeetingWeekday`（管理者が設定画面で選ぶ。未設定なら出さない）の前日17時以降に、直近7日に進捗ログもメモの更新もない担当タスクがある人へ1日1回 `report_reminder` の通知を出す（`server/src/db/notifications.ts` の `ensureReportReminder`。1分ごとの点検と通知の取得時に確かめる）
- 進捗ログ・返信のリアクションは `ReactionBar`（`LikeButton.tsx`）。👍 は常に出し、🎉 👀 🙏 は「☺＋」から。サーバー・デスクトップの DB は任意の絵文字を受け付ける

## 注意点

- `better-sqlite3` を使うので、依存インストール後にネイティブ再ビルドが必要
- 文字化けした日本語が残っていたら、README と UI 文言の両方を確認する
- ドキュメント更新時は、ガント中心の仕様と依存関係機能の説明を優先する
- UI 文言はすべて日本語
- サーバー版は社内 LAN 前提（インターネット公開は想定外、セキュリティは軽め）。アカウントは管理者が発行（自己登録なし）、パスワードは bcrypt、セッションは Cookie
- デスクトップ版（`src/`）を壊さない。共通の `App.tsx` などに手を入れるときは、サーバー版専用機能をフラグ（`multiUser` / `isAdmin`）でガードする
