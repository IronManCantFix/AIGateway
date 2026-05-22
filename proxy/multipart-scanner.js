// proxy/multipart-scanner.js
// Zero-dependency multipart/form-data field scanner.
// Extracts non-file fields as text. File parts are NOT decoded — only metadata recorded.

const CRLF = Buffer.from('\r\n')
const DOUBLE_CRLF = Buffer.from('\r\n\r\n')

function parseHeaders(headerBlock) {
  const headers = {}
  const lines = headerBlock.toString('latin1').split('\r\n')
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    headers[name] = value
  }
  return headers
}

function parseContentDisposition(value) {
  if (!value) return {}
  const params = {}
  // Quote-aware split: only treat ';' as a delimiter outside "..." spans.
  const parts = []
  let token = ''
  let inQuotes = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '"') { inQuotes = !inQuotes; token += ch }
    else if (ch === ';' && !inQuotes) { parts.push(token.trim()); token = '' }
    else { token += ch }
  }
  if (token.trim()) parts.push(token.trim())
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim().toLowerCase()
    let v = part.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return params
}

/**
 * @param {Buffer} buf      Raw multipart body
 * @param {string} boundary Boundary string, unquoted (caller must strip any surrounding `"..."` from the Content-Type header value)
 */
export function parseMultipartFields(buf, boundary) {
  if (!Buffer.isBuffer(buf)) throw new Error('Bad multipart: body must be Buffer')
  if (!boundary) throw new Error('Bad multipart: missing boundary')

  const delim = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []

  let pos = buf.indexOf(delim)
  if (pos < 0) throw new Error('Bad multipart: no boundary found in body')

  while (pos < buf.length) {
    const partStart = pos + delim.length
    // Check terminator "--"
    if (buf[partStart] === 0x2d && buf[partStart + 1] === 0x2d) break
    // Skip CRLF after boundary
    let cursor = partStart
    if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2

    // Find end of headers
    const headersEnd = buf.indexOf(DOUBLE_CRLF, cursor)
    if (headersEnd < 0) throw new Error('Bad multipart: malformed body (no header terminator)')
    const headerBlock = buf.slice(cursor, headersEnd)
    const contentStart = headersEnd + DOUBLE_CRLF.length

    // Find next boundary
    const nextBoundary = buf.indexOf(delim, contentStart)
    if (nextBoundary < 0) throw new Error('Bad multipart: malformed body (no terminator)')
    // Content ends 2 bytes before next boundary (strip trailing CRLF)
    let contentEnd = nextBoundary
    if (buf[contentEnd - 2] === 0x0d && buf[contentEnd - 1] === 0x0a) contentEnd -= 2

    const headers = parseHeaders(headerBlock)
    const disp = parseContentDisposition(headers['content-disposition'])
    const name = disp.name
    if (name) {
      if (disp.filename !== undefined) {
        files.push({
          name,
          filename: disp.filename,
          contentType: headers['content-type'] || 'application/octet-stream',
          size: contentEnd - contentStart
        })
      } else {
        fields[name] = buf.slice(contentStart, contentEnd).toString('utf8')
      }
    }

    pos = nextBoundary
  }

  return { fields, files }
}
