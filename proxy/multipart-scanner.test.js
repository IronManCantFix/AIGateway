import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMultipartFields } from './multipart-scanner.js'

const CRLF = '\r\n'

function buildBody(boundary, parts) {
  // parts: [{ headers: 'Content-Disposition: ...', body: Buffer|string }, ...]
  const chunks = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}${p.headers}${CRLF}${CRLF}`))
    chunks.push(typeof p.body === 'string' ? Buffer.from(p.body) : p.body)
    chunks.push(Buffer.from(CRLF))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`))
  return Buffer.concat(chunks)
}

test('parseMultipartFields: single text field', () => {
  const boundary = 'X'
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.deepEqual(result.fields, { model: 'gpt-image-1' })
  assert.deepEqual(result.files, [])
})

test('parseMultipartFields: file part records metadata only', () => {
  const boundary = 'X'
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8])  // arbitrary binary
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' },
    {
      headers: 'Content-Disposition: form-data; name="image"; filename="cat.png"\r\nContent-Type: image/png',
      body: fileBytes
    },
    { headers: 'Content-Disposition: form-data; name="prompt"', body: 'add a hat' }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.deepEqual(result.fields, { model: 'gpt-image-1', prompt: 'add a hat' })
  assert.equal(result.files.length, 1)
  assert.deepEqual(result.files[0], {
    name: 'image',
    filename: 'cat.png',
    contentType: 'image/png',
    size: fileBytes.length
  })
})

test('parseMultipartFields: multiple files with same name', () => {
  const boundary = 'X'
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' },
    { headers: 'Content-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png', body: Buffer.from('AAA') },
    { headers: 'Content-Disposition: form-data; name="image[]"; filename="b.png"\r\nContent-Type: image/png', body: Buffer.from('BBBB') }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.equal(result.files.length, 2)
  assert.equal(result.files[0].filename, 'a.png')
  assert.equal(result.files[0].size, 3)
  assert.equal(result.files[1].filename, 'b.png')
  assert.equal(result.files[1].size, 4)
})

test('parseMultipartFields: rejects missing boundary in body', () => {
  assert.throws(() => parseMultipartFields(Buffer.from('garbage'), 'X'),
    /no boundary found/)
})

test('parseMultipartFields: rejects empty boundary param', () => {
  assert.throws(() => parseMultipartFields(Buffer.from('--X--'), ''),
    /missing boundary/)
})

test('parseMultipartFields: filename with semicolons inside quotes', () => {
  const boundary = 'X'
  const buf = buildBody(boundary, [
    {
      headers: 'Content-Disposition: form-data; name="image"; filename="photo; portrait.jpg"\r\nContent-Type: image/jpeg',
      body: Buffer.from('JPEGBYTES')
    }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].filename, 'photo; portrait.jpg')
  assert.equal(result.files[0].name, 'image')
})
