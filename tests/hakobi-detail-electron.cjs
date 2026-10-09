// Real shared UI against an isolated server. Build both targets before running.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  app.setPath('userData', path.join(fixture.temporaryDir, 'user-data'))
  app.commandLine.appendSwitch('disable-gpu')
  app.on('window-all-closed', () => {})
  const preferences = { showTimer: false, alwaysOnTop: false, hideTaskTitle: false }
  ipcMain.handle('hakobi:context', () => ({ version: 1, serverVersion: 1, groupName: '詳細テスト', serverUrl: fixture.origin, preferences }))
  ipcMain.handle('hakobi:state', () => {})
  for (const action of ['main', 'timer', 'progress', 'gantt', 'report', 'connection', 'hide', 'resize-timer']) ipcMain.handle('hakobi:' + action, () => {})
  let main
  const js = async (expression) => {
    try { return await main.webContents.executeJavaScript(expression) }
    catch (error) { throw new Error(error.message + '\nRenderer operation: ' + expression) }
  }
  async function until(expression, label) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { if (await js(expression)) return; await delay(75) }
    throw new Error(label + ': ' + (await js('document.body.innerText')).slice(0, 1700))
  }
  const click = (text) => js('Array.from(document.querySelectorAll("button")).find(b => b.textContent === ' + JSON.stringify(text) + ').click()')
  async function editTitle(title) {
    await click('編集')
    await until('document.body.innerText.includes("閉じる")', 'Full editor did not open')
    await js('(function(){ const input=Array.from(document.querySelectorAll("input")).find(e=>e.value===window.tasks.currentTitle); if(!input)throw new Error("Missing title input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,' + JSON.stringify(title) + '); input.dispatchEvent(new Event("input",{bubbles:true})); })()')
    await delay(100)
  }
  const navigate = (id) => main.webContents.send('hakobi:command', { type: 'navigate', todoId: id })
  async function currentTask(id, title) {
    navigate(id)
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent===' + JSON.stringify(title) + ')', 'Native detail target did not change')
    await js('window.tasks.currentTitle=' + JSON.stringify(title))
  }
  try {
    await app.whenReady()
    main = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: path.join(fixture.root, 'out/preload/desktop.js'), partition: 'persist:detail-fixture',
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
    main.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message) })
    await main.loadURL(fixture.origin)
    await until('Boolean(document.querySelector("input[autocomplete=username]"))', 'Login did not render')
    await js('(async()=>{ const response=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(' + JSON.stringify({ username: fixture.username, password: fixture.password }) + ')});if(!response.ok)throw new Error("Fixture login"); })()')
    main.reload()
    await until('document.body.innerText.includes("ガント") && !document.querySelector("input[autocomplete=username]")', 'App did not start')
    const tasks = await js('(async()=>{ const a=await window.api.todoCreate({title:"詳細テストA",start_date:"2026-10-09",due_date:"2026-10-20"}); const b=await window.api.todoCreate({title:"詳細テストB",start_date:"2026-10-09",due_date:"2026-10-20"});const ca=await window.api.subtaskCreate(a.id,{title:"Aだけの子",progress:0});const cb=await window.api.subtaskCreate(b.id,{title:"Bだけの子",progress:0}); window.tasks={a,b,ca,cb,currentTitle:b.title};return window.tasks; })()')
    await js('window.originalFetch=window.fetch; window.unhandled=[]; window.addEventListener("unhandledrejection",event=>{window.unhandled.push(String(event.reason));event.preventDefault()});')

    // A's older subsection response must never appear under B.
    await js('window.held=[];window.fetch=async (...args)=>{const response=await window.originalFetch(...args);if(String(args[0]).endsWith("/todos/"+window.tasks.a.id+"/subtasks")){return await new Promise(resolve=>window.held.push(()=>resolve(response)));}return response;};void 0;')
    navigate(tasks.a.id)
    await until('window.held.length>0 && Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="詳細テストA")', 'A request was not held')
    await currentTask(tasks.b.id, tasks.b.title)
    await until('document.body.innerText.includes("Bだけの子")', 'B child did not load')
    await js('window.held.splice(0).forEach(release=>release());void(window.fetch=window.originalFetch)')
    await delay(250)
    assert.equal(await js('document.body.innerText.includes("Aだけの子")'), false, 'Old A response contaminated B')
    assert.equal(await js('document.body.innerText.includes("Bだけの子")'), true)
    assert.equal(Boolean((await js('window.api.subtaskGetByTodo(window.tasks.a.id)'))[0].done), false)

    // A newer response for the same task must win over a held old subsection.
    await js('window.held=[];window.holdNextSubtask=true;window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(window.holdNextSubtask&&String(args[0]).endsWith("/todos/"+window.tasks.a.id+"/subtasks")){window.holdNextSubtask=false;return new Promise(resolve=>window.held.push(()=>resolve(response)));}return response;};void 0;')
    navigate(tasks.a.id)
    await until('window.held.length>0', 'Old same-task child snapshot was not held')
    await js('window.api.subtaskCreate(window.tasks.a.id,{title:"同じタスクの新しい子"})')
    await until('document.body.innerText.includes("同じタスクの新しい子")', 'New child snapshot did not arrive')
    await js('window.held.splice(0).forEach(release=>release());void(window.fetch=window.originalFetch)')
    await delay(150)
    assert.equal(await js('document.body.innerText.includes("同じタスクの新しい子")'), true, 'Old same-task response replaced a newer subsection')
    await currentTask(tasks.b.id, tasks.b.title)

    // Preserve a second member's unrelated changes during a title-only edit.
    await editTitle('詳細テストB改')
    await js('window.api.userCreate(' + JSON.stringify({ username: 'detail_member', password: fixture.password, display_name: '別のメンバー', role: 'member' }) + ')')
    const login = await fetch(fixture.origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'detail_member', password: fixture.password }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    async function otherUpdate(id, data) {
      const response = await fetch(fixture.origin + '/api/todos/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(data) })
      assert.equal(response.status, 200, await response.text())
    }
    await otherUpdate(tasks.b.id, { status: 'on_hold', priority: 1 })
    await delay(250)
    await click('保存')
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="詳細テストB改")', 'Title save did not finish')
    let persisted = (await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.b.id)
    assert.equal(persisted.title, '詳細テストB改')
    assert.equal(persisted.status, 'on_hold')
    assert.equal(persisted.priority, 1)
    await js('window.tasks.currentTitle="詳細テストB改"')

    // A single-child title edit cannot reset the member's concurrent progress/description.
    await js('Array.from(document.querySelectorAll("button")).find(e=>e.title==="編集").click()')
    await until('Array.from(document.querySelectorAll("input")).some(e=>e.value==="Bだけの子")', 'Child editor did not open')
    await js('(function(){const input=Array.from(document.querySelectorAll("input")).find(e=>e.value==="Bだけの子");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"Bだけの子改");input.dispatchEvent(new Event("input",{bubbles:true}));})()')
    const childResponse = await fetch(fixture.origin + '/api/subtasks/' + tasks.cb.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ progress: 40, description: '別メンバーの子の説明' }) })
    assert.equal(childResponse.status, 200, await childResponse.text())
    await delay(150)
    await click('保存')
    await until('document.body.innerText.includes("Bだけの子改") && !document.body.innerText.includes("キャンセル")', 'Child title did not save')
    const persistedChild = (await js('window.api.subtaskGetByTodo(window.tasks.b.id)')).find(child => child.id === tasks.cb.id)
    assert.equal(persistedChild.progress, 40)
    assert.equal(persistedChild.description, '別メンバーの子の説明')

    // Leaving a detail mid-drag must remove its global mouseup handlers.
    await js('window.api.todoUpdate(window.tasks.a.id,{progress:35})')
    await currentTask(tasks.a.id, tasks.a.title)
    await js('(function(){const bar=Array.from(document.querySelectorAll("div")).find(e=>e.style.height==="10px"&&e.style.cursor==="ew-resize");const rect=bar.getBoundingClientRect();bar.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,clientX:rect.left+rect.width*0.7}));})()')
    await currentTask(tasks.b.id, '詳細テストB改')
    await js('window.dispatchEvent(new MouseEvent("mouseup",{clientX:0}));void 0;')
    await delay(150)
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.a.id).progress, 35, 'Unmounted main progress drag still changed the previous task')
    await js('(function(){const bar=Array.from(document.querySelectorAll("div")).find(e=>e.style.height==="7px"&&e.title==="ドラッグで進捗を変更");const rect=bar.getBoundingClientRect();bar.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,clientX:rect.left+rect.width*0.8}));})()')
    await currentTask(tasks.a.id, tasks.a.title)
    await js('window.dispatchEvent(new MouseEvent("mouseup",{clientX:0}));void 0;')
    await delay(150)
    assert.equal((await js('window.api.subtaskGetByTodo(window.tasks.b.id)')).find(child => child.id === tasks.cb.id).progress, 40, 'Unmounted child progress drag still changed the previous task')
    await currentTask(tasks.b.id, '詳細テストB改')

    // App's older global snapshot cannot reverse a newer member update.
    await js('window.held=[];window.holdNextTodos=true;window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(window.holdNextTodos&&String(args[0])==="/api/todos"&&(!args[1]?.method||args[1]?.method==="GET")){window.holdNextTodos=false;return new Promise(resolve=>window.held.push(()=>resolve(response)));}return response;};void 0;')
    await js('window.api.todoUpdate(window.tasks.a.id,{memo:"古い取得を開始"})')
    await until('window.held.length>0', 'Global old snapshot was not held')
    await otherUpdate(tasks.a.id, { title: '詳細テストA最新' })
    await currentTask(tasks.a.id, '詳細テストA最新')
    await js('window.held.splice(0).forEach(release=>release());void(window.fetch=window.originalFetch)')
    await delay(150)
    assert.equal(await js('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="詳細テストA最新")'), true, 'Old global todo snapshot reversed the member update')
    tasks.a.title = '詳細テストA最新'
    await js('window.tasks.a.title="詳細テストA最新"')

    // A subscription GET issued before the toggle cannot reverse the completed POST.
    await currentTask(tasks.b.id, '詳細テストB改')
    await js('window.held=[];window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(String(args[0]).endsWith("/todos/"+window.tasks.a.id+"/subscription")&&(!args[1]?.method||args[1]?.method==="GET"))return new Promise(resolve=>window.held.push(()=>resolve(response)));return response;};void 0;')
    await currentTask(tasks.a.id, tasks.a.title)
    await until('window.held.length>0', 'Subscription GET was not held')
    await click('更新通知を受け取る')
    await until('Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="更新通知オン")', 'Subscription POST did not update UI')
    await js('window.held.splice(0).forEach(release=>release());void(window.fetch=window.originalFetch)')
    await delay(150)
    assert.equal(await js('Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="更新通知オン")'), true, 'Old GET reset the subscription toggle')
    await currentTask(tasks.b.id, '詳細テストB改')
    await js('window.tasks.currentTitle="詳細テストB改"')

    // A genuine same-field conflict retains the draft and the remote value.
    await editTitle('手元の競合下書き')
    await otherUpdate(tasks.b.id, { title: '別メンバーの変更' })
    await delay(250)
    await click('保存')
    await until('Array.from(document.querySelectorAll("[role=alert]")).some(e=>e.textContent.includes("変更されています"))', 'Conflict was not shown')
    assert.equal(await js('Array.from(document.querySelectorAll("input")).some(e=>e.value==="手元の競合下書き")'), true)
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.b.id).title, '別メンバーの変更')

    // Native commands obey the current unsaved confirmation.
    await js('window.confirmCount=0;window.confirm=()=>{window.confirmCount++;return false};void 0;')
    navigate(tasks.a.id)
    await delay(250)
    assert.equal(await js('window.confirmCount'), 1)
    assert.equal(await js('Array.from(document.querySelectorAll("input")).some(e=>e.value==="手元の競合下書き")'), true)
    await js('void(window.confirm=()=>true);')
    await currentTask(tasks.a.id, tasks.a.title)

    // A 400 keeps the draft, gives a retry cue, and is not unhandled.
    await editTitle('失敗しても残すA')
    await js('window.putCount=0;window.fetch=(...args)=>{if(String(args[0]).endsWith("/todos/"+window.tasks.a.id)&&args[1]?.method==="PUT"){window.putCount++;return Promise.resolve(new Response(JSON.stringify({error:"テスト:保存を拒否しました"}),{status:400,headers:{"Content-Type":"application/json"}}));}return window.originalFetch(...args)};void 0;')
    await click('保存')
    await until('Array.from(document.querySelectorAll("[role=alert]")).some(e=>e.textContent.includes("テスト:保存を拒否しました"))', 'Save failure was not visible')
    assert.equal(await js('Array.from(document.querySelectorAll("input")).some(e=>e.value==="失敗しても残すA")'), true)
    assert.equal(await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="保存").disabled'), false)
    assert.deepEqual(await js('window.unhandled'), [])
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.a.id).title, tasks.a.title)

    // Repeated clicks while the real request is held issue one PUT only.
    await js('window.putCount=0;window.releasePut=null;window.fetch=async(...args)=>{if(String(args[0]).endsWith("/todos/"+window.tasks.a.id)&&args[1]?.method==="PUT"){window.putCount++;await new Promise(resolve=>window.releasePut=resolve);}return window.originalFetch(...args)};void 0;')
    await click('保存')
    await until('window.releasePut !== null', 'PUT was not held')
    await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="保存中…").click()')
    assert.equal(await js('window.putCount'), 1)
    assert.equal(await js('Array.from(document.querySelectorAll("input")).find(e=>e.value==="失敗しても残すA").disabled'), true)
    await js('window.releasePut();void(window.fetch=window.originalFetch)')
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="失敗しても残すA")', 'Retry did not persist')

    // If the child fails after the parent saves, retry must save only the child.
    await js('window.tasks.currentTitle="失敗しても残すA"')
    await click('編集')
    await until('document.body.innerText.includes("閉じる")', 'Full editor did not reopen')
    await js('(function(){const priority=Array.from(document.querySelectorAll("select")).find(e=>Array.from(e.options).some(o=>o.textContent==="最低"));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(priority,"4");priority.dispatchEvent(new Event("change",{bubbles:true}));const child=Array.from(document.querySelectorAll("input")).find(e=>e.value==="Aだけの子");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(child,"Aの保存途中の子");child.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await js('window.parentWrites=0;window.rejectChild=true;window.fetch=(...args)=>{if(args[1]?.method==="PUT"&&String(args[0]).endsWith("/todos/"+window.tasks.a.id))window.parentWrites++;if(window.rejectChild&&args[1]?.method==="PUT"&&String(args[0]).endsWith("/subtasks/"+window.tasks.ca.id))return Promise.resolve(new Response(JSON.stringify({error:"子の保存失敗"}),{status:400,headers:{"Content-Type":"application/json"}}));return window.originalFetch(...args)};void 0;')
    await delay(100)
    await click('保存')
    await until('Array.from(document.querySelectorAll("[role=alert]")).some(e=>e.textContent.includes("子の保存失敗")&&e.textContent.includes("タスクの変更は保存済み"))', 'Partial save was not explained')
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.a.id).priority, 4)
    assert.equal((await js('window.api.subtaskGetByTodo(window.tasks.a.id)')).find(child => child.id === tasks.ca.id).title, 'Aだけの子')
    await js('window.rejectChild=false')
    await click('保存')
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="失敗しても残すA")', 'Partial-save retry did not finish')
    assert.equal(await js('window.parentWrites'), 1, 'Retry repeated the already committed task update')
    assert.equal((await js('window.api.subtaskGetByTodo(window.tasks.a.id)')).find(child => child.id === tasks.ca.id).title, 'Aの保存途中の子')
    await js('void(window.fetch=window.originalFetch)')

    // Same-ID navigation from a Gantt side editor changes the mounted detail too.
    await click('ガント')
    await until('Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="詳細")', 'Gantt side tabs did not render')
    await click('詳細')
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="失敗しても残すA")', 'Gantt side detail did not open')
    await js('window.tasks.currentTitle="失敗しても残すA"')
    await editTitle('ガントの未保存下書き')
    await js('window.confirmCount=0;window.confirm=()=>{window.confirmCount++;return false};void 0;')
    navigate(tasks.a.id)
    await delay(250)
    assert.equal(await js('window.confirmCount'), 1, 'Same-ID Gantt navigation skipped dirty confirmation')
    assert.equal(await js('Array.from(document.querySelectorAll("input")).some(e=>e.value==="ガントの未保存下書き")'), true)

    // Inline description/memo keep their edit-start expected value across realtime updates.
    await js('void(window.confirm=()=>true)')
    navigate(tasks.a.id)
    await until('Array.from(document.querySelectorAll("h2")).some(e=>e.textContent==="失敗しても残すA")', 'Could not leave the Gantt editor')
    await js('(function(){const description=document.querySelector("textarea[placeholder=\'タスクの説明を入力...\']");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(description,"手元の説明");description.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await otherUpdate(tasks.a.id, { description: '別メンバーの説明' })
    await delay(150)
    await click('説明を保存')
    await until('document.body.innerText.includes("「説明」が変更されています")', 'Inline description conflict was not shown')
    assert.equal(await js('document.querySelector("textarea[placeholder=\'タスクの説明を入力...\']").value'), '手元の説明')
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.a.id).description, '別メンバーの説明')
    await js('(function(){const memo=document.querySelector("textarea[placeholder=\'進捗メモ、引き継ぎ、次にやることなど...\']");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(memo,"手元のメモ");memo.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await otherUpdate(tasks.a.id, { memo: '別メンバーのメモ' })
    await delay(150)
    await click('メモを保存')
    await until('document.body.innerText.includes("「メモ」が変更されています")', 'Inline memo conflict was not shown')
    assert.equal((await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.a.id).memo, '別メンバーのメモ')

    // A failed timer stop keeps its memo, reports the failure and allows one retry.
    await js('window.api.todoUpdate(window.tasks.b.id,{status:"active"})')
    const timerTitle = (await js('window.api.todoGetAll()')).find(todo => todo.id === tasks.b.id).title
    await currentTask(tasks.b.id, timerTitle)
    await click('開始')
    await until('Boolean(document.querySelector("input[placeholder=停止メモ]"))', 'Timer did not start')
    await js('(function(){const input=document.querySelector("input[placeholder=停止メモ]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"失敗しても残す停止メモ");input.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await delay(75)
    await js('window.stopRequests=0;window.fetch=async(...args)=>{if(String(args[0])==="/api/timer/stop"){window.stopRequests++;await new Promise(resolve=>setTimeout(resolve,100));return new Response(JSON.stringify({error:"停止テスト失敗"}),{status:500,headers:{"Content-Type":"application/json"}});}return window.originalFetch(...args);};const stop=Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="停止");stop.click();stop.click();void 0;')
    await until('document.body.innerText.includes("停止テスト失敗")', 'Stop failure was not shown')
    assert.equal(await js('window.stopRequests'), 1, 'Pending stop can be submitted only once')
    assert.equal(await js('document.querySelector("input[placeholder=停止メモ]").value'), '失敗しても残す停止メモ')
    assert.equal((await js('window.api.timerGetRunning()')).todo_id, tasks.b.id)
    await js('void(window.fetch=window.originalFetch)')
    await click('停止')
    await until('!document.querySelector("input[placeholder=停止メモ]")', 'Timer stop retry did not finish')
    const timerLogs = await js('window.api.worklogGetByTodo(window.tasks.b.id)')
    assert.equal(timerLogs.length, 1)
    assert.equal(timerLogs[0].note, '失敗しても残す停止メモ')

    // Background category/plan refresh failures must be visible and handled too.
    await js('window.fetch=async(...args)=>{if(String(args[0])==="/api/categories"&&args[1]?.method==="GET")return new Response(JSON.stringify({error:"カテゴリ同期テスト失敗"}),{status:500,headers:{"Content-Type":"application/json"}});return window.originalFetch(...args);};void 0;')
    await js('window.api.categoryCreate("同期失敗テスト","#6366f1",false)')
    await until('document.body.innerText.includes("カテゴリ同期テスト失敗")', 'Category background failure was not shown')
    await js('window.fetch=async(...args)=>{if(String(args[0]).startsWith("/api/plan?")&&args[1]?.method==="GET")return new Response(JSON.stringify({error:"計画同期テスト失敗"}),{status:500,headers:{"Content-Type":"application/json"}});return window.originalFetch(...args);};void 0;')
    await js('window.api.dailyPlanAdd("2026-10-09",window.tasks.b.id)')
    await until('document.body.innerText.includes("計画同期テスト失敗")', 'Plan background failure was not shown')
    await js('void(window.fetch=window.originalFetch)')

    // Notifications also obey the unsaved-detail confirmation before opening progress.
    await editTitle('通知から移動しても残す下書き')
    await js('window.originalNotificationList=window.api.notificationList;window.originalUnread=window.api.notificationUnreadCount;window.api.notificationList=async()=>[{id:"dirty-notification",user_id:"fixture",type:"mention",actor_user_id:null,actor_name:null,actor_color:null,todo_id:window.tasks.a.id,todo_title:window.tasks.a.title,progress_note_id:"fixture-note",progress_comment_id:null,title:"未保存確認テスト通知",body:"進捗へ移動",created_at:"2026-10-09T03:00:00Z",read_at:"2026-10-09T03:00:01Z"}];window.api.notificationUnreadCount=async()=>0;window.confirmCount=0;window.confirm=()=>{window.confirmCount++;return false};Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim().startsWith("通知")&&!e.textContent.includes("設定")).click();void 0;')
    await until('Boolean(document.querySelector("section[aria-labelledby=notification-title]"))', 'Notification panel did not open')
    await js('Array.from(document.querySelectorAll("section[aria-labelledby=notification-title] button")).find(e=>e.textContent==="すべて").click();void 0;')
    await until('document.body.innerText.includes("未保存確認テスト通知")', 'Controlled notification did not load')
    await js('Array.from(document.querySelectorAll("section[aria-labelledby=notification-title] button")).find(e=>e.textContent.includes("未保存確認テスト通知")).click();void 0;')
    await until('window.confirmCount===1', 'Notification skipped dirty confirmation')
    assert.equal(await js('Array.from(document.querySelectorAll("input")).some(e=>e.value==="通知から移動しても残す下書き")'), true)
    await js('window.api.notificationList=window.originalNotificationList;window.api.notificationUnreadCount=window.originalUnread;Array.from(document.querySelectorAll("section[aria-labelledby=notification-title] button")).find(e=>e.textContent==="閉じる").click();void 0;')
    assert.deepEqual(await js('window.unhandled'), [])
    console.log('HAKOBI detail Electron checks passed: target/same-task/global response ordering, subscription ordering, concurrent member edits, inline conflicts, native dirty navigation, drag cleanup, failed/partial save, stop retry and background sync failures')
    main.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error.stack || error.message)
    if (main && !main.isDestroyed()) main.destroy()
    app.exit(1)
  }
}

async function runHost() {
  const { pathToFileURL } = require('node:url')
  const net = require('node:net')
  const modulesDir = path.join(root, 'node_modules')
  const temporaryDir = fs.mkdtempSync(path.join(modulesDir, '.hakobi-detail-test-'))
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
    assert.ok(cleanOutput.includes('HAKOBI detail Electron checks passed:'), 'Fixture did not reach its assertions')
  } finally {
    await stop(electron)
    await stop(server)
    assert.equal(path.dirname(path.resolve(temporaryDir)), path.resolve(modulesDir))
    assert.ok(path.basename(temporaryDir).startsWith('.hakobi-detail-test-'))
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
}
if (process.versions.electron) void runElectron()
else runHost().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
