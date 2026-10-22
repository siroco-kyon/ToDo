// Capture the real personal-mode renderer and IPC against a disposable SQLite DB.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../../..'),assets=path.resolve(__dirname,'../assets');
if(!process.versions.electron){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hakobi-personal-capture-'));
 const {buildSync}=require(path.join(root,'node_modules/esbuild'));
 buildSync({stdin:{contents:"export {initDb,getDb} from './db';export {registerIpcHandlers} from './ipc'",resolveDir:path.join(root,'src/main'),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:path.join(temp,'backend.cjs')});
 const result=require('node:child_process').spawnSync(require(path.join(root,'node_modules/electron')),[__filename,temp],{stdio:'inherit',windowsHide:true,cwd:temp});process.exit(result.status??1);
}
const {app,BrowserWindow,ipcMain}=require('electron');const temp=process.argv[2];
if(!path.basename(temp).startsWith('hakobi-personal-capture-'))throw new Error('Expected disposable directory');
const profile=path.join(temp,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.disableHardwareAcceleration();
fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({dataDir:path.join(temp,'db'),skipLegacyRecovery:true}));
app.whenReady().then(async()=>{try{
 const Module=require('node:module');const m=new Module(path.join(root,'out/main/capture-backend.cjs'),module);m.filename=path.join(root,'out/main/capture-backend.cjs');m.paths=Module._nodeModulePaths(path.join(root,'out/main'));m._compile(fs.readFileSync(path.join(temp,'backend.cjs'),'utf8'),m.filename);
 const backend=m.exports;backend.initDb();
 const win=new BrowserWindow({show:false,width:1440,height:960,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,preload:path.join(root,'out/preload/index.js')}});
 backend.registerIpcHandlers(win,()=>{},()=>{},()=>{},()=>{});
 const launcher=new BrowserWindow({show:false,width:1050,height:760,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,preload:path.join(root,'out/preload/launcher.js')}});
 const state={mode:'unset',profile:null,preferences:{showTimer:false,alwaysOnTop:false,hideTaskTitle:false},message:'',connecting:false,canCancel:false};
 ipcMain.handle('hakobi-launcher:state',()=>state);ipcMain.handle('hakobi-launcher:local',()=>{state.mode='local'});
 await launcher.loadFile(path.join(root,'out/renderer/index.html'),{hash:'hakobi-launcher'});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));await delay(900);
 fs.writeFileSync(path.join(assets,'personal-launcher.png'),(await launcher.webContents.capturePage()).toPNG());
 await launcher.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='このPCで個人用として使う').click()`);await delay(150);
 if(state.mode!=='local')throw new Error('Personal mode selection failed');
 const js=s=>win.webContents.executeJavaScript(s);
 await win.loadFile(path.join(root,'out/renderer/index.html'));
 for(let i=0;i<100;i++){if(await js('Boolean(window.api)'))break;await delay(100)}
 await js(`(async()=>{await window.api.settingsSet('themeMode','light');await window.api.settingsSet('fontScale','120%');localStorage.setItem('app-theme-mode','light');localStorage.setItem('app-font-scale','120%');localStorage.setItem('hakobi-getting-started:local','1');const t=await window.api.todoCreate({title:'月次集計の見直し',description:'集計項目を確認し、入力フォームを試す。',status:'active',progress:25,start_date:'2026-10-22',due_date:'2026-10-30'});await window.api.progressNoteCreate(t.id,'集計項目を確認しました。次は入力フォームを試作します。');window.captureTask=t.id})()`);
 await win.loadFile(path.join(root,'out/renderer/index.html'),{query:{view:'gantt'}});await delay(1400);
 // Close only onboarding dialogs in this disposable profile.
 await js(`(()=>{for(const b of document.querySelectorAll('button'))if(['閉じる','あとで','後で'].includes(b.textContent.trim()))b.click()})()`);await delay(400);
 fs.writeFileSync(path.join(assets,'personal-gantt.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(assets,'personal-capture-info.json'),JSON.stringify({date:'2026-10-22',commit:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),temporaryDirectory:temp,mode:'personal',size:[1440,960],launcherSize:[1050,760],data:'Fictional task; actual renderer, preload, IPC and local SQLite; launcher state supplied by isolated harness; no installed app or live data opened'},null,2));
 backend.getDb().close();win.destroy();launcher.destroy();app.quit();console.log('Captured actual personal-mode screens in '+temp);
 }catch(e){console.error(e);app.exit(1)}});
