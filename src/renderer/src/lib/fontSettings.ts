// 文字の種類と大きさの選択肢。App が起動時に使うので、設定画面（分けて読み込む）とは別のファイルに置く
export const FONT_FAMILY_DEFAULT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

export const FONT_PRESETS: Array<{ value: string; label: string }> = [
  { value: FONT_FAMILY_DEFAULT, label: 'デフォルト' },
  { value: '"Yu Gothic UI", "Yu Gothic", sans-serif', label: '游ゴシック' },
  { value: '"Meiryo", "Meiryo UI", sans-serif', label: 'メイリオ' },
  { value: '"BIZ UDGothic", sans-serif', label: 'BIZ UDゴシック' },
  { value: '"BIZ UDPGothic", sans-serif', label: 'BIZ UDPゴシック' },
  { value: '"UD Digi Kyokasho N-R", sans-serif', label: 'UDデジタル教科書体' },
  { value: '"Yu Mincho", "YuMincho", serif', label: '游明朝' },
  { value: '"MS PGothic", sans-serif', label: 'MS Pゴシック' },
  { value: '"Noto Sans JP", sans-serif', label: 'Noto Sans JP' }
]

export const FONT_SCALE_DEFAULT = '100%'

export const FONT_SCALE_PRESETS: Array<{ value: string; label: string }> = [
  { value: '87.5%', label: '小' },
  { value: FONT_SCALE_DEFAULT, label: '標準' },
  { value: '112.5%', label: '大' },
  { value: '125%', label: '特大' },
  { value: '150%', label: '最大' }
]
