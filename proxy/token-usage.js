// token usage 解析工具：把上游各类 usage 格式归一化为统一结构。
// 独立成模块以便单元测试，避免加载整个代理服务器。

// - OpenAI Chat:  prompt_tokens / completion_tokens / total_tokens
// - OpenAI Responses: input_tokens / output_tokens / total_tokens
// - Anthropic: input_tokens / output_tokens，缓存 token 在独立字段中，需额外计入
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  let prompt = usage.prompt_tokens || usage.input_tokens || 0
  let completion = usage.completion_tokens || usage.output_tokens || 0
  // Anthropic prompt caching：input_tokens 只含非缓存部分，
  // cache_creation_input_tokens / cache_read_input_tokens 需额外计入。
  // OpenAI 系的 cached_tokens 已包含在 prompt_tokens/input_tokens 中，不重复加。
  prompt += usage.cache_creation_input_tokens || 0
  prompt += usage.cache_read_input_tokens || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens || (prompt + completion)
  }
}

// 从上游响应体解析 token usage，支持非流式 JSON 与 SSE 流式两种格式。
// 流式按事件顺序聚合：Anthropic message_start 提供输入、message_delta 提供
// 累计输出，OpenAI 兼容格式的 usage 通常出现在最后一个 chunk，直接覆盖。
export function parseUsageFromResponse(responseBody) {
  if (!responseBody) return null
  // 非流式 JSON 响应
  try {
    const parsed = JSON.parse(responseBody)
    return normalizeUsage(parsed.usage || parsed.usage_total)
  } catch {
    // SSE 流式：逐事件解析，聚合输入与输出
    let inputTokens = 0
    let outputTokens = 0
    const applyUsage = (u) => {
      if (!u || typeof u !== 'object') return
      if (u.prompt_tokens != null) inputTokens = u.prompt_tokens || 0
      if (u.input_tokens != null) inputTokens = u.input_tokens || 0
      if (u.completion_tokens != null) outputTokens = u.completion_tokens || 0
      if (u.output_tokens != null) outputTokens = u.output_tokens || 0
      // 部分中转会把 Anthropic 缓存字段透传在 OpenAI 格式 usage 中
      inputTokens += u.cache_creation_input_tokens || 0
      inputTokens += u.cache_read_input_tokens || 0
    }
    for (const rawLine of responseBody.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      let parsed
      try {
        parsed = JSON.parse(line.slice(6))
      } catch {
        continue
      }
      // Anthropic message_start：输入 token（含缓存命中/创建）
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        const u = parsed.message.usage
        inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
        continue
      }
      // Anthropic message_delta：output_tokens 为流内累计值
      if (parsed.type === 'message_delta' && parsed.usage) {
        if (parsed.usage.output_tokens != null) outputTokens = parsed.usage.output_tokens || 0
        continue
      }
      // OpenAI Chat 流式 chunk：usage 一般为累计值，直接覆盖
      applyUsage(parsed.usage)
      // OpenAI Responses 流式事件：usage 在 response.usage 内
      applyUsage(parsed.response?.usage)
    }
    if (inputTokens > 0 || outputTokens > 0) {
      return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
    }
    return null
  }
}
