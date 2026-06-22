# 负载均衡功能设计方案

## Context

当前 AIGateway 的模型路由逻辑是"首个匹配"：代理遍历活跃 profile 列表，找到第一个 `models` 包含请求模型的 profile 就直接转发。当用户有多个提供商提供相同模型时（比如两个 OpenAI 兼容服务都有 `gpt-4o`），无法做负载分配或故障转移。

用户需要两种策略：
- **轮询 (Round Robin)**：请求轮流分配到不同提供商
- **故障转移 (Failover)**：按优先级依次尝试，第一个失败时自动切换到下一个

## 数据模型

在 `config.rs` 中新增 `LoadBalancerGroup` 结构体，配置存储到 `load-balancer.json`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadBalancerGroup {
    #[serde(default)]
    pub id: String,                    // UUID
    pub name: String,                  // 用户可见名称
    #[serde(rename = "strategy")]
    pub strategy: String,              // "round-robin" | "failover"
    #[serde(rename = "profileIds")]
    pub profile_ids: Vec<String>,      // 参与负载的 profile ID 列表（有序）
}
```

JSON 示例：
```json
{
  "groups": [
    {
      "id": "lb-xxx",
      "name": "GPT-4o 双线",
      "strategy": "round-robin",
      "profileIds": ["profile-a", "profile-b"]
    }
  ]
}
```

## 代理层路由逻辑改造 (proxy-server.js)

### 核心变更：`handleApiRequest` 中的模型路由部分（约 703-736 行）

当前逻辑：
```
遍历 profiles → 找到第一个 models 包含 requestedModel 的 profile → 直接转发
```

改为：
```
1. 检查 requestedModel 是否属于某个 loadBalancerGroup
2. 如果是：
   a. round-robin：用内存计数器选下一个 profile
   b. failover：按 profileIds 顺序依次尝试
3. 如果不是：保持现有的首个匹配逻辑
```

### Round Robin 实现

```javascript
// 内存状态
let rrCounters = {}  // groupId → counter

function selectRoundRobin(group) {
  const idx = (rrCounters[group.id] || 0) % group.profileIds.length
  rrCounters[group.id] = idx + 1
  return group.profileIds[idx]
}
```

### Failover 实现

```javascript
async function tryFailover(group, clientReq, clientRes, ...) {
  for (const profileId of group.profileIds) {
    const profile = findProfileById(profileId)
    if (!profile) continue
    try {
      // 尝试转发，如果上游返回 4xx/5xx 则尝试下一个
      const success = await forwardWithCheck(clientReq, clientRes, profile, ...)
      if (success) return
    } catch (e) {
      continue  // 连接失败，尝试下一个
    }
  }
  // 所有都失败了
  clientRes.writeHead(502, ...)
  clientRes.end(JSON.stringify({ error: 'All upstream providers failed' }))
}
```

**Failover 关键约束**：
- 仅在上游返回 HTTP 错误（4xx/5xx）或连接失败时触发重试
- SSE 流一旦开始写入 clientRes，不能再切换提供商（headers 已发送）
- 非流式请求可以完整重试
- 流式请求：如果上游返回非 SSE 响应（如 502 JSON），可以重试；如果已经开始流式传输数据，则不能重试

### 路由匹配逻辑

```javascript
// 1. 先检查 load balancer groups
let lbGroup = null
if (requestedModel && currentConfig.loadBalancerGroups) {
  for (const group of currentConfig.loadBalancerGroups) {
    for (const pid of group.profileIds) {
      const p = currentConfig.profiles.find(pr => pr.id === pid)
      if (p && Array.isArray(p.models) && p.models.includes(requestedModel)) {
        lbGroup = group
        break
      }
    }
    if (lbGroup) break
  }
}

// 2. 如果命中 load balancer group
if (lbGroup) {
  if (lbGroup.strategy === 'round-robin') {
    const selectedId = selectRoundRobin(lbGroup)
    profile = currentConfig.profiles.find(p => p.id === selectedId)
    // 继续正常转发流程
  } else if (lbGroup.strategy === 'failover') {
    // failover 逻辑在 forward 层面实现
    await handleFailoverRequest(lbGroup, req, res, ...)
    return
  }
} else {
  // 3. 保持现有逻辑：首个匹配
  for (const p of currentConfig.profiles) { ... }
}
```

## 配置传递链路

```
UI → api.js → Tauri commands → config.rs (save to load-balancer.json)
                                       ↓
                              build_proxy_config() 新增 loadBalancerGroups 字段
                                       ↓
                              proxy.rs reload → proxy-server.js currentConfig
```

### config.rs 变更

1. 新增 `LoadBalancerGroup` 结构体
2. 新增 CRUD 方法：`get_lb_groups()`, `add_lb_group()`, `update_lb_group()`, `delete_lb_group()`
3. `build_proxy_config()` 中添加 `loadBalancerGroups` 字段

### commands.rs 变更

新增 Tauri 命令：
- `get_lb_groups` → `Vec<LoadBalancerGroup>`
- `add_lb_group(group)` → `LoadBalancerGroup`
- `update_lb_group(id, updates)` → `LoadBalancerGroup`
- `delete_lb_group(id)` → `()`

### api.js 变更

```javascript
getLBGroups: () => invoke('get_lb_groups'),
addLBGroup: (group) => invoke('add_lb_group', { group }),
updateLBGroup: (id, updates) => invoke('update_lb_group', { id, updates }),
deleteLBGroup: (id) => invoke('delete_lb_group', { id }),
```

## UI 设计

在 Home 页面的"模型映射"区域下方，新增"负载均衡"折叠面板：

```
┌─────────────────────────────────────┐
│ ⚖️ 负载均衡                    [展开] │
├─────────────────────────────────────┤
│ [创建负载均衡组]                      │
│                                     │
│ ┌─ GPT-4o 双线 ─── 轮询 ──────────┐ │
│ │  Profile A (OpenAI)    ↑ ↓ ×    │ │
│ │  Profile B (OpenAI)    ↑ ↓ ×    │ │
│ └──────────────────────────────────┘ │
│                                     │
│ ┌─ Claude 故障转移 ── 故障转移 ────┐ │
│ │  Profile C (Anthropic)  ↑ ↓ ×   │ │
│ │  Profile D (Anthropic)  ↑ ↓ ×   │ │
│ └──────────────────────────────────┘ │
└─────────────────────────────────────┘
```

创建/编辑弹窗：
- 名称输入
- 策略选择（轮询 / 故障转移）
- Profile 多选（仅显示有模型的活跃 profile）
- 拖拽排序（故障转移策略下决定优先级）

### i18n

在 `zh-CN.json` 和 `en-US.json` 中添加 `home.lb.*` 系列翻译键。

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `src-tauri/src/config.rs` | 新增 `LoadBalancerGroup` 结构体 + CRUD + `build_proxy_config()` |
| `src-tauri/src/commands.rs` | 新增 4 个 Tauri 命令 |
| `proxy/proxy-server.js` | 路由逻辑改造 + round-robin 计数器 + failover 重试 |
| `src/api.js` | 新增 4 个 API 方法 |
| `src/pages/Home/index.vue` | 新增负载均衡 UI 面板 |
| `src/i18n/locales/zh-CN.json` | 中文翻译 |
| `src/i18n/locales/en-US.json` | 英文翻译 |

## 验证方式

1. 创建两个 profile（相同 providerType，相同模型如 `gpt-4o`），分别指向不同上游
2. 创建负载均衡组，策略选"轮询"，关联这两个 profile
3. 用 curl 连续发 4 次请求到 `localhost:9999/v1/chat/completions`，model=gpt-4o
4. 检查日志确认请求交替分配到两个 profile
5. 改为"故障转移"策略，将第一个 profile 的 baseUrl 改为无效地址
6. 发请求，确认自动 fallback 到第二个 profile 并返回成功
