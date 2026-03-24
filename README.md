# ToDo

Electron + React + SQLite で作ったデスクトップ向けの ToDo / 作業ログアプリです。  
タスク管理だけでなく、タイマー計測、日次ログ、ガントチャート、カテゴリ整理、繰り返しタスク運用までを 1 つにまとめています。

## 主な機能

- タスク、カテゴリ、サブタスクの作成・編集・完了管理
- ガントチャート表示
  - 親タスクとサブタスクを階層表示
  - 開始日 / 期限のドラッグ編集
  - 表示期間、粒度、カテゴリ、表示対象の絞り込み
  - 別ウィンドウ表示
- 計画 / 概要 / カレンダー / 記録ビュー
- 今日のレール表示と日次の作業整理
- タイマー計測と作業ログ保存
- daily / weekly / monthly の繰り返しタスク
- 期限通知
- Markdown 形式でのログ出力
- システムトレイ常駐
- グローバルショートカット
- データ保存先の変更
- アプリアイコンの差し替え

## 技術スタック

| 項目 | 内容 |
| --- | --- |
| デスクトップ基盤 | Electron 29 |
| UI | React 18 + TypeScript |
| データベース | better-sqlite3 |
| ビルド | electron-vite + electron-builder |

## 開発

```bash
npm install
npm run dev
npm run build
```

- `npm run dev`
  Electron + Vite の開発モードで起動します。
- `npm run build`
  本番用ビルドを `out/` に生成します。

`better-sqlite3` を使っているため、依存インストール時にネイティブモジュールの再ビルドが走ります。通常は `postinstall` で自動処理されます。

## 配布ビルド

```bash
npm run dist
```

`npm run dist` では次を順に実行します。

1. `build/icon.png` と `build/icon.ico` を自動生成
2. Electron 本体を本番ビルド
3. `electron-builder` で配布物を生成

Windows では主に次の成果物が出ます。

- `dist/todo-app-1.0.0-setup.exe`
- `dist/win-unpacked/ToDo.exe`

セットアップ exe とアプリ exe には、同じビルド用アイコンを使います。

## データ保存先

- 開発時: `<プロジェクト>/data`
- パッケージ版の既定: `exe` と同じ階層の `data/`

初回起動時のセットアップ画面、または設定画面から保存先を変更できます。

## 画面構成

- `ガント`
  メインの進行管理ビューです。初期表示もガントです。
- `計画`
  予定とタスクの整理に使います。
- `概要`
  全体の状況を俯瞰します。
- `カレンダー`
  日付ベースで確認します。
- `記録`
  作業ログを確認します。

## ディレクトリ構成

```text
src/
  main/
    index.ts          # Electron メインプロセス
    db.ts             # SQLite アクセス
    ipc.ts            # IPC ハンドラ
    tray.ts           # システムトレイ
    shortcuts.ts      # グローバルショートカット
    notifications.ts  # 期限通知
    archive.ts        # 古いデータの整理
    config.ts         # 保存先などの初期設定
    icon.ts           # 実行時アイコン処理
  preload/
    index.ts          # renderer へ公開する API
  renderer/
    src/
      App.tsx
      types.ts
      components/
        GanttView.tsx
        TodoDetail.tsx
        TodoList.tsx
        CalendarView.tsx
        OverviewDashboard.tsx
        PlanView.tsx
        WorkLogSummary.tsx
        SettingsModal.tsx
        SetupWizardModal.tsx
scripts/
  generate-build-icons.cjs  # 配布用 icon.png / icon.ico 生成
```

## 既定ショートカット

設定画面から変更できます。

| ショートカット | 動作 |
| --- | --- |
| `Ctrl+Alt+T` | アプリを前面表示 |
| `Ctrl+Alt+N` | クイック追加モーダルを開く |
| `Ctrl+Alt+E` | Markdown エクスポートを開く |

## メモ

- 配布ビルドの Windows アイコンは `electron-builder` 側で明示設定しています。
- 実行中のアプリアイコン差し替えは設定画面から行えます。
- ガントチャートでタスクを選ぶと、右ペインに詳細を表示できます。
