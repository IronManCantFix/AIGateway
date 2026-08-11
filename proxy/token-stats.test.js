import assert from 'node:assert/strict'
import test from 'node:test'

import { parseUsageFromResponse, normalizeUsage } from './token-usage.js'

test('parses OpenAI Chat non-streaming JSON usage', () => {
  const body = JSON.stringify({
    id: 'x',
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
  })
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150
  })
})

test('parses usage_total fallback for non-streaming responses', () => {
  const body = JSON.stringify({ usage_total: { prompt_tokens: 10, completion_tokens: 2 } })
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12
  })
})

test('parses OpenAI Chat streaming SSE usage from final chunk', () => {
  const body = [
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"a"}}]}',
    'data: {"id":"1","object":"chat.completion.chunk","choices":[]}',
    'data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":500,"completion_tokens":80,"total_tokens":580}}',
    'data: [DONE]'
  ].join('\n\n') + '\n\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 500,
    completion_tokens: 80,
    total_tokens: 580
  })
})

test('parses OpenAI Responses streaming usage from response.completed', () => {
  const body = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":999,"output_tokens":42,"total_tokens":1041}}}'
  ].join('\n\n') + '\n\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 999,
    completion_tokens: 42,
    total_tokens: 1041
  })
})

test('parses Anthropic streaming input from message_start (not zero)', () => {
  const body = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1234,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":56}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}'
  ].join('\n') + '\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 1234,
    completion_tokens: 56,
    total_tokens: 1290
  })
})

test('includes Anthropic cache tokens in prompt count', () => {
  const body = [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"output_tokens":0}}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}'
  ].join('\n\n') + '\n\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 600,
    completion_tokens: 50,
    total_tokens: 650
  })
})

test('parses Anthropic non-streaming JSON with cache tokens', () => {
  const body = JSON.stringify({
    id: 'm1',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 80, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 900 }
  })
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 1480,
    completion_tokens: 10,
    total_tokens: 1490
  })
})

test('takes cumulative output from last Anthropic message_delta', () => {
  const body = [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":50,"output_tokens":0}}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"more"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}'
  ].join('\n\n') + '\n\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 50,
    completion_tokens: 25,
    total_tokens: 75
  })
})

test('keeps prompt when a chunk only reports completion tokens', () => {
  const body = [
    'data: {"id":"1","choices":[{"delta":{"content":"a"}}]}',
    'data: {"id":"1","choices":[],"usage":{"completion_tokens":7}}'
  ].join('\n\n') + '\n\n'
  assert.deepEqual(parseUsageFromResponse(body), {
    prompt_tokens: 0,
    completion_tokens: 7,
    total_tokens: 7
  })
})

test('returns null when no usage present', () => {
  assert.equal(parseUsageFromResponse('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'), null)
  assert.equal(parseUsageFromResponse(JSON.stringify({ choices: [] })), null)
  assert.equal(parseUsageFromResponse(null), null)
  assert.equal(parseUsageFromResponse(''), null)
})

test('normalizeUsage handles OpenAI cached_tokens without double counting', () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 60 },
    total_tokens: 105
  }
  assert.deepEqual(normalizeUsage(usage), {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105
  })
})
