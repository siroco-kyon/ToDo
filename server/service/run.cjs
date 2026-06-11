// Windows サービスから呼ばれる起動ラッパー。
// サーバー本体は TypeScript（tsx 実行）なので、tsx の CLI を子プロセスとして
// 起動し、終了コード・停止シグナルを引き継ぐ。
const { spawn } = require('child_process')
const path = require('path')

const serverDir = path.resolve(__dirname, '..')
const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const child = spawn(process.execPath, [tsxCli, path.join(serverDir, 'src', 'index.ts')], {
  cwd: serverDir,
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code) => process.exit(code ?? 0))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill())
}
