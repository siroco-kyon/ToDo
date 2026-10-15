import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'

export const WINDOWS_APP_ID = 'com.hakobi.app'

function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/** Brand the Windows shell independently of the legacy installer/data identities. */
export function applyWindowsTaskbarBranding(window: BrowserWindow): void {
  if (process.platform !== 'win32') return

  const executable = process.execPath
  const appPath = app.isPackaged ? null : app.getAppPath()
  const developmentIcon = appPath ? path.join(appPath, 'build', 'icon.ico') : null
  const iconPath = developmentIcon && fs.existsSync(developmentIcon) ? developmentIcon : executable
  const relaunchCommand = appPath
    ? `${quoteWindowsArgument(executable)} ${quoteWindowsArgument(appPath)}`
    : quoteWindowsArgument(executable)

  // A distinct shell ID prevents Windows from reusing the old ToDo taskbar group.
  window.setAppDetails({
    appId: WINDOWS_APP_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand,
    relaunchDisplayName: 'HAKOBI'
  })
}

/**
 * タスクバーのアイコンを右クリックしたとき（ジャンプリスト）の操作。トレイのメニューと同じことができるようにする。
 * 項目を選ぶと2つ目の HAKOBI が引数つきで起動し、動いている HAKOBI に操作を渡して終わる。
 */
export type LaunchAction =
  | 'quick-add' | 'progress' | 'timer'
  | 'main' | 'notifications' | 'timer-stop' | 'timer-start' | 'connection' | 'quit'

export interface LaunchRequest {
  action: LaunchAction
  /** timer-start で計測を始めるタスク */
  todoId?: string
}

const LAUNCH_ACTION_PREFIX = '--hakobi-action='
const LAUNCH_TASK_PREFIX = '--hakobi-task='
const LAUNCH_ACTIONS: Record<LaunchAction, { title: string; description: string }> = {
  main: { title: 'メイン画面を開く', description: 'HAKOBIのメイン画面を開きます' },
  notifications: { title: '通知を見る', description: '届いている通知を開きます' },
  'quick-add': { title: 'タスクを追加', description: 'HAKOBIにタスクを追加します' },
  progress: { title: '進捗をすぐ書く', description: '計測中のタスクの進捗を書きます' },
  timer: { title: '右下タイマーを表示', description: '作業時間のタイマーを表示します' },
  'timer-stop': { title: '計測を停止', description: '計測中のタスクの作業時間を記録して止めます' },
  'timer-start': { title: '計測を開始', description: 'このタスクで作業時間の計測を始めます' },
  connection: { title: '接続先を変更', description: 'つなぐサーバーを変えます' },
  quit: { title: 'HAKOBIを終了', description: 'HAKOBIを終了します' }
}

/** タスクIDは画面から渡る UUID だけを受け付ける（コマンドラインから好きな値を入れられないように） */
function isLaunchTodoId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(value)
}

/** Only the fixed jump list actions are accepted from a command line. */
export function parseLaunchAction(argv: readonly string[]): LaunchAction | null {
  return parseLaunchRequest(argv)?.action ?? null
}

export function parseLaunchRequest(argv: readonly string[]): LaunchRequest | null {
  let action: LaunchAction | null = null
  let todoId: string | undefined
  for (const argument of argv) {
    if (argument.startsWith(LAUNCH_ACTION_PREFIX)) {
      const value = argument.slice(LAUNCH_ACTION_PREFIX.length)
      if (action === null && Object.prototype.hasOwnProperty.call(LAUNCH_ACTIONS, value)) action = value as LaunchAction
    } else if (argument.startsWith(LAUNCH_TASK_PREFIX)) {
      const value = argument.slice(LAUNCH_TASK_PREFIX.length)
      if (isLaunchTodoId(value)) todoId = value
    }
  }
  if (!action) return null
  // タスクのない「計測を開始」は受け付けない
  if (action === 'timer-start') return todoId ? { action, todoId } : null
  return { action }
}

/** ジャンプリストに出す内容（トレイのメニューと同じ状況で作る） */
export interface JumpListState {
  /** 計測の操作（停止・開始）を出せるか（サインイン済みで、新しい画面のとき） */
  timerControls: boolean
  /** 計測中なら表示名（タスク名を隠す設定では「作業中」） */
  runningLabel: string | null
  /** 計測を始められる最近のタスク */
  recentTasks: Array<{ id: string; title: string }>
  /** 通知を開けるか。開けるときは未読の数 */
  unread: number | null
  /** 進捗入力・右下タイマーを開けるか */
  ready: boolean
}

const JUMP_LIST_RECENT_LIMIT = 5
let appliedJumpList: string | null = null
/** ユーザーがジャンプリストから消した項目（引数で見分ける）。この起動中は出し直さない */
const removedJumpListArgs = new Set<string>()

/**
 * 消された項目をもう一度入れると、Windows はその欄ごと出さなくなる。
 * 作り直す前に消された項目を聞いて、カスタムの欄から外す。
 */
function withoutRemovedItems(categories: Electron.JumpListCategory[]): Electron.JumpListCategory[] {
  if (!categories.some((category) => category.type === 'custom')) return categories
  try {
    for (const removed of app.getJumpListSettings().removedItems ?? []) {
      if (removed.args) removedJumpListArgs.add(removed.args)
    }
  } catch (error) {
    console.error('[HAKOBI] ジャンプリストから消された項目を読めませんでした', error)
  }
  if (removedJumpListArgs.size === 0) return categories
  return categories.flatMap((category) => {
    if (category.type !== 'custom') return [category]
    const items = (category.items ?? []).filter((item) => !item.args || !removedJumpListArgs.has(item.args))
    return items.length ? [{ ...category, items }] : []
  })
}

function menuTitle(value: string, max = 40): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Taskbar right-click tasks start a second instance, which forwards its action to the running app. */
export function applyWindowsJumpList(state: JumpListState | false): void {
  if (process.platform !== 'win32') return
  const appPath = app.isPackaged ? null : app.getAppPath()
  const item = (action: LaunchAction, title: string, description: string, todoId?: string): Electron.JumpListItem => ({
    type: 'task',
    program: process.execPath,
    args: [appPath ? quoteWindowsArgument(appPath) : '', `${LAUNCH_ACTION_PREFIX}${action}`, todoId ? `${LAUNCH_TASK_PREFIX}${todoId}` : ''].filter(Boolean).join(' '),
    iconPath: process.execPath,
    iconIndex: 0,
    title,
    description
  })
  const label = (action: LaunchAction): { title: string; description: string } => LAUNCH_ACTIONS[action]
  const categories: Electron.JumpListCategory[] = []
  if (state) {
    const timerItems: Electron.JumpListItem[] = []
    if (state.timerControls) {
      if (state.runningLabel) timerItems.push(item('timer-stop', `計測を停止（${menuTitle(state.runningLabel, 30)}）`, label('timer-stop').description))
      for (const task of state.recentTasks.slice(0, JUMP_LIST_RECENT_LIMIT)) {
        timerItems.push(item('timer-start', `${state.runningLabel ? '切り替え' : '計測開始'}: ${menuTitle(task.title)}`, `「${menuTitle(task.title, 80)}」で計測を始めます`, task.id))
      }
    }
    if (timerItems.length) categories.push({ type: 'custom', name: '計測', items: timerItems })
    const tasks: Electron.JumpListItem[] = [
      item('main', label('main').title, label('main').description),
      ...(state.unread !== null ? [item('notifications', state.unread ? `通知を見る（未読 ${state.unread}件）` : label('notifications').title, label('notifications').description)] : []),
      item('quick-add', label('quick-add').title, label('quick-add').description),
      ...(state.ready ? [
        item('progress', label('progress').title, label('progress').description),
        item('timer', label('timer').title, label('timer').description)
      ] : []),
      item('connection', label('connection').title, label('connection').description),
      item('quit', label('quit').title, label('quit').description)
    ]
    categories.push({ type: 'tasks', items: tasks })
  }
  // 同じ内容なら作り直さない（状態が変わるたびに呼ばれるため）
  const signature = JSON.stringify(categories)
  if (signature === appliedJumpList) return
  try {
    const applied = withoutRemovedItems(categories)
    const result = applied.length ? app.setJumpList(applied) : app.setJumpList(null)
    // プライバシーやグループポリシーの設定でカスタムの欄を出せないときは、「タスク」だけ出す
    if (result === 'customCategoryAccessDeniedError' && applied.some((category) => category.type === 'custom')) {
      const fallback = app.setJumpList(applied.filter((category) => category.type !== 'custom'))
      if (fallback !== 'ok') console.error('[HAKOBI] タスクバーのジャンプリストを更新できませんでした', fallback)
    } else if (result !== 'ok') {
      console.error('[HAKOBI] タスクバーのジャンプリストを更新できませんでした', result)
    }
    appliedJumpList = signature
  } catch (error) {
    console.error('[HAKOBI] タスクバーのジャンプリストを更新できませんでした', error)
  }
}
