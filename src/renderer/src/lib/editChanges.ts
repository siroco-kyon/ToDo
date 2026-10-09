function comparable(key: string, value: unknown): unknown {
  if (key === 'co_assignee_ids' && Array.isArray(value)) return [...new Set(value)].sort()
  return value ?? null
}

/** Keep untouched fields out of the request; compare edited fields with their original values. */
export function buildEditPatch<T extends object>(base: T, draft: T): Partial<T> & { expected_values?: Record<string, unknown> } {
  const changed: Record<string, unknown> = {}
  const expected: Record<string, unknown> = {}
  for (const key of Object.keys(draft)) {
    if (key === 'id' || key === 'expected_values') continue
    const before = (base as Record<string, unknown>)[key]
    const after = (draft as Record<string, unknown>)[key]
    if (JSON.stringify(comparable(key, before)) === JSON.stringify(comparable(key, after))) continue
    changed[key] = after ?? null
    expected[key] = comparable(key, before)
  }
  return Object.keys(changed).length ? { ...changed, expected_values: expected } as Partial<T> & { expected_values: Record<string, unknown> } : {}
}
