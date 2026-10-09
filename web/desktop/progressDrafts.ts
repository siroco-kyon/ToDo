import type { QuickProgressRequest } from '../lib/client'

export interface ProgressDraft {
  body: string
  attempt?: QuickProgressRequest
  taskTitle?: string
  updatedAt?: string
  lastError?: string
}

export interface SavedProgressDraft {
  todoId: string
  draft: ProgressDraft
}

export interface DraftStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const progressDraftKey = (userId: string, todoId: string): string => `hakobi-progress-draft:${userId}:${todoId}`

function parseDraft(raw: string | null, userId: string, todoId: string): ProgressDraft {
  if (!raw) return { body: '' }
  try {
    const value = JSON.parse(raw) as Partial<ProgressDraft> | null
    if (!value || typeof value.body !== 'string') return { body: '' }
    const draft: ProgressDraft = { body: value.body }
    if (typeof value.taskTitle === 'string') draft.taskTitle = value.taskTitle
    if (typeof value.updatedAt === 'string') draft.updatedAt = value.updatedAt
    if (typeof value.lastError === 'string') draft.lastError = value.lastError
    const attempt = value.attempt
    if (attempt && attempt.expectedUserId === userId && attempt.todoId === todoId &&
        typeof attempt.requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(attempt.requestId) &&
        typeof attempt.body === 'string' && typeof attempt.stopTimer === 'boolean' &&
        (attempt.expectedStartTime === undefined || attempt.expectedStartTime === null || typeof attempt.expectedStartTime === 'string')) {
      // Preserve exactly the previously sent payload, including its timer instance.
      draft.attempt = attempt
      draft.body = attempt.body
    }
    return draft
  } catch { return { body: '' } }
}

export function readProgressDraft(storage: DraftStorage, userId: string, todoId: string): ProgressDraft {
  try { return parseDraft(storage.getItem(progressDraftKey(userId, todoId)), userId, todoId) }
  catch { return { body: '' } }
}

export function writeProgressDraft(storage: DraftStorage, userId: string, todoId: string, draft: ProgressDraft): void {
  const key = progressDraftKey(userId, todoId)
  if (!draft.body && !draft.attempt) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify(draft))
}

export function listProgressDrafts(storage: DraftStorage, userId: string): SavedProgressDraft[] {
  const prefix = progressDraftKey(userId, '')
  const drafts: SavedProgressDraft[] = []
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const todoId = key.slice(prefix.length)
      const draft = readProgressDraft(storage, userId, todoId)
      if (draft.body || draft.attempt) drafts.push({ todoId, draft })
    }
  } catch { /* Editing reports storage errors; an unavailable list must not crash the form. */ }
  return drafts.sort((a, b) => (b.draft.updatedAt ?? '').localeCompare(a.draft.updatedAt ?? ''))
}

/** Transfer only unsent text, and refuse to overwrite a pending submission. */
export function transferProgressDraft(storage: DraftStorage, userId: string, from: string, to: string): ProgressDraft {
  if (!to || to === from) throw new Error('別のタスクを選択してください')
  const source = readProgressDraft(storage, userId, from)
  const destination = readProgressDraft(storage, userId, to)
  if (source.attempt || destination.attempt) throw new Error('送信結果が未確認の下書きは移せません。同じ投稿を再試行して結果を確認してください')
  if (!source.body.trim()) throw new Error('移す下書きがありません')
  const next: ProgressDraft = { body: destination.body ? `${destination.body}\n\n${source.body}` : source.body, updatedAt: new Date().toISOString(), taskTitle: destination.taskTitle }
  if (next.body.length > 10000) throw new Error('移し先と合わせると10000文字を超えます。本文をコピーして分けて投稿してください')
  // Write first: even if removing the source fails, its text remains recoverable.
  writeProgressDraft(storage, userId, to, next)
  storage.removeItem(progressDraftKey(userId, from))
  return next
}
