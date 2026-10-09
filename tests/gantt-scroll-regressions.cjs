// Exercise the shared Gantt in an actual hidden Chromium renderer; no user DB or server is touched.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
const parent = path.join(root, 'node_modules')
const temporary = fs.mkdtempSync(path.join(parent, '.gantt-scroll-test-'))
let child

async function main() {
  await build({
    stdin: { contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import { GanttView } from './src/renderer/src/components/GanttView'
      const RealDate = Date
      window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-09T03:00:00Z'])) } static now() { return RealDate.parse('2026-10-09T03:00:00Z') } }
      const makeTodo = (id, title, start_date, due_date, sort_order) => ({id,title,start_date,due_date,sort_order,
        description:'',memo:'',category_id:null,category_name:null,category_color:null,assignee_id:null,
        assignee_name:null,assignee_color:null,status:'active',priority:0,progress:0,recurrence:null,
        recurrence_copy_subtasks:0,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'})
      window.rows = [makeTodo('A','バー検査','2026-01-01','2027-12-31',0), makeTodo('B','他の予定','2026-10-01','2026-10-10',1)]
      window.listeners = new Set(); window.updates = []; window.held = []; window.holdSubtasks = false
      window.api = { subtaskGetAll: () => window.holdSubtasks ? new Promise(resolve => window.held.push(resolve)) : Promise.resolve([]),
        todoDependencyGetAll: async () => [], progressNoteGetByRange: async () => [],
        progressNoteGetOpenDiscussions: async () => [], progressNoteGetLastActivity: async () => [],
        todoGetAll: async () => window.rows,
        onDataChanged: (callback) => { window.listeners.add(callback); return () => window.listeners.delete(callback) } }
      window.unhandled = []; window.addEventListener('unhandledrejection', event => { window.unhandled.push(String(event.reason)); event.preventDefault() })
      let activeRoot
      function Probe() {
        const [rows, setRows] = useState(window.rows)
        window.update = (id, data, notify = false) => {
          window.rows = window.rows.map(todo => todo.id === id ? {...todo,...data} : todo)
          window.updates.push({id,data}); flushSync(() => setRows(window.rows))
          if (notify) for (const callback of window.listeners) callback('todo')
        }
        return <GanttView todos={rows} categories={[]} onSelectTodo={() => {}}
          onUpdateTodo={async (id,data) => window.update(id,data,true)}/>
      }
      window.mount = (snapshot) => {
        window.localStorage.setItem('gantt-view-settings', JSON.stringify({zoom:'detail',timeScale:'day',statusFilter:'all',rangeMode:'auto'}))
        if (snapshot === null) window.localStorage.removeItem('gantt-scroll-state')
        else if (snapshot) window.localStorage.setItem('gantt-scroll-state',JSON.stringify(snapshot))
        activeRoot = createRoot(document.getElementById('root')); flushSync(() => activeRoot.render(<React.StrictMode><Probe/></React.StrictMode>))
      }
      window.unmount = () => flushSync(() => activeRoot.unmount())
      window.chart = () => Array.from(document.querySelectorAll('div')).find(e => e.style.overflow === 'auto' && e.style.height === '100%' && !e.classList.contains('tarbo-gantt'))
      window.snapshot = () => JSON.parse(window.localStorage.getItem('gantt-scroll-state'))
      window.scrollChart = (left) => { const e=window.chart(); e.scrollLeft=left; e.dispatchEvent(new Event('scroll')); }
      window.click = text => { const e=Array.from(document.querySelectorAll('button')).find(e=>e.textContent===text); if(!e) throw new Error('Missing button '+text);e.click() }
      window.flush = () => flushSync(() => {})
      window.resizeBar = (edge, delta) => {
        const bar=Array.from(document.querySelectorAll('div')).find(e=>e.title.includes('バー検査')&&e.style.cursor==='grab')
        if (!bar) throw new Error('Missing task bar')
        const handles=Array.from(bar.querySelectorAll('div')).filter(e=>e.style.cursor==='ew-resize')
        const handle=handles[edge==='start'?0:handles.length-1]
        handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:100}))
        window.pendingDelta=delta
      }
    `, resolveDir: root, loader: 'tsx' },
    outfile: path.join(temporary, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' }
  })
  fs.writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>')
  const runner = path.join(temporary, 'run.cjs')
  fs.writeFileSync(runner, `
    const assert = require('node:assert/strict')
    const path = require('node:path')
    const { app, BrowserWindow } = require('electron')
    const temporary = ${JSON.stringify(temporary)}
    app.setPath('userData',path.join(temporary,'user-data'))
    app.commandLine.appendSwitch('disable-gpu'); app.on('window-all-closed',()=>{})
    let win
    const js = code => win.webContents.executeJavaScript(code)
    const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
    const settle = async () => { await delay(80);await js('window.flush()');await delay(80) }
    const until = async (expression, label) => {
      const deadline=Date.now()+8000
      while (!await js(expression)) { if(Date.now()>deadline) throw new Error(label+': '+await js('document.body.innerText'));await delay(30) }
    }
    const snapshot = () => js('window.snapshot()')
    const click = async text => { await js('window.click('+JSON.stringify(text)+')');await settle() }
    async function drag(edge, days) {
      const width=(await snapshot()).unitWidth
      const before=await js('window.updates.length')
      await js('window.resizeBar('+JSON.stringify(edge)+','+days*width+')');await settle()
      await js('window.dispatchEvent(new PointerEvent("pointermove",{clientX:100+window.pendingDelta}));window.flush()');await settle()
      await js('window.dispatchEvent(new PointerEvent("pointerup",{clientX:100+window.pendingDelta}))')
      await until('window.updates.length>'+before,'Task bar resize did not commit');await settle()
    }
    async function run() {
      await app.whenReady()
      win=new BrowserWindow({show:false,width:1150,height:850,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}})
      win.webContents.on('console-message',(_event,level,message)=>{ if(level>=3) console.error(message) })
      await win.loadFile(path.join(temporary,'index.html'));await js('window.mount(null)')
      await until('Boolean(window.chart())&&window.snapshot()?.unitWidth','Gantt did not load');await settle()
      const initial=await snapshot()
      assert.ok(initial.leftDate>='2026-09-20'&&initial.leftDate<='2026-10-09','Initial view opens around today')
      await js('window.scrollChart(410*window.snapshot().unitWidth+11);void(window.originalChart=window.chart())');await settle()
      const future=await snapshot()
      assert.ok(future.leftDate>'2027-01-01','Fixture must view a future date away from today: '+JSON.stringify(future)+' geometry '+await js('JSON.stringify({left:window.chart().scrollLeft,width:window.chart().scrollWidth,client:window.chart().clientWidth})'))
      await drag('end',5)
      assert.equal((await snapshot()).leftDate,future.leftDate,'Extending the final task cannot return to today')
      assert.equal((await snapshot()).scrollLeft,future.scrollLeft,'Extending right range preserves horizontal offset')
      assert.equal(await js('window.chart()===window.originalChart'),true,'Task updates retain the same scroll container')
      await drag('start',-14)
      const afterStart=await snapshot()
      assert.equal(afterStart.leftDate,future.leftDate,'Extending the first task preserves the viewed date')
      assert.equal(afterStart.scrollLeft,future.scrollLeft+14*future.unitWidth,'Start range change compensates by its day offset')

      // Hold a realtime refresh to verify there is no unmount/reset while it is pending.
      await js('window.holdSubtasks=true;for(const callback of window.listeners)callback("todo")');await settle()
      assert.equal(await js('window.chart()===window.originalChart'),true,'Pending realtime refresh retains the chart')
      assert.equal((await snapshot()).leftDate,future.leftDate)
      await js('window.holdSubtasks=false;window.held.splice(0).forEach(resolve=>resolve([]))');await settle()

      win.setContentSize(1300,850);await settle()
      assert.equal((await snapshot()).leftDate,future.leftDate,'Window stretching cannot return to today')
      await click('表示設定を開く');await click('コンパクト')
      assert.equal((await snapshot()).leftDate,future.leftDate,'Zoom preserves the viewed date')
      const scaled=await snapshot()
      assert.ok(Math.abs(scaled.leftOffset/scaled.unitWidth-future.leftOffset/future.unitWidth)<0.04,'Zoom retains the position within the day')
      await click('週')
      const week=await snapshot()
      assert.ok(week.leftDate<='2027-03-01'&&week.leftDate>'2027-01-01','Changing the display unit stays near the future viewport')
      await click('日')
      const day=await snapshot()
      assert.ok(Math.abs(Date.parse(day.leftDate)-Date.parse(future.leftDate))<=86400000,'Changing units back retains the future date')
      await click('今日に戻る');await delay(600)
      const today=await snapshot()
      assert.ok(today.leftDate<='2026-10-09'&&today.leftDate>='2026-09-01','Explicit today button still jumps to today')

      // A custom range excluding today must expand and then honor the explicit jump.
      await js('window.click("カスタム")');await settle()
      await js('Array.from(document.querySelectorAll("input[type=date]")).forEach((input,index)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,index?"2027-08-31":"2027-01-01");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));})');await settle()
      assert.ok((await snapshot()).leftDate>='2027-01-01')
      await click('今日に戻る');await delay(600)
      assert.ok((await snapshot()).leftDate<='2026-10-09','Today outside the range is restored by explicit request')

      const stored={timeScale:'day',leftDate:'2027-03-12',leftOffset:11,scrollLeft:0,scrollTop:0,unitWidth:96}
      await js('window.unmount();window.mount('+JSON.stringify(stored)+')')
      await until('Boolean(window.chart())&&window.snapshot()?.leftDate==="2027-03-12"','Saved viewport was not restored')
      assert.equal((await snapshot()).leftDate,stored.leftDate,'Reopening restores saved dates')
      await js('window.unmount();window.mount('+JSON.stringify({...stored,unitWidth:undefined})+')')
      await until('Boolean(window.chart())&&window.snapshot()?.leftDate==="2027-03-12"','Legacy saved viewport was not restored')
      assert.deepEqual(await js('window.unhandled'),[])
      await js('window.unmount()')
      console.log('Gantt scroll regressions passed: real bar resize, range shifts, refresh, window resize, zoom, display units, explicit today and saved viewport')
      win.destroy();app.exit(0)
    }
    run().catch(error=>{console.error(error.stack||error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)})
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'), [runner], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 45000)
  const result = await new Promise((resolve,reject) => { child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal})) })
  clearTimeout(timeout)
  process.stdout.write(output)
  assert.equal(result.code,0,'Gantt Electron fixture failed: '+(result.code??result.signal))
  assert.ok(output.includes('Gantt scroll regressions passed'),'Renderer exited before finishing checks')
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  if(child&&child.exitCode===null&&child.signalCode===null) child.kill()
  assert.equal(path.dirname(path.resolve(temporary)),parent)
  assert.ok(path.basename(temporary).startsWith('.gantt-scroll-test-'))
  fs.rmSync(temporary,{recursive:true,force:true})
})
