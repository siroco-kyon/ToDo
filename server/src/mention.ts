// 進捗ログ・返信の本文から「@名前」のメンションを見つける（画面側の src/renderer/src/lib/progressActivity.ts と同じ規則）。
// 「@」の前は行頭か、メールアドレスの一部にならない文字（「〜しました。@佐藤」のような日本語の書き方も拾う）。
// 名前の後ろは区切り・敬称・助詞（「@佐藤 」「@佐藤さん」「@佐藤へ」）。「@佐藤健」は「佐藤」へのメンションにしない。

const MENTION_BEFORE = '(?:^|[^A-Za-z0-9_.+\\-])'
const MENTION_AFTER = '(?=$|[\\s.,!?、。！？:：;；()（）「」『』・]|さん|さま|様|くん|君|ちゃん|氏|殿|へ|に|が|は|の|と|も|や)'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function containsMention(body: string, name: string): boolean {
  const escaped = escapeRegex(name.trim())
  if (!escaped) return false
  return new RegExp(`${MENTION_BEFORE}@${escaped}${MENTION_AFTER}`, 'iu').test(body)
}
