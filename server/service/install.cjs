// チーム ToDo サーバーを Windows サービスとして登録する。
// 管理者として開いた PowerShell で `npm run service:install` を実行すること。
//
// 環境変数（PORT / TODO_DATA_DIR / ADMIN_PASSWORD など）は「インストール時点の値」が
// サービスに焼き込まれる。変更したいときは一度 service:uninstall してから、
// 環境変数をセットし直して再インストールする。
const path = require('path')
const { Service } = require('node-windows')

const PASS_THROUGH_ENV = [
  'PORT',
  'TODO_DATA_DIR',
  'TODO_WEB_DIST',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'SESSION_TTL_DAYS'
]

const env = PASS_THROUGH_ENV.filter((name) => process.env[name]).map((name) => ({
  name,
  value: process.env[name]
}))

const svc = new Service({
  name: 'TodoTeamServer',
  description: 'チーム ToDo サーバー（ガントチャート・マルチユーザー Web、ポート 4577）',
  script: path.join(__dirname, 'run.cjs'),
  workingDirectory: path.resolve(__dirname, '..'),
  env
})

svc.on('install', () => {
  console.log('[service] インストールしました。起動します...')
  svc.start()
})
svc.on('alreadyinstalled', () => {
  console.log('[service] すでにインストール済みです。設定を変えたい場合は service:uninstall → 再インストールしてください。')
})
svc.on('start', () => {
  const port = process.env.PORT || '4577'
  console.log(`[service] 起動しました。ブラウザで http://localhost:${port} を開いて確認してください。`)
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

console.log('[service] TodoTeamServer をインストールします...')
if (env.length > 0) {
  console.log('[service] 焼き込む環境変数:', env.map((e) => e.name).join(', '))
}
svc.install()
