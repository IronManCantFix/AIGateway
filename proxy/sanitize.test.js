import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// Inline-import the function by evaluating the source — we don't export it
// because it's internal to proxy-server.js. Use a regex extract for the test.
const src = readFileSync(new URL('./proxy-server.js', import.meta.url), 'utf8')
const m = src.match(/function sanitizeImageResponseBody[\s\S]*?\n\}/)
assert.ok(m, 'sanitizeImageResponseBody must be present in proxy-server.js')
const sanitize = new Function(`${m[0]}; return sanitizeImageResponseBody`)()

test('sanitize: strips b64_json', () => {
  const input = JSON.stringify({ created: 1, data: [{ b64_json: 'AAAABBBBCCCC', revised_prompt: 'foo' }] })
  const out = JSON.parse(sanitize(input))
  assert.equal(out.data[0].b64_json, '<base64 stripped, length=12>')
  assert.equal(out.data[0].revised_prompt, 'foo')
})

test('sanitize: keeps url-form responses untouched', () => {
  const input = JSON.stringify({ created: 1, data: [{ url: 'https://x.example/img.png', revised_prompt: 'foo' }] })
  const out = JSON.parse(sanitize(input))
  assert.equal(out.data[0].url, 'https://x.example/img.png')
})

test('sanitize: non-JSON passes through unchanged', () => {
  assert.equal(sanitize('not json at all'), 'not json at all')
})

test('sanitize: empty input passes through', () => {
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(''), '')
})
