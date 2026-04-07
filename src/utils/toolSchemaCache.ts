import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

// 会话作用域的渲染工具 schema 缓存。工具 schema 在服务端位置 2 渲染（在系统提示之前），
// 所以任何字节级更改都会使整个约 11K token 的工具块及所有下游内容失效。
// GrowthBook 门控切换（tengu_tool_pear、tengu_fgts）、MCP 重连或
// tool.prompt() 中的动态内容都会导致这种变动。按会话记忆化可以锁定首次渲染时的 schema 字节
// — 会话中期的 GB 刷新不再使缓存失效。
//
// 放在叶子模块中，以便 auth.ts 可以在不导入 api.ts 的情况下清除它
//（否则会通过 plans→settings→file→growthbook→config→
// bridgeEnabled→auth 形成循环）。
type CachedSchema = BetaTool & {
  strict?: boolean
  eager_input_streaming?: boolean
}

const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
