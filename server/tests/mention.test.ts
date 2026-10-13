import assert from 'node:assert/strict'
import test from 'node:test'
import { containsMention } from '../src/mention'

test('日本語の書き方でも「@名前」をメンションとして拾い、メールアドレスは拾わない', () => {
  assert.equal(containsMention('環境ができました。@管理者 結果を見てください', '管理者'), true)
  assert.equal(containsMention('@佐藤さん お願いします', '佐藤'), true)
  assert.equal(containsMention('@佐藤へ確認しました', '佐藤'), true)
  assert.equal(containsMention('@佐藤', '佐藤'), true)
  assert.equal(containsMention('(@sato) thanks', 'sato'), true)
  assert.equal(containsMention('@SATO 確認', 'sato'), true)
  assert.equal(containsMention('@佐藤健 です', '佐藤'), false)
  assert.equal(containsMention('連絡先 sato@example.com', 'example'), false)
  assert.equal(containsMention('foo@sato', 'sato'), false)
  assert.equal(containsMention('名前に記号 @a.b+c です', 'a.b+c'), true)
})
