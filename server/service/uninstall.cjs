// HAKOBI チームサーバーの Windows サービス登録を解除する。
// 管理者として開いた PowerShell で `npm run service:uninstall` を実行すること。
// データベース（server\data\）はサービス解除では消えない。
const { Service } = require('node-windows')
const { getServiceConfiguration } = require('./config.cjs')

const config = getServiceConfiguration(process.env, { requireGroupSettings: false })
const svc = new Service(config)
svc.directory(config.directory)

svc.on('uninstall', () => {
  console.log('[service] アンインストールしました。データ（server\\data\\）はそのまま残っています。')
})
svc.on('alreadyuninstalled', () => {
  console.log('[service] インストールされていません。')
})
svc.on('error', (err) => {
  console.error('[service] エラー:', err)
  console.error('[service] PowerShell を「管理者として実行」で開いているか確認してください。')
  process.exitCode = 1
})

console.log(`[service] ${config.name} をアンインストールします...`)
svc.uninstall()
