// HAKOBI チームサーバーを Windows サービスとして登録する。
// 管理者として開いた PowerShell で `npm run service:install` を実行すること。
//
// 設定は server\.env または TODO_ENV_FILE に書く（起動時に毎回読まれるため、
// 変更してもサービスの再起動だけで反映される）。
// シェルの環境変数（PORT / TODO_DATA_DIR / ADMIN_PASSWORD など）も
// 「インストール時点の値」としてサービスに焼き込まれ、.env より優先される。
const fs = require('fs')
const { Service } = require('node-windows')
const { getServiceConfiguration } = require('./config.cjs')

const config = getServiceConfiguration()
const svc = new Service(config)
// 同じ run.cjs を使う複数サービスでもラッパーとログを分離する。
svc.directory(config.directory)
if (config.logpath) fs.mkdirSync(config.logpath, { recursive: true })

svc.on('install', () => {
  console.log('[service] インストールしました。起動します...')
  svc.start()
})
svc.on('alreadyinstalled', () => {
  console.log('[service] すでにインストール済みです。設定を変えたい場合は service:uninstall → 再インストールしてください。')
})
svc.on('start', () => {
  console.log(`[service] ${config.name} が起動しました。http://localhost:${config.port} を開いて確認してください。`)
  console.log('[service] 以後は PC を再起動しても自動で立ち上がります。')
})
svc.on('invalidinstallation', () => {
  console.error('[service] インストール状態が壊れています。service:uninstall を試してください。')
  process.exitCode = 1
})
svc.on('error', (err) => {
  console.error('[service] エラー:', err)
  console.error('[service] PowerShell を「管理者として実行」で開いているか確認してください。')
  process.exitCode = 1
})

console.log(`[service] ${config.name} をインストールします...`)
if (config.env.length > 0) {
  console.log('[service] 焼き込む環境変数:', config.env.map((e) => e.name).join(', '))
} else {
  console.log(`[service] 設定は ${config.envPath} から読み込まれます（無ければ既定値）。`)
}
svc.install()
