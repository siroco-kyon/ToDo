# ToDo

ガントチャートを中心にしたタスク管理アプリです。タスク管理、サブタスク、依存関係、今日の計画、作業ログを 1 つのアプリで扱えます。

2 つの動作モードがあります。

- デスクトップ版（Electron）
  1 人で使うローカルアプリです。データは端末内の SQLite に保存します。
- チーム向けサーバー版（マルチユーザー Web）
  中央サーバーに配置し、ブラウザから複数人（6 人規模を想定）で利用します。担当者ごとの進捗・期限や「今だれが何をやっているか」を、ガントとチームダッシュボードで共有できます。

React 部分（レンダラー）は両モードで共通です。`window.api` の実装を Electron IPC と HTTP/WebSocket で差し替えることで、同じ画面をデスクトップでもブラウザでも動かしています。

## 主な機能

- ガントチャート中心のタスク管理
- タスクバーのドラッグ移動、開始日・終了日のリサイズ
- 親タスクごとのサブタスク展開・折りたたみ
- 依存関係の管理
  - ガント上のドラッグ接続
  - 依存関係パネルからの追加
  - タスク詳細画面からの追加・待機日数変更・削除
  - Finish to Start 形式の依存関係と待機日数
- 基準線の保存と比較表示
- 進捗シグナル表示
  - 順調
  - 遅れ
  - 期限超過
  - 開始前
- 今日の計画ビュー
- 作業ログとタイマー
- カテゴリ管理
- Markdown エクスポート
- タスクの繰り返し設定
  - daily
  - weekly
  - monthly
- アーカイブ
- 別ウィンドウでのガント表示

### チーム向けサーバー版の追加機能

- 管理者によるアカウント発行（自己登録なし、bcrypt でパスワードをハッシュ化）
- セッション Cookie による認証
- タスクへの担当者割り当てと担当者カラー
- ガントの担当者フィルタ、担当者カラー表示、稼働中ハイライト
- チームダッシュボード
  - いま稼働中（メンバーごとの実行中タイマー）
  - 期限超過 / まもなく期限
  - メンバーの負荷
- WebSocket によるリアルタイム同期（変更が全員に即時反映）
- 管理者用ユーザー管理画面（追加・編集・権限変更・パスワード再設定）

## 画面構成

- `ガント`
  メイン画面です。日程調整、依存関係、基準線、進捗確認をここで行います。
- `計画`
  今日の予定を時間レーンで並べて確認します。
- `記録`
  作業ログを確認します。
- `詳細`
  タスクの説明、日付、カテゴリ、サブタスク、依存関係、ログを確認・編集します。

補足:
- 以前あった `カレンダー` と `概要` は現在のメイン導線から外しています。
- ガントを中心に使う前提の UI です。

## 技術スタック

| 項目 | 内容 |
| --- | --- |
| デスクトップ | Electron 29 |
| UI | React 18 + TypeScript |
| DB | better-sqlite3 |
| ビルド | electron-vite |
| 配布 | electron-builder |
| サーバー | Express + ws + better-sqlite3（`tsx` で実行） |
| 認証 | bcryptjs + セッション Cookie |
| Web ビルド | Vite（`dist-web/` へ出力） |

## セットアップ

```bash
npm install
```

`better-sqlite3` を使っているため、`postinstall` でネイティブモジュールの再ビルドが走ります。

## 開発

```bash
npm run dev
```

開発モードでは Electron と Vite が同時に起動します。

## ビルド

```bash
npm run build
```

本番用のビルド成果物は `out/` に出力されます。

## 配布ビルド

```bash
npm run dist
```

`npm run dist` では次を順に実行します。

1. `build/icon.png` と `build/icon.ico` を生成
2. 本番ビルドを作成
3. `electron-builder` で Windows 向けパッケージを生成

主な出力先:

- `dist/todo-app-1.0.0-setup.exe`
- `dist/win-unpacked/ToDo.exe`

## データ保存先

- 開発時
  `D:\Github\ToDo\data`
- パッケージ版
  `exe` と同じ階層の `data/`

初回セットアップ後は、設定画面から保存先を変更できます。

## チーム向けサーバー版（マルチユーザー Web）

中央サーバー（社内 LAN）に配置し、ブラウザから複数人で利用するモードです。サーバーは `server/` にある独立した Node パッケージで、`better-sqlite3` のネイティブ ABI 競合を避けるため自前の `node_modules` を持ちます。

### 構成

- フロントエンド
  `src/renderer/` の React をそのまま使い、`web/` のエントリでビルドします（出力先 `dist-web/`）。
- サーバー
  Express + better-sqlite3 + ws。`tsx` で TypeScript を直接実行します。既定ポートは `4577`。
- 認証
  管理者がアカウントを発行します（自己登録なし）。パスワードは bcrypt でハッシュ化し、セッションは Cookie（`todo_session`）で管理します。
- リアルタイム同期
  `/ws` の WebSocket で、変更を全クライアントへ即時通知します。

### セットアップ

```bash
# 1. ルート（フロント）依存をインストール
npm install

# 2. サーバー依存をインストール（独立パッケージ）
npm --prefix server install
```

### 開発

フロントとサーバーを別々に起動します。

```bash
# サーバー（ポート 4577、ファイル変更を監視）
npm run dev:server

# Web フロント（ポート 5273、/api と /ws を 4577 にプロキシ）
npm run dev:web
```

ブラウザで `http://localhost:5273` を開きます。

### 本番デプロイ

1. Web フロントをビルドします。成果物は `dist-web/` に出力されます。

   ```bash
   npm run build:web
   ```

2. サーバーを起動します。`dist-web/` が存在すれば、サーバーが同一ポートで画面と API の両方を配信します。

   ```bash
   npm run start:server
   ```

3. 各メンバーは `http://<サーバーのIP>:4577` にブラウザでアクセスします。

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `4577` | サーバーの待ち受けポート |
| `TODO_DATA_DIR` | `server/data` | SQLite データベースの保存先ディレクトリ |
| `TODO_WEB_DIST` | `dist-web`（リポジトリ直下） | 配信する Web ビルドの場所 |
| `ADMIN_USERNAME` | `admin` | 初回起動時に作る管理者のユーザー名 |
| `ADMIN_PASSWORD` | （空） | 管理者の初期パスワード。未設定ならランダム生成し、起動ログに 1 回だけ表示します |
| `SESSION_TTL_DAYS` | `30` | セッションの有効日数 |

### 初回起動と管理者

- データベースは `TODO_DATA_DIR/todo.db`（既定 `server/data/todo.db`）に作成されます。
- ユーザーが 0 人のときだけ、管理者アカウントを 1 つ自動作成します。
  - `ADMIN_PASSWORD` を指定していればそのパスワードを使います。
  - 未指定ならランダムなパスワードを生成し、起動ログに 1 回だけ表示します。必ず控えてください。
- 以降のメンバー追加・編集・権限変更・パスワード再設定は、管理者でログイン後、設定画面の「ユーザー管理」から行います。

### 注意点

- 社内 LAN での利用を前提にした構成です（インターネット公開は想定していません）。
- サーバーの `better-sqlite3` は Node 用 ABI、デスクトップ版は Electron 用 ABI でビルドされます。`server/` は独立パッケージなので、依存を混在させないでください。

## ディレクトリ構成

```text
src/
  main/
    index.ts          # Electron メインプロセス
    db.ts             # SQLite アクセス
    ipc.ts            # IPC ハンドラ
    config.ts         # データ保存先設定
    shortcuts.ts      # グローバルショートカット
    archive.ts        # アーカイブ整理
    markdown.ts       # Markdown エクスポート
    icon.ts           # アイコン操作
  preload/
    index.ts          # renderer に公開する API（Api 契約の定義元）
  renderer/           # React 画面（デスクトップ／サーバー両モードで共通）
    src/
      App.tsx
      types.ts
      components/
        GanttView.tsx
        TodoDetail.tsx
        TodoList.tsx
        PlanView.tsx
        WorkLogSummary.tsx
        Toolbar.tsx
        SettingsModal.tsx
        SetupWizardModal.tsx
        UserManagementModal.tsx   # 管理者用ユーザー管理（サーバー版）
web/                  # Web 版のエントリと HTTP/WS クライアント
  index.html
  main.tsx            # window.api を HTTP/WS 実装で差し替え
  lib/client.ts       # Api 契約の HTTP/WebSocket 実装
  auth/               # ログイン画面・認証ゲート・セッション
server/               # 中央サーバー（独立 Node パッケージ）
  src/
    index.ts          # 起動・静的配信・ルートのマウント
    config.ts         # ポート・データ保存先・管理者・セッション設定
    auth.ts           # bcrypt 認証・セッション・管理者シード
    realtime.ts       # WebSocket リアルタイム同期
    db/               # マルチユーザー対応の SQLite アクセス層
    routes/           # auth / data / users の REST ルート
scripts/
  generate-build-icons.cjs
```

## ショートカット

既定値:

| ショートカット | 動作 |
| --- | --- |
| `Ctrl+Alt+T` | アプリを前面表示 |
| `Ctrl+Alt+N` | クイック追加を開く |
| `Ctrl+Alt+E` | Markdown エクスポート |

設定画面から変更できます。

## メモ

- HTTP クライアントとして `axios` は使っていません。
- データ操作は `window.api` に集約しています。デスクトップ版は Electron IPC、サーバー版は HTTP/WebSocket で同じ契約を実装しています。
- 依存関係の自動調整は DB 側で処理しています（デスクトップ版・サーバー版で同じロジックを移植）。
