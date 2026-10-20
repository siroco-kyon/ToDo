// 確かめの小窓を開く（React に依存しない）。画面に ConfirmHost があればそれを使い、なければ（別ウィンドウのガントなど）
// ブラウザ標準の confirm() で確かめる。答えは Promise で返す
export interface ConfirmOptions {
  /** 進める方のボタンの文字（既定は「OK」） */
  confirmLabel?: string
  /** やめる方のボタンの文字（既定は「キャンセル」） */
  cancelLabel?: string
  /** 削除など元に戻せない操作。進めるボタンを赤にする */
  danger?: boolean
}

export interface ConfirmRequest {
  id: number
  /** 1行目が見出し、2行目以降が説明 */
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  resolve: (value: boolean) => void
}

let host: ((request: ConfirmRequest) => void) | null = null
let nextId = 0

/** ConfirmHost が自分を登録する。外すための関数を返す */
export function registerConfirmHost(show: (request: ConfirmRequest) => void): () => void {
  host = show
  return () => { if (host === show) host = null }
}

export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (!host) return Promise.resolve(window.confirm(message))
  const show = host
  return new Promise((resolve) => {
    show({
      id: ++nextId,
      message,
      confirmLabel: options.confirmLabel ?? 'OK',
      cancelLabel: options.cancelLabel ?? 'キャンセル',
      danger: options.danger ?? false,
      resolve
    })
  })
}
