// Extend the established disposable demo capture without touching live app data.
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process')
const root = path.resolve(__dirname,'../../..'), guide = path.dirname(__dirname)
const build = path.join(guide,'.build'), output=path.join(build,'feature-captures')
fs.mkdirSync(output,{recursive:true})
let source=fs.readFileSync(path.join(root,'docs/hakobi-showcase/tools/capture.cjs'),'utf8')
source=source.replace("const { spawn } = require('node:child_process')", "const { spawn, spawnSync } = require('node:child_process')")
source=source.replace("const root = path.resolve(__dirname, '../../..')",'const root = '+JSON.stringify(root))
source=source.replace("const output = path.resolve(__dirname, '../assets')",'const output = '+JSON.stringify(output))
source=source.replace('JSON.stringify({origin,temp,commit})','JSON.stringify({origin,temp,commit,nodeExe:process.execPath})')
const more=String.raw`
  await open('gantt')
  const extra=await js(`+'`'+String.raw`(async()=>{
    const api=window.api,me=await api.authGetCurrentUser();
    const task=await api.todoCreate({title:'説明会の配布資料を整える',description:'説明会で使う資料を読み直し、参加者へ配る。',assignee_id:me.id,status:'active',progress:40,start_date:'2026-10-21',due_date:'2026-10-28'});
    const next=await api.todoCreate({title:'資料を参加者へ送る',assignee_id:me.id,status:'not_started',start_date:'2026-10-29',due_date:'2026-10-30'});
    await api.todoDependencyCreate(task.id,next.id,0);
    const list=await api.todoCreate({title:'説明会前の確認リスト',assignee_id:me.id,status:'active',list_mode:1,start_date:'2026-10-21',due_date:'2026-10-28'});
    const done=await api.subtaskCreate(list.id,{title:'会場を予約する'});await api.subtaskUpdate(done.id,{done:true});
    await api.subtaskCreate(list.id,{title:'参加者の人数を確認する'});await api.subtaskCreate(list.id,{title:'配布資料を印刷する'});
    await api.dailyPlanAdd('2026-10-21',task.id,{scheduled_start:'09:00',estimated_minutes:60,lane:0});
    await api.dailyPlanAdd('2026-10-21',list.id,{scheduled_start:'10:15',estimated_minutes:30,lane:0});
    await api.dailyPlanAdd('2026-10-21',task.id,{scheduled_start:'14:00',estimated_minutes:45,lane:1,allowDuplicate:true});
    await api.timerStart(task.id);return {task:task.id,list:list.id};
  })()`+'`'+String.raw`)
  // Only the disposable fixture's running clock is aged to show a useful demo duration.
  if(!path.basename(fixture.temp).startsWith('hakobi-showcase-'))throw new Error('Expected disposable fixture')
  const seed=spawnSync(fixture.nodeExe,['-e',
    "const D=require("+JSON.stringify(path.join(root,'server/node_modules/better-sqlite3'))+");const db=new D("+JSON.stringify(path.join(fixture.temp,'db/todo.db'))+");db.prepare('UPDATE RunningState SET start_time = ?').run(new Date(Date.now()-35*60000).toISOString());db.close();"],{windowsHide:true,encoding:'utf8'})
  if(seed.status!==0)throw new Error(seed.stderr)
  await open('detail',extra.task);await shot('tour-timer')
  await js(`+'`'+String.raw`window.api.timerStop('配布資料の見出しと図を確認した')`+'`'+String.raw`)
  await open('log');await js("[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-expanded')==='false'&&x.textContent.includes('説明会の配布資料')).click()");await shot('tour-record')
  await open('plan');await js("(()=>{const e=document.querySelector('[aria-label=計画の時間割]');e.parentElement.parentElement.scrollTop=960})()");await shot('tour-plan')
  await open('kanban');await shot('tour-kanban')
  await open('todo');await js("[...document.querySelectorAll('details')].filter(x=>x.querySelector('summary')?.textContent.includes('済み')).forEach(x=>x.open=true)");await shot('tour-checklist')
  await open('detail',extra.task)
  await js(`+'`'+String.raw`(()=>{const e=[...document.querySelectorAll('h3')].find(x=>x.textContent.includes('依存関係'));if(!e)throw new Error('Dependency section missing');e.scrollIntoView({block:'center'})})()`+'`'+String.raw`)
  await shot('tour-dependencies')
`
source=source.replace('  win.destroy(); app.exit(0)',more+'\n  win.destroy(); app.exit(0)')
const script=path.join(build,'feature-capture-runtime.cjs');fs.writeFileSync(script,source)
const result=spawnSync(process.execPath,[script],{stdio:'inherit',windowsHide:true})
process.exitCode=result.status??1
