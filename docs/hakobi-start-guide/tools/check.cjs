// Render and exercise the offline HTML in the repository's Electron Chromium.
// Each run uses its own temporary profile and never opens an installed HAKOBI DB.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '../../..'), guide = path.dirname(__dirname)
const output = path.join(guide, '.build'); fs.mkdirSync(output, { recursive: true })
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(require(path.join(root, 'node_modules/electron')), [__filename, ...process.argv.slice(2)], { stdio:'inherit', windowsHide:true })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = require('electron')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-guide-check-'))
app.setPath('userData', profile); app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,width:1440,height:1000,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}})
  const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level>=3)errors.push(message)})
  const js = code=>win.webContents.executeJavaScript(code)
  const shot = async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())}
  await win.loadFile(path.join(guide,'index.html'))
  await new Promise(r=>setTimeout(r,300))
  const results={}
  results.images=await js(`[...document.images].filter(x=>x.getAttribute('src')).every(x=>x.complete&&x.naturalWidth>0)`)
  results.links=await js(`[...document.querySelectorAll('a[href^="#"]')].every(a=>document.getElementById(a.getAttribute('href').slice(1)))`)
  await shot('desktop-hero')
  results.desktopNoOverflow=await js('document.documentElement.scrollWidth<=innerWidth')
  for(const id of ['features','solo','move','team','setup','desktop-build','server-build','care','trouble','check']){
    await js(`document.documentElement.style.scrollBehavior='auto';document.getElementById('${id}').scrollIntoView()`)
    await shot('desktop-'+id)
  }
  results.routes=await js(`(()=>{document.querySelector('[data-route="host"]').click();return document.getElementById('route-next').getAttribute('href')==='#setup'})()`)
  results.featureTour=await js(`document.querySelectorAll('#features .feature-card').length===8`)
  results.screenshotCount=await js(`document.querySelectorAll('figure img').length`)
  results.cases=await js(`(()=>{document.querySelector('[data-case="discussion"]').click();return !document.querySelector('[data-panel="discussion"]').hidden&&document.querySelector('[data-panel="team"]').hidden})()`)
  results.zoom=await js(`(()=>{document.querySelector('[data-zoom]').click();const open=document.getElementById('zoom').open;document.getElementById('zoom-close').click();return open&&!document.getElementById('zoom').open})()`)
  results.commands=await js(String.raw`(()=>{const d=document.getElementById('workdir'),i=document.getElementById('serverip');d.value='D:\\Team Work\\HAKOBI';i.value='10.0.0.25';d.dispatchEvent(new Event('input'));i.dispatchEvent(new Event('input'));return document.getElementById('cmd-server').textContent.includes("Set-Location -LiteralPath 'D:\\Team Work\\HAKOBI'")&&document.querySelector('.generated-url').textContent==='http://10.0.0.25:4577'})()`)
  results.validation=await js(String.raw`(()=>{const i=document.getElementById('serverip');i.value='999.1.1.1';i.dispatchEvent(new Event('input'));const disabled=document.getElementById('save-plan').disabled;i.value='192.168.1.50';document.getElementById('workdir').value='C:\\HAKOBI\\ToDo';i.dispatchEvent(new Event('input'));return disabled&&!document.getElementById('save-plan').disabled})()`)
  results.motionPause=await js(`(()=>{const svg=document.getElementById('traffic-diagram'),initial=svg.animationsPaused();document.getElementById('motion').click();const flipped=svg.animationsPaused()!==initial;document.getElementById('motion').click();return flipped&&svg.animationsPaused()===initial})()`)
  results.savedCheck=await js(`(()=>{document.querySelector('[data-check]').click();return JSON.parse(localStorage.getItem('hakobi-start-guide:checks:v1')).local===true})()`)
  await win.reload();await new Promise(r=>setTimeout(r,150))
  results.reloadedCheck=await js('document.querySelector("[data-check]").checked')
  await js('document.getElementById("reset").click()')
  win.setContentSize(1024,900);await js('scrollTo(0,0)');await shot('compact-hero')
  results.compactPcNoOverflow=await js('document.documentElement.scrollWidth<=innerWidth')
  for(const id of ['move','team','settings-helper','server-build']){await js(`document.getElementById('${id}').scrollIntoView()`);await shot('compact-'+id)}
  win.setContentSize(1280,900);win.webContents.setZoomFactor(1.25)
  await js("document.getElementById('settings-helper').scrollIntoView()")
  await shot('pc-zoom-125')
  results.pcZoom125NoOverflow=await js('document.documentElement.scrollWidth<=innerWidth')
  win.webContents.setZoomFactor(1)
  // Exercise print styling and its disclosure expansion.
  win.setContentSize(1440,1000)
  fs.writeFileSync(path.join(output,'print-check.pdf'),await win.webContents.printToPDF({printBackground:true,pageSize:'A4'}))
  // A complete reading record in viewport-sized pieces, with every disclosure open.
  win.setContentSize(1440,1000)
  await js(`document.querySelectorAll('details').forEach(x=>x.open=true);document.querySelectorAll('[data-panel]').forEach(x=>x.hidden=false);document.documentElement.style.scrollBehavior='auto';scrollTo(0,0)`)
  await js("document.getElementById('announce').textContent=''");const height=await js('document.documentElement.scrollHeight')
  for(let y=0,i=1;y<height;y+=850,i++){await js(`scrollTo(0,${y})`);await shot('reading-'+String(i).padStart(2,'0'))}
  if(process.argv.includes('--frames')){
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
    win.setContentSize(1100,510);await win.loadFile(path.join(guide,'team-traffic.svg'))
    await js(`document.documentElement.pauseAnimations();document.getAnimations().forEach(a=>a.pause())`)
    const frames=path.join(output,'frames');fs.mkdirSync(frames,{recursive:true})
    for(let i=0;i<=90;i++){
      await js(`document.documentElement.setCurrentTime(${i/15});document.getAnimations().forEach(a=>{a.pause();a.currentTime=${i*1000/15}})`)
      // Let Chromium paint a frame after seeking both SMIL and CSS timelines.
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.png'),(await win.webContents.capturePage()).toPNG())
    }
  }
  results.consoleErrors=errors;results.animationPeriodSeconds=6
  fs.writeFileSync(path.join(output,'browser-check.json'),JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
  const failed=Object.entries(results).filter(([k,v])=>v===false)
  if(failed.length||errors.length)throw new Error('Guide checks failed: '+JSON.stringify(failed))
  win.destroy();app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
