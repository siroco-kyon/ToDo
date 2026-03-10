# ToDo

タイムトラッキング機能付きのTODO管理Electronデスクトップアプリ。

## 主要機能

- **タスク管理** — 優先度（5段階）・進捗度（0〜100%）・期日設定
- **カテゴリ分類** — タスクをカテゴリで整理、色分け対応
- **サブタスク** — タスクを細分化して管理
- **時間トラッキング** — 作業タイマー・作業ログ記録、再起動後もタイマー復元
- **繰り返しタスク** — daily / weekly / monthly に対応
- **期限通知** — 期限前に自動通知（1時間ごとにチェック）
- **Markdownエクスポート** — 日次ログをクリップボードに出力
- **システムトレイ常駐** — 閉じてもバックグラウンドで動作継続
- **ドラッグ＆ドロップ** — カテゴリ・タスク・サブタスクの並び替え
- **複数ソートモード** — 作成日・更新日・優先度・進捗・期日・タイトル・手動順
- **アーカイブ自動削除** — デフォルト90日後に古いアーカイブを自動削除
- **初回起動ウィザード** — 初期セットアップをガイド

## 技術スタック

| レイヤー | 技術 |
|--------|------|
| デスクトップ | Electron 29 |
| UI | React 18 + TypeScript |
| データベース | better-sqlite3（同期API） |
| ビルド | electron-vite + electron-builder |

## インストール・起動

```bash
npm install        # 依存関係インストール
npm run dev        # 開発サーバー起動（Electron + Vite）
npm run build      # プロダクションビルド
npm run dist       # インストーラー生成
```

> **注意:** `better-sqlite3` はネイティブモジュールのため、初回インストール時に自動でリビルドされます（`postinstall` フック）。

## アーキテクチャ

### ディレクトリ構造

```
src/
  main/            # Electronメインプロセス
    index.ts       # BrowserWindow・トレイ・ショートカット初期化
    db.ts          # better-sqlite3 全CRUD（同期）
    ipc.ts         # IPCハンドラ登録
    tray.ts        # システムトレイ常駐
    shortcuts.ts   # グローバルショートカット
    markdown.ts    # 日次ログMarkdown生成
    notifications.ts  # 期限通知
    archive.ts     # 起動時アーカイブ自動削除
    config.ts      # 設定・データディレクトリ管理
  preload/
    index.ts       # contextBridge API公開
  renderer/
    src/
      App.tsx              # 3ペインレイアウト
      types.ts             # 共通型定義
      components/          # UIコンポーネント群
      hooks/useTimer.ts    # タイマー状態管理
```

### 設計方針

- **SQLiteはメインプロセスのみ** — better-sqlite3は同期APIのため、レンダラーからの直接アクセス禁止
- **IPC経由通信** — レンダラー↔DB操作はすべて `window.api.*` 経由
- **タイマー排他制御** — `RunningState` テーブルで管理（最大1行）
- **セキュリティ** — `nodeIntegration: false` + `contextIsolation: true` + contextBridgeによるAPI公開
- **ウィンドウ動作** — 閉じるボタンはウィンドウ非表示（トレイ常駐）、終了はトレイメニューから

## グローバルショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+N` | クイック追加モーダルを開く |
| `Ctrl+Alt+E` | 日次ログをMarkdownとしてクリップボードにコピー |
