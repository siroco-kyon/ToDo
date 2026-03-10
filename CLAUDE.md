# CLAUDE.md
必ず日本語で出力してください。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
npm install        # 依存関係インストール
npm run dev        # 開発サーバー起動（Electron + Vite）
npm run build      # プロダクションビルド
npm run dist       # インストーラー生成
```

## アーキテクチャ概要

**Electronデスクトップアプリ** - タイムトラッキング付きTODO管理

### 技術スタック
- **メインプロセス**: Electron + better-sqlite3 (同期API)
- **レンダラー**: React 18 + TypeScript (Vite)
- **IPC**: contextBridge経由でのみDB操作（nodeIntegration無効）
- **ビルド**: electron-vite + electron-builder

### ディレクトリ構造
```
src/
  main/        # Electronメインプロセス
    index.ts   # BrowserWindow・トレイ・ショートカット初期化
    db.ts      # better-sqlite3 全CRUD（同期）
    ipc.ts     # IPCハンドラ登録
    tray.ts    # システムトレイ常駐
    shortcuts.ts  # グローバルショートカット
    markdown.ts   # 日次ログMarkdown生成
    archive.ts    # 起動時アーカイブ自動削除
  preload/
    index.ts   # contextBridge API公開
  renderer/
    src/
      App.tsx           # 3ペインレイアウト
      types.ts          # 共通型定義
      components/       # UIコンポーネント
      hooks/useTimer.ts # タイマー状態管理
```

### 重要な設計方針
- SQLiteはメインプロセスのみで使用（better-sqlite3は同期API）
- レンダラー↔DB通信はすべてIPC経由（`window.api.*`）
- タイマー排他制御: `RunningState`テーブルで管理（最大1行）
- アプリ起動時にRunningStateを確認してタイマーを復元
- 閉じるボタンはウィンドウ非表示（トレイ常駐）、終了はトレイメニュー

### グローバルショートカット（デフォルト）
- `Ctrl+Alt+N` - クイック追加モーダル
- `Ctrl+Alt+E` - Markdownエクスポート（クリップボード）
