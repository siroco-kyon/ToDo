// 画面のスクリーンショットをまとめて PNG に保存する（UI/UX の見直し用）。
// 動いているサーバー版に Electron の画面外ウィンドウでログインし、画面サイズとテーマを変えて撮る。
// 本番のサーバーには向けないこと。検証用に別ポート・別データで起動したサーバーを使う。
//
//   npx electron scripts/ux-screenshots.cjs --port 4599 --out ux-shots/before \
//     --user admin --password-file <テスト用パスワードのファイル> [--only gantt,detail]
// （引数に URL をそのまま書くと Electron が起動しないことがあるので、ポート番号で渡す）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const port = argOf('port', '4599')
const origin = `http://localhost:${port}`
const outDir = path.resolve(argOf('out', 'ux-shots/current'))
const username = argOf('user', 'admin')
const passwordFile = argOf('password-file')
const only = (argOf('only', '') || '').split(',').filter(Boolean)

if (!/^\d{2,5}$/.test(port)) {
  console.error('--port にはポート番号を書いてください（検証用のローカルのサーバーだけに使えます）')
  process.exit(1)
}
if (!passwordFile) {
  console.error('--password-file を指定してください')
  process.exit(1)
}
const password = fs.readFileSync(passwordFile, 'utf8').trim()

// 画面の中で使う小さな道具（文字でボタンを探して押す、など）
const PAGE_HELPERS = `
  window.__ux = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    find(text, selector = 'button, [role=button], [role=tab], a, summary, label') {
      return [...document.querySelectorAll(selector)].find((element) => (element.textContent || '').replace(/\\s+/g, ' ').includes(text)
        || (element.getAttribute('aria-label') || '').includes(text) || (element.getAttribute('title') || '').includes(text))
    },
    click(text, selector) {
      const element = this.find(text, selector)
      if (!element) throw new Error('見つかりません: ' + text)
      element.click()
      return true
    }
  }
`

/**
 * 撮る画面。path は ?view=... の部分。taskTitle を書くと、その名前のタスクを開く。
 * steps は読み込み後に画面の中で実行する JavaScript（ボタンを押してモーダルを開くなど）
 */
const SHOTS = [
  { name: 'gantt', view: 'gantt', width: 1440, height: 900 },
  { name: 'gantt-light', view: 'gantt', width: 1440, height: 900, theme: 'light' },
  { name: 'gantt-1920', view: 'gantt', width: 1920, height: 1080 },
  { name: 'gantt-1024', view: 'gantt', width: 1024, height: 768 },
  { name: 'gantt-800', view: 'gantt', width: 800, height: 700 },
  { name: 'kanban', view: 'kanban', width: 1440, height: 900 },
  { name: 'kanban-1024', view: 'kanban', width: 1024, height: 768 },
  { name: 'detail', view: 'detail', taskTitle: '試作機の設計レビュー', width: 1440, height: 900 },
  { name: 'detail-light', view: 'detail', taskTitle: '試作機の設計レビュー', width: 1440, height: 900, theme: 'light' },
  { name: 'detail-1024', view: 'detail', taskTitle: '試作機の設計レビュー', width: 1024, height: 768 },
  { name: 'detail-edit', view: 'detail', taskTitle: '週次の進捗共有', width: 1440, height: 900,
    steps: "__ux.click('編集', 'button'); await __ux.sleep(600)" },
  { name: 'detail-recurring', view: 'detail', taskTitle: '週次の進捗共有', width: 1440, height: 900 },
  { name: 'report', view: 'report', width: 1440, height: 900 },
  { name: 'report-light', view: 'report', width: 1440, height: 900, theme: 'light' },
  { name: 'progress', view: 'progress', width: 1440, height: 900 },
  { name: 'plan', view: 'plan', width: 1440, height: 900 },
  { name: 'plan-1024', view: 'plan', width: 1024, height: 768 },
  { name: 'todo', view: 'todo', width: 1440, height: 900 },
  { name: 'team', view: 'team', width: 1440, height: 900 },
  { name: 'log', view: 'log', width: 1440, height: 900 },
  { name: 'overview', view: 'overview', width: 1440, height: 900 },
  { name: 'quickadd', view: 'gantt', width: 1440, height: 900,
    steps: "__ux.click('タスクを追加', 'button'); await __ux.sleep(800)" },
  { name: 'quickadd-1024', view: 'gantt', width: 1024, height: 768,
    steps: "__ux.click('タスクを追加', 'button'); await __ux.sleep(800)" },
  { name: 'detail-large-font', view: 'detail', taskTitle: '試作機の設計レビュー', width: 1280, height: 800, fontScale: '150%' },
  { name: 'kanban-light', view: 'kanban', width: 1440, height: 900, theme: 'light' },
  { name: 'palette', view: 'gantt', width: 1440, height: 900,
    steps: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await __ux.sleep(600)" }
]

async function settle(win, ms = 1800) {
  // 読み込み中の表示が消えるまで（最大 8 秒）待ってから、描画が落ち着くのを少し待つ
  for (let i = 0; i < 40; i += 1) {
    const loading = await win.webContents.executeJavaScript(
      "Boolean([...document.querySelectorAll('body *')].find((el) => el.children.length === 0 && /読み込み中/.test(el.textContent || '')))"
    ).catch(() => true)
    if (!loading) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * テーマと文字の大きさ。端末（localStorage）と、ログインした人の設定（サーバー）の両方に書く。
 * 画面はサーバーの設定を後から読み込んで上書きするため、片方だけだと撮る画面に効かないことがある
 */
async function applyLook(win, theme, fontScale) {
  await win.webContents.executeJavaScript(`(async () => {
    localStorage.setItem('app-theme-mode', ${JSON.stringify(theme)})
    localStorage.setItem('app-font-scale', ${JSON.stringify(fontScale)})
    if (window.api) {
      // 「はじめての方へ」の知らせは撮る画面に入れない（ラウンド15で追加）
      const me = await window.api.authGetCurrentUser()
      localStorage.setItem('hakobi-getting-started:' + (me ? me.id : 'local'), '1')
      await window.api.settingsSet('themeMode', ${JSON.stringify(theme)})
      await window.api.settingsSet('fontScale', ${JSON.stringify(fontScale)})
    }
  })()`)
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const partition = `ux-shots-${Date.now()}`
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { partition, offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true }
  })
  win.webContents.setFrameRate(30)
  await win.loadURL(`${origin}/`)
  const login = await win.webContents.executeJavaScript(`fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify({ username, password })})
  }).then((response) => response.status)`)
  if (login !== 200) throw new Error(`ログインできませんでした（${login}）`)
  const todos = await win.webContents.executeJavaScript("fetch('/api/todos').then((response) => response.json())")

  const results = []
  for (const shot of SHOTS) {
    if (only.length && !only.some((name) => shot.name === name || shot.name.startsWith(`${name}-`))) continue
    win.setContentSize(shot.width, shot.height)
    const params = new URLSearchParams({ view: shot.view })
    if (shot.taskTitle) {
      const todo = todos.find((item) => item.title === shot.taskTitle)
      if (!todo) { results.push(`${shot.name}: タスク「${shot.taskTitle}」がありません`); continue }
      params.set('task', todo.id)
    }
    await applyLook(win, shot.theme ?? 'dark', shot.fontScale ?? '100%')
    await win.loadURL(`${origin}/?${params}`)
    await settle(win)
    if (shot.steps) {
      try {
        await win.webContents.executeJavaScript(`(async () => { ${PAGE_HELPERS}; ${shot.steps} })()`)
        await settle(win, 700)
      } catch (error) {
        results.push(`${shot.name}: 操作に失敗 ${error.message}`)
      }
    }
    const image = await win.webContents.capturePage()
    const file = path.join(outDir, `${shot.name}.png`)
    fs.writeFileSync(file, image.toPNG())
    results.push(`${shot.name}: ${path.relative(process.cwd(), file)}`)
  }
  // 次に撮るときのために、テーマと文字の大きさを既定（ダーク・標準）に戻しておく
  await applyLook(win, 'dark', '100%').catch(() => {})
  console.log(results.join('\n'))
}

app.disableHardwareAcceleration()
app.whenReady().then(main).then(() => app.quit(), (error) => {
  console.error(error)
  app.exit(1)
})
