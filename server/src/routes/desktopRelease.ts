import { Router, type Response } from 'express'
import { createDesktopReleaseReader, type DesktopReleaseResult } from '../desktopRelease'

const NOT_PUBLISHED = '配布中のインストーラーがありません'

function sendNotPublished(res: Response): void {
  res.removeHeader('Content-Disposition')
  res.removeHeader('Content-Type')
  res.set('Cache-Control', 'no-store')
  res.status(404).json({ error: NOT_PUBLISHED })
}

/**
 * デスクトップ版インストーラーの配布（ログイン不要）。
 * dataRouter（/api 以下はすべて認証が必要）より前にマウントする。
 * 配布するのは dir/latest.yml に書かれた1ファイルだけで、リクエストのパスからファイル名は作らない。
 */
export function createDesktopReleaseRouter(dir: string): Router {
  const reader = createDesktopReleaseReader(dir)
  const router = Router()

  const read = (): Promise<DesktopReleaseResult> =>
    reader.read().catch((): DesktopReleaseResult => ({ ok: false, reason: '配布フォルダを確認できませんでした' }))

  router.get('/', async (req, res) => {
    const result = await read()
    res.set('Cache-Control', 'no-store')
    if (result.ok) {
      const { version, fileName, size, sha256, releaseDate } = result.release
      res.json({ available: true, version, fileName, size, sha256, releaseDate })
      return
    }
    // 理由には配布フォルダのパスが含まれるので、管理者にだけ返す
    res.json(req.user?.role === 'admin' ? { available: false, reason: result.reason } : { available: false })
  })

  router.get('/download', async (_req, res) => {
    const result = await read()
    if (!result.ok) {
      sendNotPublished(res)
      return
    }
    const { fileName } = result.release
    res.attachment(fileName)
    // 絶対パスではなく root + ファイル名で渡す（send は絶対パスの途中にある .フォルダ も拒否するため）。
    // HEAD と Range（途中からの再開）は send が処理する。
    res.sendFile(fileName, {
      root: dir,
      dotfiles: 'deny',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      }
    }, (error?: Error & { code?: string; status?: number }) => {
      if (!error) return
      if (res.headersSent) {
        if (error.code !== 'ECONNABORTED' && error.code !== 'ECONNRESET') {
          console.warn(`[desktop] ${fileName} の送信に失敗しました: ${error.code ?? error.message}`)
        }
        // コールバックを渡すと Express は接続を閉じないので、途中で切ってダウンロードを失敗させる（開いたまま止まらないように）
        res.destroy()
        return
      }
      if (error.status === 412 || error.status === 416) {
        // 条件付き・範囲指定のリクエストに応えられないとき（Content-Range は send が設定済み）
        res.removeHeader('Content-Disposition')
        res.status(error.status).end()
        return
      }
      console.warn(`[desktop] ${fileName} を送信できませんでした: ${error.code ?? error.message}`)
      sendNotPublished(res)
    })
  })

  router.use((_req, res) => {
    res.status(404).json({ error: '見つかりません' })
  })

  return router
}
