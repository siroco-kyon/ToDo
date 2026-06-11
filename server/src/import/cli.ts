import fs from 'fs'
import path from 'path'
import { initDb, getDb } from '../db/connection'
import { getUserByUsername, listUsers } from '../db/users'
import { DB_PATH } from '../config'
import { importDesktopDb } from './import-desktop-db'

interface CliArgs {
  db?: string
  user?: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--db' || token === '-d') {
      args.db = argv[++i]
    } else if (token === '--user' || token === '-u') {
      args.user = argv[++i]
    } else if (token === '--dry-run' || token === '-n') {
      args.dryRun = true
    }
  }
  return args
}

function printUsage(): void {
  console.log(`
デスクトップ版の todo.db を、担当者を指定してサーバー版に取り込みます。

使い方（すべて D:\\Github\\ToDo で実行）:
  npm run import:db -- --db "<デスクトップ版 todo.db のパス>" --user <Webのユーザー名>

オプション:
  --db,   -d   取り込む元の todo.db ファイルのパス（必須）
  --user, -u   取り込み先の担当者になる Web ユーザー名（必須・先に作成しておく）
  --dry-run, -n  実際には書き込まず、件数だけ確認する

例:
  npm run import:db -- --db "D:\\Github\\ToDo\\data\\todo.db" --user kenji
  npm run import:db -- --db "C:\\Users\\kenji\\AppData\\Roaming\\todo-app\\data\\todo.db" --user kenji --dry-run

※ 取り込み中はサーバー（npm run dev:server / start:server）を止めておいてください。
`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (!args.db || !args.user) {
    printUsage()
    process.exit(1)
  }

  const sourcePath = path.resolve(args.db)
  if (!fs.existsSync(sourcePath)) {
    console.error(`[取り込み] ファイルが見つかりません: ${sourcePath}`)
    process.exit(1)
  }

  initDb()

  const target = getUserByUsername(args.user)
  if (!target) {
    console.error(`[取り込み] ユーザー名 "${args.user}" が見つかりません。先に「ユーザー管理」で作成してください。`)
    const names = listUsers().map((u) => u.username)
    if (names.length > 0) console.error(`  利用できるユーザー名: ${names.join(', ')}`)
    process.exit(1)
  }

  console.log(`[取り込み] 元ファイル: ${sourcePath}`)
  console.log(`[取り込み] 取り込み先: ${target.display_name} (${target.username})`)
  console.log(`[取り込み] 保存先DB : ${DB_PATH}`)
  if (args.dryRun) console.log('[取り込み] ドライラン（実際には書き込みません）')

  try {
    const result = importDesktopDb({
      webDb: getDb(),
      sourceDbPath: sourcePath,
      targetUserId: target.id,
      dryRun: args.dryRun
    })

    console.log('==============================================')
    console.log(args.dryRun ? '取り込みプレビュー（未保存）' : '取り込み完了')
    console.log(`  カテゴリ      : ${result.categories} 件（新規追加分のみ）`)
    console.log(`  タスク        : ${result.todos} 件`)
    console.log(`  サブタスク    : ${result.subTasks} 件`)
    console.log(`  依存関係      : ${result.dependencies} 件`)
    console.log(`  作業ログ      : ${result.workLogs} 件`)
    console.log(`  予定（レール）: ${result.planItems} 件`)
    if (result.skippedOrphans > 0) {
      console.log(`  スキップ      : ${result.skippedOrphans} 件（参照先タスクが無い孤立データ）`)
    }
    console.log('==============================================')
    if (args.dryRun) {
      console.log('問題なければ --dry-run を外して再実行してください。')
    }
  } catch (error) {
    console.error('[取り込み] 失敗しました:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
