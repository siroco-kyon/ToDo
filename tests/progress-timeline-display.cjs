const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.progress-sort-test-'))
try {
  const sourcePath = path.join(root, 'src/renderer/src/components/ProgressTimeline.tsx')
  const output = path.join(dir, 'timeline.cjs')
  buildSync({
    stdin: {
      contents: fs.readFileSync(sourcePath, 'utf8') + '\nexport { sortNotes };',
      resolveDir: path.dirname(sourcePath), loader: 'tsx', sourcefile: sourcePath
    },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external'
  })
  const { sortNotes } = require(output)
  const rows = [
    { id: 'new', created_at: '2026-10-05T03:00:00.000Z', last_activity_at: '2026-10-05T03:00:00.000Z' },
    { id: 'old', created_at: '2026-10-01T03:00:00.000Z', last_activity_at: '2026-10-06T03:00:00.000Z' }
  ].map((note) => ({ ...note, todo_title: '同じタスク', category_name: '同じカテゴリ', author_name: '同じ投稿者' }))
  for (const mode of ['newest', 'todo', 'category', 'author']) {
    assert.deepEqual(sortNotes(rows, mode).map((note) => note.id), ['old', 'new'])
  }
  assert.deepEqual(sortNotes(rows, 'oldest').map((note) => note.id), ['new', 'old'])
  assert.deepEqual(rows.map((note) => note.id), ['new', 'old'], '元の配列を変更しない')
  const deletedReply = { ...rows[1], last_activity_at: rows[1].created_at }
  assert.deepEqual(sortNotes([rows[0], deletedReply], 'newest').map((note) => note.id), ['new', 'old'])
  const ties = [{ ...rows[0], id: 'b' }, { ...rows[0], id: 'a' }]
  assert.deepEqual(sortNotes(ties, 'newest').map((note) => note.id), ['a', 'b'])
  const groups = [{ ...rows[0], todo_title: 'A' }, { ...rows[1], todo_title: 'B' }]
  assert.deepEqual(sortNotes(groups, 'todo').map((note) => note.id), ['new', 'old'])
  console.log('Progress timeline display order checks passed')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
