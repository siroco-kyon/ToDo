/**
 * 利用者が選んだ色（カテゴリ・担当者の色）を文字に使うときの色。
 * ダークテーマではそのまま。ライトテーマでは黒を混ぜて暗くし、明るい地でも読めるようにする（styles/theme.css の --data-ink-mix）。
 * 色がない（null）ときは undefined を返し、文字色を指定しない（親の色のまま）
 */
export function dataInk(color: string | null | undefined): string | undefined {
  if (!color) return undefined
  return `color-mix(in srgb, ${color} var(--data-ink-mix), #000)`
}
