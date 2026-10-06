export interface TextPart { text: string; url?: string }

/** Preserve plain text, trimming prose punctuation and unmatched closing brackets. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  const pattern = /https?:\/\/[^\s<>"'「」『』【】、。，．！？；：]+/gi
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    let url = match[0].replace(/[.,!?;:、。，．！？；：]+$/u, '')
    for (;;) {
      const before = url
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）']]) {
        if (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1)
      }
      url = url.replace(/[.,!?;:、。，．！？；：]+$/u, '')
      if (url === before) break
    }
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) continue
    } catch { continue }
    const start = match.index!
    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    parts.push({ text: url, url })
    cursor = start + url.length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}
