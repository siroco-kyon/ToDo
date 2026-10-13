/**
 * electron-builder が作ったデスクトップ版インストーラーを、サーバーの配布フォルダへ公開する。
 *
 *   npm run publish:desktop -- [--from <dir>] [--to <dir>] [--expect-version <x.y.z>]
 *
 * 既定では リポジトリ直下の dist から DESKTOP_DIST_DIR（server/.env の TODO_DESKTOP_DIST）へ公開する。
 * インストーラーを先に置き、latest.yml を最後に差し替えるので、コピー途中のファイルは配布されない。
 * 古いバージョンのインストーラーは消さない。
 */
import fs from 'fs'
import path from 'path'
import { DESKTOP_DIST_DIR, PORT } from '../src/config'
import { verifyDesktopRelease, type DesktopRelease } from '../src/desktopRelease'

const REPO_DIR = path.resolve(__dirname, '..', '..')
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const USAGE = [
  '使い方: npm run publish:desktop -- [--from <フォルダ>] [--to <フォルダ>] [--expect-version <x.y.z>]',
  `  --from            npm run dist の出力先（既定: ${path.join(REPO_DIR, 'dist')}）`,
  `  --to              サーバーの配布フォルダ（既定: ${DESKTOP_DIST_DIR}）`,
  '  --expect-version  公開するバージョン（既定: リポジトリ直下の package.json の version）'
].join('\n')

class PublishError extends Error {}

interface PublishOptions {
  from: string
  to: string
  expectVersion: string | null
  expectSource: string
}

/** npm run は server/ で実行されるので、相対パスは npm を実行したフォルダから解決する */
function resolveArgumentPath(value: string): string {
  return path.resolve(process.env.INIT_CWD || process.cwd(), value)
}

function rootPackageVersion(): string | null {
  const file = path.join(REPO_DIR, 'package.json')
  if (!fs.existsSync(file)) return null
  const version: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).version
  return typeof version === 'string' ? version : null
}

function parseArgs(argv: string[]): PublishOptions | null {
  let from = path.join(REPO_DIR, 'dist')
  let to = DESKTOP_DIST_DIR
  let expectVersion: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return null
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const value = (): string => {
      const given = eq > 0 ? arg.slice(eq + 1) : argv[++index]
      if (!given || given.startsWith('--')) throw new PublishError(`${name} の値を指定してください\n${USAGE}`)
      return given
    }
    if (name === '--from') from = resolveArgumentPath(value())
    else if (name === '--to') to = resolveArgumentPath(value())
    else if (name === '--expect-version') expectVersion = value()
    else throw new PublishError(`分からない指定です: ${arg}\n${USAGE}`)
  }

  if (expectVersion !== null) {
    if (!VERSION_PATTERN.test(expectVersion)) throw new PublishError(`--expect-version は x.y.z の形で指定してください: ${expectVersion}`)
    return { from, to, expectVersion, expectSource: '--expect-version' }
  }
  return { from, to, expectVersion: rootPackageVersion(), expectSource: path.join(REPO_DIR, 'package.json') }
}

function formatBytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true
  try {
    return (await fs.promises.realpath(a)) === (await fs.promises.realpath(b))
  } catch {
    return false
  }
}

/** Windows ではウイルス対策ソフトがコピー直後のファイルを開いていて、名前の変更が一時的に失敗することがある */
async function rename(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (process.platform !== 'win32' || !busy || attempt >= 10) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    }
  }
}

/** いったん <名前>.partial へ書き、終わってから本来の名前へ置き換える */
async function replaceFile(target: string, write: (partial: string) => Promise<void>): Promise<void> {
  const partial = `${target}.partial`
  try {
    await write(partial)
    await rename(partial, target)
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}

async function publish(options: PublishOptions): Promise<DesktopRelease> {
  const { from, to } = options
  console.log(`公開元: ${from}`)
  console.log(`公開先: ${to}`)
  if (await sameDirectory(from, to)) throw new PublishError('公開元と公開先が同じフォルダです。--from か --to を指定してください')

  const source = await verifyDesktopRelease(from)
  if (!source.ok) {
    throw new PublishError(`公開元のインストーラーを確認できませんでした: ${source.reason}\n先に npm run dist でインストーラーを作成してください。`)
  }
  const release = source.release
  if (options.expectVersion !== null && release.version !== options.expectVersion) {
    throw new PublishError(`公開元のバージョン ${release.version} が ${options.expectSource} のバージョン ${options.expectVersion} と一致しません。` +
      'npm run dist で作り直すか、--expect-version で公開するバージョンを指定してください')
  }
  console.log(`インストーラーを確認しました: ${release.fileName}（${formatBytes(release.size)}、SHA-256 ${release.sha256}）`)

  const current = await verifyDesktopRelease(to)
  if (current.ok) {
    console.log(`現在の公開: HAKOBI ${current.release.version}`)
    if (current.release.version === release.version && current.release.sha512 !== release.sha512) {
      console.warn(`注意: 中身の違う HAKOBI ${release.version} で置き換えます。インストール済みのPCには新しいバージョンとして通知されません。`)
    }
  }

  try {
    await fs.promises.mkdir(to, { recursive: true })
  } catch (error) {
    throw new PublishError(`公開先のフォルダを作成できませんでした: ${(error as Error).message}`)
  }

  const installer = path.join(to, release.fileName)
  await replaceFile(installer, (partial) => fs.promises.copyFile(path.join(from, release.fileName), partial))
  const blockmap = `${release.fileName}.blockmap`
  if (await isRegularFile(path.join(from, blockmap))) {
    await replaceFile(path.join(to, blockmap), (partial) => fs.promises.copyFile(path.join(from, blockmap), partial))
  }
  // latest.yml は最後に差し替える。サーバーはこれを見て配布を始める
  const latestYml = await fs.promises.readFile(path.join(from, 'latest.yml'))
  await replaceFile(path.join(to, 'latest.yml'), (partial) => fs.promises.writeFile(partial, latestYml))

  const published = await verifyDesktopRelease(to)
  if (!published.ok) throw new PublishError(`公開先を確認できませんでした: ${published.reason}`)
  if (published.release.version !== release.version || published.release.sha512 !== release.sha512) {
    throw new PublishError('公開先のインストーラーが公開元と一致しません。公開中に dist が変わった可能性があります。もう一度実行してください')
  }
  return published.release
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    console.log(USAGE)
    return
  }
  const release = await publish(options)
  console.log(`公開しました: HAKOBI ${release.version}（${options.to}）。` +
    `メンバーには http://<サーバー>:${PORT}/download を案内してください。`)
}

main().catch((error: unknown) => {
  const message = error instanceof PublishError ? error.message : `${(error as Error)?.message ?? error}`
  console.error(`公開できませんでした: ${message}`)
  process.exitCode = 1
})
