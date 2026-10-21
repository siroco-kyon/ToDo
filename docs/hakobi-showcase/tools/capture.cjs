// Capture the actual shared React app against a disposable local server and DB.
// No production server, user DB, installed application, or dist-web is modified.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '../../..')
const output = path.resolve(__dirname, '../assets')
const delay = ms => new Promise(r => setTimeout(r, ms))

async function electronMain() {
  const { app, BrowserWindow } = require('electron')
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  app.setPath('userData', path.join(fixture.temp, 'electron-data'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code)
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(100) }
    throw new Error('UI did not settle: ' + expression)
  }
  async function open(view, task) {
    await win.loadURL(fixture.origin + '/?view=' + view + (task ? '&task=' + task : ''))
    await until('Boolean(window.api && document.querySelector("main")?.textContent.trim())')
    await delay(1400)
  }
  async function shot(name) {
    await delay(600)
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(path.join(fixture.temp, name + '.txt'), await js('document.body.innerText'))
    console.log('Captured ' + name)
  }
  await win.loadURL(fixture.origin)
  await js(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: 'demo_leader', password: 'showcase-local-demo-only' })})}).then(r=>{if(!r.ok)throw new Error('Demo login failed')})`)
  await open('gantt')
  await js(`(async()=>{
    const api=window.api, me=await api.authGetCurrentUser();
    await api.userUpdate(me.id,{display_name:'高橋',color:'#7c3aed'});
    const sato=await api.userCreate({username:'demo_sato',display_name:'佐藤',password:'showcase-local-demo-only',color:'#2563eb'});
    const suzuki=await api.userCreate({username:'demo_suzuki',display_name:'鈴木',password:'showcase-local-demo-only',color:'#0f766e'});
    const cat=await api.categoryCreate('業務の見直し','#2563eb',false);
    const task=await api.todoCreate({title:'月次集計の見直し',description:'部署ごとに異なる集計項目をそろえ、月次集計の手戻りを減らす。',memo:'入力フォームの試作ができました。集計項目の違いを定例で相談します。',category_id:cat.id,assignee_id:sato.id,status:'active',progress:50,start_date:'2026-10-15',due_date:'2026-10-30'});
    const a=await api.subtaskCreate(task.id,{title:'集計項目を確認する',assignee_id:sato.id,start_date:'2026-10-15',due_date:'2026-10-19',progress:100});
    await api.subtaskUpdate(a.id,{done:true,progress:100});
    await api.subtaskCreate(task.id,{title:'入力フォームを試作する',assignee_id:suzuki.id,start_date:'2026-10-20',due_date:'2026-10-26',progress:50});
    await api.subtaskCreate(task.id,{title:'関係部署と内容を確かめる',assignee_id:sato.id,start_date:'2026-10-27',due_date:'2026-10-30'});
    await api.todoCreate({title:'来月の説明会の準備',category_id:cat.id,assignee_id:suzuki.id,status:'active',progress:30,start_date:'2026-10-20',due_date:'2026-10-29',memo:'説明資料を作成中です。'});
    await api.todoCreate({title:'申請手順を確認する',category_id:cat.id,assignee_id:me.id,status:'on_hold',start_date:'2026-10-14',due_date:'2026-10-23',memo:'関係先からの回答待ちです。'});
    await api.todoCreate({title:'毎月の点検結果をまとめる',category_id:cat.id,assignee_id:suzuki.id,status:'not_started',start_date:'2026-10-26',due_date:'2026-10-30',recurrence:'monthly'});
    window.demo={task:task.id,sato:sato.id,suzuki:suzuki.id};
    await api.settingsSet('themeMode','light'); await api.settingsSet('fontScale','120%');
    localStorage.setItem('app-theme-mode','light');localStorage.setItem('app-font-scale','120%');
    localStorage.setItem('hakobi-list-assignee:'+me.id,'__all__');
    localStorage.setItem('hakobi-getting-started:'+me.id,'1');
    localStorage.setItem('gantt-view-settings',JSON.stringify({zoom:'detail',timeScale:'day'}));
  })()`)
  const demo = await js('window.demo')
  // The note is written by the task's assignee; the reply is written by the leader.
  await js(`fetch('/api/auth/logout',{method:'POST'}).then(()=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo_sato',password:'showcase-local-demo-only'})})).then(r=>{if(!r.ok)throw new Error('Assignee login')})`)
  await open('progress')
  const note = await js(`window.api.progressNoteCreate(${JSON.stringify(demo.task)},'入力フォームの試作ができました。部署ごとに集計項目が違うため、どこまでそろえるか相談したいです。@高橋')`)
  await js(`window.api.progressNoteSetNeedsDiscussion(${JSON.stringify(note.id)},true)`)
  await js(`fetch('/api/auth/logout',{method:'POST'}).then(()=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo_leader',password:'showcase-local-demo-only'})}))`)
  await open('progress')
  await js(`window.api.progressNoteCommentCreate(${JSON.stringify(note.id)},'明日の定例で確認しましょう。そろえる項目と、部署ごとに残す項目を一緒に決めたいです。')`)
  await js(`window.api.progressNoteReactionToggle(${JSON.stringify(note.id)},'👀')`)
  await open('gantt'); await shot('gantt')
  await open('team'); await shot('team')
  await open('detail', demo.task); await shot('detail')
  await open('progress'); await shot('progress')
  await open('report'); await shot('report')
  await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('変える'));if(b)b.click()})()`)
  await shot('report-settings')
  await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('定例モード'));if(!b)throw new Error('Meeting button');b.click()})()`)
  await until('Boolean(document.querySelector("[aria-label=定例モード]"))')
  await js(`(()=>{const input=document.querySelector('input[aria-label="決まったこと（タスク名）"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'部署別に残す項目を確認する');input.dispatchEvent(new Event('input',{bubbles:true}));const b=[...document.querySelectorAll('[aria-label=定例モード] button')].find(b=>b.textContent.startsWith('今週金曜'));if(b)b.click()})()`)
  await delay(150)
  await js(`(()=>{const b=[...document.querySelectorAll('[aria-label=定例モード] button')].find(b=>b.textContent==='追加');if(!b||b.disabled)throw new Error('Demo action unavailable');b.click()})()`)
  await until(`document.querySelector('[aria-label=定例モード]').textContent.includes('部署別に残す項目を確認する')`)
  await js(`(()=>{const input=document.querySelector('textarea[aria-label="佐藤の定例メモ"]');if(!input)throw new Error('Demo group changed');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'共通項目をそろえる方針。佐藤さんが部署別に残す項目を金曜までに確認する。');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await shot('meeting')
  await open('gantt'); await shot('gantt-after-meeting')
  await open('report')
  await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('変える'));if(b)b.click()})()`)
  await shot('report-settings-after')
  await open('gantt')
  await js(`document.querySelector('button[aria-label="タスクを追加"]').click()`)
  await until('Boolean(document.getElementById("quick-add-input"))')
  await js(`(()=>{const input=document.getElementById('quick-add-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'月次集計の見直し');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await shot('quickadd')
  fs.writeFileSync(path.join(output,'capture-info.json'),JSON.stringify({ date:'2026-10-21',viewport:[1440,960],theme:'light',fontScale:'120%',fictional:true,sourceCommit:fixture.commit },null,2)+'\n')
  win.destroy(); app.exit(0)
}

async function hostMain() {
  const os = require('node:os'), net = require('node:net')
  const { pathToFileURL } = require('node:url')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-showcase-'))
  fs.mkdirSync(output,{recursive:true})
  fs.writeFileSync(path.join(temp,'empty.env'),'')
  const web = path.join(temp,'web')
  const run = (cmd,args,opts={})=>new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd:root,windowsHide:true,stdio:'inherit',...opts});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(cmd+' exited '+code)))
  })
  await run(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config','vite.web.config.ts','--outDir',web])
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  const server=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'server/node_modules/tsx/dist/loader.mjs')).href,path.join(root,'server/src/index.ts')],{
    cwd:path.join(root,'server'),windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,TODO_ENV_FILE:path.join(temp,'empty.env'),PORT:String(port),TODO_DATA_DIR:path.join(temp,'db'),TODO_WEB_DIST:web,ADMIN_USERNAME:'demo_leader',ADMIN_PASSWORD:'showcase-local-demo-only',SESSION_COOKIE:'showcase_session',TODO_BACKUP_KEEP:'0'}
  })
  const log=fs.createWriteStream(path.join(temp,'server.log'));server.stdout.pipe(log);server.stderr.pipe(log)
  try{
    const origin='http://127.0.0.1:'+port
    let ready=false
    for(let i=0;i<150;i++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break}}catch{}await delay(100)}
    if(!ready)throw new Error('Disposable server did not start; see '+temp)
    const commit=require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
    const fixture=path.join(temp,'fixture.json');fs.writeFileSync(fixture,JSON.stringify({origin,temp,commit}))
    await run(require(path.join(root,'node_modules/electron')), [__filename,fixture])
    console.log('Disposable capture complete. Scratch files: '+temp)
  }finally{server.kill();log.end()}
}

if(process.versions.electron)electronMain().catch(e=>{console.error(e);require('electron').app.exit(1)})
else hostMain().catch(e=>{console.error(e);process.exitCode=1})
