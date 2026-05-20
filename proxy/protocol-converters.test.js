import assert from 'node:assert/strict'
import test from 'node:test'

import {
  convertChatToMessages,
  convertMessagesToChat,
  convertChatToResponses,
  convertResponsesToChat,
  getBodyConverter,
  convertResponsesToMessages,
  convertChatResponseToMessages,
  convertMessagesResponseToChat,
  convertChatResponseToResponses,
  convertResponsesResponseToChat,
  createSSEConverter
} from './protocol-converters.js'

function ssePayloads(output, prefix = 'data: ') {
  return output
    .split('\n')
    .filter(line => line.startsWith(prefix) && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(prefix.length)))
}

test('converts Chat Completions tool calls into Anthropic Messages blocks', () => {
  const result = convertChatToMessages({
    model: 'gpt-test',
    stream: false,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":22}' }
    ]
  })

  assert.equal(result.system, 'Be brief.')
  assert.equal(result.messages[1].role, 'assistant')
  assert.deepEqual(result.messages[1].content[1], {
    type: 'tool_use',
    id: 'call_1',
    name: 'get_weather',
    input: { city: 'Shanghai' }
  })
  assert.deepEqual(result.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '{"temp":22}'
  })
})

test('converts Anthropic Messages tool blocks back into Chat Completions messages', () => {
  const result = convertMessagesToChat({
    model: 'claude-test',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling a tool.' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'AIGateway' } }
      ]
    }]
  })

  assert.equal(result.messages[0].role, 'assistant')
  assert.equal(result.messages[0].content, 'Calling a tool.')
  assert.equal(result.messages[0].tool_calls[0].function.name, 'search')
  assert.equal(result.messages[0].tool_calls[0].function.arguments, '{"q":"AIGateway"}')
})

test('converts Chat input into Responses function_call items', () => {
  const result = convertChatToResponses({
    model: 'gpt-test',
    messages: [{
      role: 'assistant',
      content: 'Need a tool.',
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":7}' }
      }]
    }]
  })

  assert.equal(result.input[0].type, 'message')
  assert.deepEqual(result.input[1], {
    type: 'function_call',
    call_id: 'call_2',
    name: 'lookup',
    arguments: '{"id":7}'
  })
})

test('converts Responses input into Anthropic Messages tool_use blocks', () => {
  const result = convertResponsesToMessages({
    model: 'resp-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Use a tool.' }]
      },
      {
        type: 'function_call',
        call_id: 'call_3',
        name: 'lookup',
        arguments: '{"id":9}'
      }
    ]
  })

  assert.equal(result.messages[0].content, 'Use a tool.')
  assert.deepEqual(result.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_3',
    name: 'lookup',
    input: { id: 9 }
  })
})

test('converts non-streaming response bodies across formats with tool calls', () => {
  const anthropic = convertChatResponseToMessages({
    id: 'chatcmpl_1',
    model: 'gpt-test',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{
          id: 'call_4',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":4}' }
        }]
      }
    }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
  })

  assert.equal(anthropic.stop_reason, 'tool_use')
  assert.equal(anthropic.content[1].type, 'tool_use')

  const chat = convertMessagesResponseToChat(anthropic)
  assert.equal(chat.choices[0].finish_reason, 'tool_calls')
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'lookup')

  const chatFromResponses = convertResponsesResponseToChat({
    id: 'resp_1',
    status: 'completed',
    model: 'gpt-test',
    output: [{
      type: 'function_call',
      call_id: 'call_5',
      name: 'lookup',
      arguments: '{"id":5}'
    }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
  })
  assert.equal(chatFromResponses.choices[0].finish_reason, 'tool_calls')
  assert.equal(chatFromResponses.choices[0].message.tool_calls[0].id, 'call_5')
})

test('streams Anthropic Messages events into Chat Completions SSE chunks', () => {
  const convert = createSSEConverter('chat_completions', 'messages')
  const output = [
    convert('data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":1}}}'),
    convert('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}'),
    convert('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":1}"}}'),
    convert('data: {"type":"content_block_stop","index":0}'),
    convert('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}'),
    convert('data: {"type":"message_stop"}')
  ].join('')

  const chunks = ssePayloads(output)
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, 'lookup')
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.arguments, '{"id":1}')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
})

test('streams Anthropic Messages events into Responses function_call events', () => {
  const convert = createSSEConverter('responses', 'messages')
  const output = [
    convert('data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":1}}}'),
    convert('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"lookup","input":{}}}'),
    convert('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":2}"}}'),
    convert('data: {"type":"content_block_stop","index":0}'),
    convert('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}'),
    convert('data: {"type":"message_stop"}')
  ].join('')

  const events = ssePayloads(output)
  assert(events.some(e => e.type === 'response.output_item.added' && e.item.type === 'function_call'))
  assert(events.some(e => e.type === 'response.function_call_arguments.delta' && e.delta === '{"id":2}'))
  assert(events.some(e => e.type === 'response.completed' && e.response.output[0].type === 'function_call'))
})

// --- Regression: empty/null content should still produce valid output ---

test('response body converter produces valid output even with null content', () => {
  // Simulate upstream returning Chat Completions with content: null
  const result = convertChatResponseToResponses({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }
  })
  assert.ok(result.output, 'should have output array')
  assert.ok(result.output.length > 0, 'output should have at least one item (regression fix)')
  assert.strictEqual(result.output[0].type, 'message')
  assert.strictEqual(result.output[0].content[0].type, 'output_text')
})

test('response body converter produces valid output even with empty content string', () => {
  const result = convertChatResponseToResponses({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }
  })
  assert.ok(result.output.length > 0, 'output should have at least one item')
  assert.strictEqual(result.output[0].content[0].text, '')
})

test('reasoning_content survives round-trip via Responses metadata', () => {
  // Simulate: Chat response with reasoning_content + tool_calls -> Responses output -> Responses input -> Chat messages
  const chatResponse = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'mimo-test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Let me think about this step by step...',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
  }

  // Step 1: Chat -> Responses output
  const responsesOutput = convertChatResponseToResponses(chatResponse)
  assert.ok(responsesOutput.output.length >= 2, 'should have message + function_call items')

  // Step 2: Simulate Codex sending these items back as input
  const responsesInput = {
    model: 'mimo-test',
    input: [
      { type: 'message', role: 'user', content: 'What is the weather?' },
      // Previous output items sent back as input
      ...responsesOutput.output,
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp": 25}' },
      { type: 'message', role: 'user', content: 'Thanks!' }
    ],
    stream: false
  }

  // Step 3: Responses input -> Chat messages
  const chatBody = convertResponsesToChat(responsesInput)

  // The assistant message should have both reasoning_content and tool_calls
  const assistantMsg = chatBody.messages.find(m => m.tool_calls && m.tool_calls.length > 0)
  assert.ok(assistantMsg, 'should find assistant message with tool_calls')
  assert.strictEqual(assistantMsg.reasoning_content, 'Let me think about this step by step...', 'reasoning_content should be preserved')
})

test('Responses message reasoning_content is converted back to Chat messages', () => {
  const result = convertResponsesToChat({
    model: 'mimo-test',
    input: [
      { type: 'message', role: 'user', content: 'Use a tool.' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
        reasoning_content: 'Need to inspect the request before calling a tool.'
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' }
    ]
  })

  const assistantMsg = result.messages.find(m => m.role === 'assistant')
  assert.ok(assistantMsg, 'should include assistant history')
  assert.equal(assistantMsg.reasoning_content, 'Need to inspect the request before calling a tool.')
  assert.ok(assistantMsg.tool_calls, 'should merge following function_call into assistant history')
})

test('Responses reasoning item is converted to Chat reasoning_content before tool calls', () => {
  const result = convertResponsesToChat({
    model: 'mimo-test',
    input: [
      { type: 'message', role: 'user', content: 'Need a tool.' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Think before calling the tool.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' }
    ]
  })

  assert.equal(result.messages.some(m => m.type === 'reasoning'), false)
  const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.tool_calls)
  assert.ok(assistantMsg, 'should include assistant tool-call message')
  assert.equal(assistantMsg.reasoning_content, 'Think before calling the tool.')
})

test('Responses function_call without reasoning still emits Chat reasoning_content field', () => {
  const result = convertResponsesToChat({
    model: 'mimo-test',
    input: [
      { type: 'message', role: 'user', content: 'Need a tool.' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' }
    ]
  })

  const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.tool_calls)
  assert.ok(assistantMsg, 'should include assistant tool-call message')
  assert.equal(Object.hasOwn(assistantMsg, 'reasoning_content'), true)
  assert.equal(assistantMsg.reasoning_content, '')
})

test('Chat response to Responses exposes reasoning_content on output item', () => {
  const result = convertChatResponseToResponses({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'mimo-test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'Thinking that must be returned later.'
      },
      finish_reason: 'stop'
    }]
  })

  assert.equal(result.output[0].reasoning_content, 'Thinking that must be returned later.')
  assert.equal(result.output[0].metadata._reasoning_content, 'Thinking that must be returned later.')
})

test('Chat response to Responses preserves reasoning_content on function_call items', () => {
  const result = convertChatResponseToResponses({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'mimo-test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Thinking before tool call.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  })

  const callItem = result.output.find(o => o.type === 'function_call')
  assert.ok(callItem, 'should include function_call output item')
  assert.equal(callItem.reasoning_content, 'Thinking before tool call.')
  assert.equal(callItem.metadata._reasoning_content, 'Thinking before tool call.')
})

test('Responses to Responses preserves reasoning_content for thinking mode', () => {
  const convert = getBodyConverter('responses', 'responses')
  const result = convert({
    model: 'mimo-test',
    input: [
      { type: 'message', role: 'user', content: 'Hi' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need to think first.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working...' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' }
    ]
  })

  assert.equal(result.input[1].type, 'message')
  assert.equal(result.input[1].reasoning_content, 'Need to think first.')
  assert.equal(result.input[2].type, 'function_call')
  assert.equal(result.input[2].reasoning_content, 'Need to think first.')
  assert.equal(result.input[2].metadata._reasoning_content, 'Need to think first.')
})

test('convertResponsesToChat merges consecutive assistant messages', () => {
  // When a single Chat assistant message (reasoning + content + tool_calls) is split
  // into a message item + function_call items in Responses, the reverse conversion
  // should merge them back into one assistant message.
  const body = {
    model: 'test',
    input: [
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure' }], metadata: { _reasoning_content: 'thinking...' } },
      { type: 'function_call', call_id: 'fc_1', name: 'search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'fc_1', output: 'result' },
      { type: 'message', role: 'user', content: 'Thanks' }
    ]
  }

  const result = convertResponsesToChat(body)
  // Should NOT have consecutive assistant messages
  const assistantIndices = result.messages
    .map((m, i) => m.role === 'assistant' ? i : -1)
    .filter(i => i >= 0)
  // assistantIndices should have at most 1 entry (the merged one)
  assert.ok(assistantIndices.length <= 1, 'should merge consecutive assistant messages into one')
  if (assistantIndices.length === 1) {
    const msg = result.messages[assistantIndices[0]]
    assert.ok(msg.tool_calls, 'merged message should have tool_calls')
    assert.strictEqual(msg.reasoning_content, 'thinking...', 'merged message should preserve reasoning_content')
  }
})

test('Chat to Responses SSE flush always emits response.completed', () => {
  const convert = createSSEConverter('responses', 'chat_completions')
  let output = convert('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}')
  output += convert.flush()

  const events = ssePayloads(output)
  assert(events.some(e => e.type === 'response.created'))
  assert(events.some(e => e.type === 'response.completed'))
  const completed = events.find(e => e.type === 'response.completed')
  assert.ok(completed.response.output.length > 0)
})
