/**
 * 利用者が選んだ色（カテゴリ・担当者の色）を文字に使うときの色。
 * ダークテーマでは白を少し混ぜて明るく、ライトテーマでは黒を混ぜて暗くし、どちらの地でも読めるようにする（styles/theme.css の --data-ink-mix・--data-ink-base）。
 * 色がない（null）ときは undefined を返し、文字色を指定しない（親の色のまま）
 */
export function dataInk(color: string | null | undefined): string | undefined {
  if (!color) return undefined
  return `color-mix(in srgb, ${color} var(--data-ink-mix), var(--data-ink-base))`
}

// 色のある系統の 400〜700（ボタンなどの塗り。ライトでも濃いまま）
const SATURATED_FILL = /var\(--(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:400|500|600|700)\)/

/**
 * ボタンの地の色に合う白い文字の色。色の付いた塗りならライトでも白いまま（--on-fill-white）、
 * 灰色や暗い地なら --white（ライトでは濃い文字になる。地もライトでは明るくなるため）
 */
export function textOnFill(background: string): string {
  return SATURATED_FILL.test(background) ? 'var(--on-fill-white)' : 'var(--white)'
}
