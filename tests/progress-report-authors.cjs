const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.progress-report-authors-test-'))
try {
  const sourcePath = path.join(root, 'src/renderer/src/components/ProgressReportModal.tsx')
  const output = path.join(dir, 'report.cjs')
  buildSync({
    stdin: {
      contents: fs.readFileSync(sourcePath, 'utf8') + '\nexport { filterNotesByAuthors };',
      resolveDir: path.dirname(sourcePath), loader: 'tsx', sourcefile: sourcePath
    },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external'
  })
  const { filterNotesByAuthors } = require(output)

  const comment = (id, userId, replies = []) => ({ id, user_id: userId, body: id, replies })
  const notes = [
    {
      id: 'mine', todo_id: 't1', user_id: 'me', body: '自分の進捗',
      comments: [
        comment('my-reply', 'me', [comment('co-under-mine', 'co')]),
        comment('co-reply', 'co', [comment('my-answer-to-co', 'me')])
      ]
    },
    { id: 'co-note', todo_id: 't1', user_id: 'co', body: '副担当の進捗', comments: [comment('my-reply-on-co', 'me')] },
    { id: 'unknown', todo_id: 't1', user_id: null, body: '投稿者不明', comments: [] }
  ]

  const mineOnly = filterNotesByAuthors(notes, new Set(['me']))
  assert.deepEqual(mineOnly.map((note) => note.id), ['mine'], '他の人の進捗ログは載せない')
  assert.deepEqual(mineOnly[0].comments.map((c) => c.id), ['my-reply'], '他の人の返信はその下の返信ごと外す')
  assert.deepEqual(mineOnly[0].comments[0].replies, [], '自分の返信に付いた他の人の返信も外す')

  const both = filterNotesByAuthors(notes, new Set(['me', 'co']))
  assert.deepEqual(both.map((note) => note.id), ['mine', 'co-note'])
  assert.equal(both[0].comments[1].replies[0].id, 'my-answer-to-co')

  assert.equal(filterNotesByAuthors(notes, new Set()), notes, 'デスクトップ版（対象IDなし）は絞らない')
  assert.equal(notes[0].comments.length, 2, '元のデータを変更しない')
  console.log('Progress report author filter checks passed')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
