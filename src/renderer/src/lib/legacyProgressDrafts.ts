/** Unscoped drafts from older Web builds. Ownership must be confirmed by the user. */
export interface LegacyProgressDraft {
  id: string
  kind: 'detail' | 'timeline-note' | 'timeline-comment'
  sourceKey: string
  entryKey?: string
  todoId?: string
  body: string
}

export type LegacyDraftAvailability = 'available' | 'same' | 'conflict'
export const PROGRESS_DRAFTS_UPDATED_EVENT = 'hakobi:progress-drafts-updated'
const DETAIL_PREFIX = 'progress-note-draft:'
const TIMELINE_NOTES = 'progress-timeline-note-drafts'
const TIMELINE_COMMENTS = 'progress-timeline-comment-drafts'

function readRawProgressDraftMap(storage: Storage, key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

export function readProgressDraftMap(storage: Storage, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(readRawProgressDraftMap(storage, key) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export function listLegacyProgressDrafts(storage: Storage): LegacyProgressDraft[] {
  const drafts: LegacyProgressDraft[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(DETAIL_PREFIX)) continue
    const todoId = key.slice(DETAIL_PREFIX.length)
    // Current per-account keys contain another colon and must never be inspected.
    if (!todoId || todoId.includes(':')) continue
    const body = storage.getItem(key)
    if (body?.trim()) drafts.push({ id: key, kind: 'detail', sourceKey: key, todoId, body })
  }
  for (const [sourceKey, kind] of [[TIMELINE_NOTES, 'timeline-note'], [TIMELINE_COMMENTS, 'timeline-comment']] as const) {
    for (const [entryKey, body] of Object.entries(readProgressDraftMap(storage, sourceKey))) {
      if (!body.trim() || !entryKey) continue
      if (kind === 'timeline-comment' && !/^(note|reply):.+/.test(entryKey)) continue
      drafts.push({ id: `${sourceKey}/${entryKey}`, kind, sourceKey, entryKey, todoId: kind === 'timeline-note' ? entryKey : undefined, body })
    }
  }
  return drafts
}

export function legacyDraftTargetKey(draft: LegacyProgressDraft, userId: string): string {
  if (!userId || userId.includes(':')) throw new Error('ログイン中のアカウントを確認できませんでした')
  return draft.kind === 'detail' ? `${DETAIL_PREFIX}${userId}:${draft.todoId}` : `${draft.sourceKey}:${userId}`
}

export function legacyDraftAvailability(storage: Storage, draft: LegacyProgressDraft, userId: string): LegacyDraftAvailability {
  const key = legacyDraftTargetKey(draft, userId)
  const map = draft.entryKey ? readRawProgressDraftMap(storage, key) : null
  if (draft.entryKey && map === null) return 'conflict'
  const existing = draft.entryKey ? map![draft.entryKey] : storage.getItem(key)
  if (existing !== undefined && existing !== null && typeof existing !== 'string') return 'conflict'
  if (!existing?.trim()) return 'available'
  return existing === draft.body ? 'same' : 'conflict'
}

/** Explicitly selected drafts are moved only after a successful, non-overwriting write. */
export function restoreLegacyProgressDrafts(storage: Storage, selected: LegacyProgressDraft[], userId: string): { restored: string[]; skipped: string[]; changedKeys: string[] } {
  const restored: string[] = []
  const skipped: string[] = []
  const changedKeys = new Set<string>()
  for (const draft of selected) {
    const source = draft.entryKey ? readProgressDraftMap(storage, draft.sourceKey)[draft.entryKey] : storage.getItem(draft.sourceKey)
    // A second window may have changed or already restored this draft.
    if (source !== draft.body || legacyDraftAvailability(storage, draft, userId) !== 'available') {
      skipped.push(draft.id)
      continue
    }
    const key = legacyDraftTargetKey(draft, userId)
    if (draft.entryKey) {
      const current = readRawProgressDraftMap(storage, key) ?? {}
      storage.setItem(key, JSON.stringify({ ...current, [draft.entryKey]: draft.body }))
      const remaining = readRawProgressDraftMap(storage, draft.sourceKey) ?? {}
      if (remaining[draft.entryKey] === draft.body) {
        delete remaining[draft.entryKey]
        if (Object.keys(remaining).length) storage.setItem(draft.sourceKey, JSON.stringify(remaining))
        else storage.removeItem(draft.sourceKey)
      }
    } else {
      storage.setItem(key, draft.body)
      if (storage.getItem(draft.sourceKey) === draft.body) storage.removeItem(draft.sourceKey)
    }
    changedKeys.add(key)
    restored.push(draft.id)
  }
  return { restored, skipped, changedKeys: [...changedKeys] }
}

export function announceProgressDraftChanges(keys: string[]): void {
  window.dispatchEvent(new CustomEvent(PROGRESS_DRAFTS_UPDATED_EVENT, { detail: keys }))
}

/** Storage events cover other windows; the custom event covers the writing window. */
export function subscribeProgressDraftChanges(key: string, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => { if (event.key === key || event.key === null) listener() }
  const onLocal = (event: Event): void => {
    const keys = (event as CustomEvent<unknown>).detail
    if (Array.isArray(keys) && keys.includes(key)) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(PROGRESS_DRAFTS_UPDATED_EVENT, onLocal)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(PROGRESS_DRAFTS_UPDATED_EVENT, onLocal)
  }
}
