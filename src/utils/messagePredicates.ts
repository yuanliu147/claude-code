import type { Message, UserMessage } from '../types/message.js'

// tool_result 消息与人工回复共享 type:'user' 类型；区分点是可选的 toolUseResult 字段。
// 四个 PR (#23977, #24016, #24022, #24025) 独立修复了仅检查 type==='user' 导致的计数错误。
export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}
