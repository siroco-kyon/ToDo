// Shared React UI against a disposable server and DB. Run after both builds.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function runElectron() {
  const { app, BrowserWindow } = require('electron')
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  app.setPath('userData', path.join(fixture.temporaryDir, 'user-data'))
  app.commandLine.appendSwitch('disable-gpu')
  app.on('window-all-closed', () => {})
  let main
  const js = expression => main.webContents.executeJavaScript(expression)
  async function until(expression, label) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) { if (await js(expression)) return; await delay(50) }
    throw new Error(label + ': ' + (await js('document.body.innerText')).slice(0, 1400))
  }
  const click = text => js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent===' + JSON.stringify(text) + ').click()')
  try {
    await app.whenReady()
    main = new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true } })
    await main.loadURL(fixture.origin)
    await js('(async()=>{const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(' + JSON.stringify({username:fixture.username,password:fixture.password}) + ')});if(!r.ok)throw new Error("Fixture login");})()')
    await main.loadURL(fixture.origin+'/?view=gantt')
    await until('Boolean(window.api)&&document.body.innerText.includes("ガント")', 'App ready')
    const task = await js('window.api.todoCreate({title:"UX保存テスト",recurrence:"yearly",start_date:"2026-10-19",due_date:"2026-10-20"})')
    await main.loadURL(fixture.origin+'/?view=detail&task='+task.id)
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="UX保存テスト")', 'Detail ready')
    await click('編集')
    await until('Boolean(document.querySelector("input[aria-label=タスク名]"))', 'Editor ready')
    assert.equal(await js('(()=>{const b=Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="変更を保存");const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'),true,'Save action must remain visible at 1024px')
    await js('(()=>{const i=document.querySelector("input[aria-label=タスク名]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,"UX保存済み");i.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await delay(50)
    await js('document.querySelector("input[aria-label=タスク名]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}))')
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="UX保存済み")', 'Ctrl+Enter saves')
    const saved = await js('window.api.todoGetAll()')
    assert.equal(saved.find(t=>t.id===task.id).recurrence,'yearly','Yearly recurrence remains unchanged')
    await main.loadURL(fixture.origin+'/?view=log')
    await until('document.body.innerText.includes("この期間の作業ログはありません")', 'Empty record')
    assert.equal(await js('document.body.innerText.includes("計測開始")'),true)
    await js('window.originalSummary=window.api.worklogGetSummary;window.api.worklogGetSummary=async()=>{throw new Error("UX通信失敗")};window.unhandled=[];window.addEventListener("unhandledrejection",e=>{window.unhandled.push(String(e.reason));e.preventDefault()})')
    await click('14日')
    await until('document.body.innerText.includes("UX通信失敗")', 'Record load error')
    await js('window.api.worklogGetSummary=window.originalSummary;void 0')
    await click('再試行')
    await until('document.body.innerText.includes("この期間の作業ログはありません")', 'Retry recovers')
    await js('window.summaryResolvers={};window.api.worklogGetSummary=d=>new Promise(resolve=>window.summaryResolvers[d]=resolve);void 0')
    await click('3日')
    await until('Boolean(window.summaryResolvers[3])','First period request')
    await click('30日')
    await until('Boolean(window.summaryResolvers[30])','Second period request')
    await js('window.summaryResolvers[30]([])')
    await until('document.body.innerText.includes("この期間の作業ログはありません")','Latest response')
    await js('window.summaryResolvers[3]([{id:"stale",todo_id:"old",title:"古い応答",duration_seconds:3600,start_time:"2026-10-19T00:00:00Z",end_time:"2026-10-19T01:00:00Z"}])')
    await delay(100)
    assert.equal(await js('document.body.innerText.includes("古い応答")'),false,'Older period response must not overwrite latest')
    assert.deepEqual(await js('window.unhandled'),[])
    console.log('HAKOBI UX checks passed: visible save, Ctrl+Enter, yearly preserved, empty record, load failure/retry, response ordering')
    main.destroy(); app.exit(0)
  } catch(error) {
    console.error(error.stack||error.message)
    if(main&&!main.isDestroyed())main.destroy()
    app.exit(1)
  }
}

async function runHost() {
  const { pathToFileURL } = require('node:url')
  const net = require('node:net')
  const modulesDir = path.join(root, 'node_modules')
  const temporaryDir = fs.mkdtempSync(path.join(modulesDir, '.hakobi-ux-test-'))
  let server
  let electron
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const ended = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await Promise.race([ended, delay(5000)])
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Fixture child did not stop')
  }
  try {
    const probe = net.createServer()
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const fixture = { root, temporaryDir, origin: 'http://127.0.0.1:' + port, username: 'detail_admin', password: 'detail-only-test-password' }
    const envFile = path.join(temporaryDir, 'empty.env')
    fs.writeFileSync(envFile, '')
    const fixturePath = path.join(temporaryDir, 'fixture.json')
    fs.writeFileSync(fixturePath, JSON.stringify(fixture))
    let serverOutput = ''
    server = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'server/node_modules/tsx/dist/loader.mjs')).href, path.join(root, 'server/src/index.ts')], {
      cwd: path.join(root, 'server'), windowsHide: true,
      env: { ...process.env, TODO_ENV_FILE: envFile, PORT: String(port), TODO_DATA_DIR: path.join(temporaryDir, 'db'),
        TODO_WEB_DIST: path.join(root, 'dist-web'), ADMIN_USERNAME: fixture.username, ADMIN_PASSWORD: fixture.password, SESSION_COOKIE: 'detail_fixture_session' }
    })
    server.stdout.on('data', (chunk) => { serverOutput += chunk })
    server.stderr.on('data', (chunk) => { serverOutput += chunk })
    let ready = false
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try { const response = await fetch(fixture.origin + '/api/health', { signal: AbortSignal.timeout(1000) }); const data = await response.json(); if (response.ok && data.webReady) { ready = true; break } } catch {}
      await delay(100)
    }
    assert.ok(ready, 'Fixture server failed: ' + serverOutput.replaceAll(fixture.password, '[test password]'))
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    electron = spawn(require('electron'), [__filename, fixturePath], { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    electron.stdout.on('data', (chunk) => { output += chunk })
    electron.stderr.on('data', (chunk) => { output += chunk })
    const timeout = setTimeout(() => electron.kill(), 90000)
    const result = await new Promise((resolve, reject) => { electron.once('error', reject); electron.once('exit', (code, signal) => resolve({ code, signal })) })
    clearTimeout(timeout)
    const cleanOutput = output.replaceAll(fixture.password, '[test password]')
    process.stdout.write(cleanOutput)
    assert.equal(result.code, 0, 'Detail Electron fixture exited ' + (result.code ?? result.signal))
    assert.ok(cleanOutput.includes('HAKOBI UX checks passed:'), 'Fixture did not reach its assertions')
  } finally {
    await stop(electron)
    await stop(server)
    assert.equal(path.dirname(path.resolve(temporaryDir)), path.resolve(modulesDir))
    assert.ok(path.basename(temporaryDir).startsWith('.hakobi-ux-test-'))
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
}
if (process.versions.electron) void runElectron()
else runHost().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
