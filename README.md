# ToDo

Electron + React + SQLite で作ったデスクトップ向けタスク管理アプリです。

現在はガントチャートを中心にした運用を前提にしていて、タスク管理、サブタスク、依存関係、今日の計画、作業ログを 1 つのアプリで扱えます。

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
    index.ts          # renderer に公開する API
  renderer/
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
- データ操作は Electron の IPC 経由で main プロセスに集約しています。
- 依存関係の自動調整は DB 側で処理しています。
