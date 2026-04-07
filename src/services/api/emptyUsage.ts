import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

/**
 * 零初始化的 usage 对象。从 logging.ts 提取以便
 * bridge/replBridge.ts 可以导入它而无需传递性地拉入
 * api/errors.ts → utils/messages.ts → BashTool.tsx → 整个世界。
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
