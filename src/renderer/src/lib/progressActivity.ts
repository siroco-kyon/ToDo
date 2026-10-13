import type { ProgressNote, ProgressNoteComment, PublicUser } from '../types'

// 進捗タブの「新着」と「自分宛て」の判定。
// 前回進捗タブを見た時刻をユーザーごとに localStorage へ覚えておき、それより後に
// ほかの人が書いた投稿・返信を新着とする（自分の書き込みは新着にしない）。

const SEEN_KEY_PREFIX = 'progressTimeline.lastSeenAt'
const SEEN_EVENT = 'progress-timeline-seen-changed'

function seenKey(userId: string): string {
  return `${SEEN_KEY_PREFIX}:${userId}`
}

export function readProgressSeenAt(userId: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(userId))
  } catch {
    return null
  }
}

export function writeProgressSeenAt(userId: string, iso: string): void {
  try {
    window.localStorage.setItem(seenKey(userId), iso)
  } catch {
    // 覚えられなくても画面は使える（新着の印が出ないだけ）
  }
  window.dispatchEvent(new CustomEvent(SEEN_EVENT))
}

export function subscribeProgressSeenAt(callback: () => void): () => void {
  window.addEventListener(SEEN_EVENT, callback)
  return () => window.removeEventListener(SEEN_EVENT, callback)
}

export function flattenComments(comments: ProgressNoteComment[] = []): ProgressNoteComment[] {
  return comments.flatMap((comment) => [comment, ...flattenComments(comment.replies ?? [])])
}

/** ほかの人が seenAt より後に書いたものか */
export function isUnseen(item: { user_id: string | null; created_at: string }, userId: string, seenAt: string | null): boolean {
  if (!seenAt) return false
  return item.user_id !== userId && item.created_at > seenAt
}

export function noteHasUnseen(note: ProgressNote, userId: string, seenAt: string | null): boolean {
  return isUnseen(note, userId, seenAt) || flattenComments(note.comments).some((comment) => isUnseen(comment, userId, seenAt))
}

/** 新着の件数（投稿と返信をそれぞれ1件と数える） */
export function countUnseenActivity(notes: ProgressNote[], userId: string, seenAt: string | null, hiddenTodoIds: Set<string>): number {
  let count = 0
  for (const note of notes) {
    if (hiddenTodoIds.has(note.todo_id)) continue
    if (isUnseen(note, userId, seenAt)) count += 1
    count += flattenComments(note.comments).filter((comment) => isUnseen(comment, userId, seenAt)).length
  }
  return count
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 「@名前」の判定（サーバーの server/src/mention.ts と同じ規則）。
// 「@」の前は行頭か、メールアドレスの一部にならない文字。名前の後ろは区切り・敬称・助詞
export const MENTION_BEFORE = '(?:^|[^A-Za-z0-9_.+\\-])'
const MENTION_AFTER = '(?=$|[\\s.,!?、。！？:：;；()（）「」『』・]|さん|さま|様|くん|君|ちゃん|氏|殿|へ|に|が|は|の|と|も|や)'

/** 本文で「@名前」と呼ばれているか（サーバーのメンション通知と同じ条件） */
export function mentionsUser(body: string, user: Pick<PublicUser, 'display_name' | 'username'>): boolean {
  return [user.display_name, user.username].some((name) => {
    const escaped = escapeRegExp(name.trim())
    if (!escaped) return false
    return new RegExp(`${MENTION_BEFORE}@${escaped}${MENTION_AFTER}`, 'iu').test(body)
  })
}

/**
 * 自分宛ての動きがある進捗ログか。
 * 自分の投稿にほかの人が返信した・自分の返信にほかの人が返信した・本文や返信で自分がメンションされた、のどれか。
 */
export function isAddressedToUser(note: ProgressNote, user: PublicUser): boolean {
  if (note.user_id !== user.id && mentionsUser(note.body, user)) return true
  const walk = (comments: ProgressNoteComment[], parentAuthorId: string | null): boolean => comments.some((comment) => {
    const fromOther = comment.user_id !== user.id
    if (fromOther && (parentAuthorId === user.id || mentionsUser(comment.body, user))) return true
    return walk(comment.replies ?? [], comment.user_id)
  })
  return walk(note.comments ?? [], note.user_id)
}
