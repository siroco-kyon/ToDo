const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const path = require('node:path')
const result = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/src/components/LinkedText.tsx')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
const componentModule = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, componentModule, componentModule.exports)
const { LinkedText, TextLinks } = componentModule.exports
const parser = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/src/lib/links.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const parserModule = { exports: {} }
new Function('module', 'exports', parser.outputFiles[0].text)(parserModule, parserModule.exports)
const { splitLinks } = parserModule.exports
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const urls = (text) => splitLinks(text).filter((part) => part.url).map((part) => part.url)
assert.deepEqual(urls('資料 https://example.com/a、返信 http://localhost:4577/path?q=1&x=2。'), ['https://example.com/a', 'http://localhost:4577/path?q=1&x=2'])
assert.deepEqual(urls('（https://example.com/a(b)）。'), ['https://example.com/a(b)'])
assert.deepEqual(urls('HTTPS://example.com/a\nhttps://社内.example/資料'), ['HTTPS://example.com/a', 'https://社内.example/資料'])
assert.deepEqual(urls('javascript:alert(1) file:///C:/test https:// https://?'), [])
for (const text of ['', 'URLなし\n本文', 'https://example.com/a). 後ろ', 'https://example.com/a。次の文章', '<script>alert(1)</script> https://example.com/']) {
  assert.equal(splitLinks(text).map((part) => part.text).join(''), text, 'text and punctuation must be preserved')
}
const html = renderToStaticMarkup(React.createElement(LinkedText, { text: '<script>alert(1)</script> https://example.com/?a=1&b=2' }))
assert.ok(html.includes('target="_blank"'))
assert.ok(html.includes('rel="noopener noreferrer"'))
assert.ok(html.includes('&lt;script&gt;'))
assert.ok(!html.includes('<script>'))
const preview = renderToStaticMarkup(React.createElement(TextLinks, { text: 'https://example.com/ https://example.com/' }))
assert.equal((preview.match(/<a /g) || []).length, 1)
assert.equal(renderToStaticMarkup(React.createElement(TextLinks, { text: 'リンクなし' })), '')
console.log('URL parsing and safe link rendering checks passed')
