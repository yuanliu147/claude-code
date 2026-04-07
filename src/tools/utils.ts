import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'

/**
 * 用 sourceToolUseID 标记用户消息，以便它们在工具解决之前保持瞬态。
 * 这防止 UI 中重复显示"正在运行"消息。
 */
export function tagMessagesWithToolUseID(
  messages: (UserMessage | AttachmentMessage | SystemMessage)[],
  toolUseID: string | undefined,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  if (!toolUseID) {
    return messages
  }
  return messages.map(m => {
    if (m.type === 'user') {
      return { ...m, sourceToolUseID: toolUseID }
    }
    return m
  })
}

/**
 * 从父消息中提取给定工具名称的工具使用 ID。
 */
export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  const toolUseBlock = Array.isArray(parentMessage.message.content) ? parentMessage.message.content.find(
    block => block.type === 'tool_use' && block.name === toolName,
  ) : undefined
  return toolUseBlock && toolUseBlock.type === 'tool_use'
    ? toolUseBlock.id
    : undefined
}
