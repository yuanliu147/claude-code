/**
 * 确定性的 Agent ID 系统
 *
 * 此模块提供用于格式化和解析在 swarm/teammate 系统中使用的确定性
 * agent ID 的辅助函数。
 *
 * ## ID 格式
 *
 * **Agent ID**：`agentName@teamName`
 * - 示例：`team-lead@my-project`、`researcher@my-project`
 * - @ 符号用作 agent 名称和团队名称之间的分隔符
 *
 * **请求 ID**：`{requestType}-{timestamp}@{agentId}`
 * - 示例：`shutdown-1702500000000@researcher@my-project`
 * - 用于关闭请求、计划批准等。
 *
 * ## 为什么使用确定性 ID？
 *
 * 确定性 ID 有几个好处：
 *
 * 1. **可重现性**：在同一团队中以相同名称生成的相同 agent
 *    总是获得相同的 ID，能够在崩溃/重启后重新连接。
 *
 * 2. **人类可读**：ID 有意义且可调试（例如 `tester@my-project`）。
 *
 * 3. **可预测**：团队负责人可以计算 teammate 的 ID 而无需查找，
 *    简化消息路由和任务分配。
 *
 * ## 约束
 *
 * - Agent 名称不得包含 `@`（它用作分隔符）
 * - 使用 `sanitizeAgentName()`（来自 TeammateTool.ts）从名称中剥离 @
 */

/**
 * 格式化 agent ID，格式为 `agentName@teamName`。
 */
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

/**
 * 将 agent ID 解析为其组成部分。
 * 如果 ID 不包含 @ 分隔符则返回 null。
 */
export function parseAgentId(
  agentId: string,
): { agentName: string; teamName: string } | null {
  const atIndex = agentId.indexOf('@')
  if (atIndex === -1) {
    return null
  }
  return {
    agentName: agentId.slice(0, atIndex),
    teamName: agentId.slice(atIndex + 1),
  }
}

/**
 * 格式化请求 ID，格式为 `{requestType}-{timestamp}@{agentId}`。
 */
export function generateRequestId(
  requestType: string,
  agentId: string,
): string {
  const timestamp = Date.now()
  return `${requestType}-${timestamp}@${agentId}`
}

/**
 * 将请求 ID 解析为其组成部分。
 * 如果请求 ID 不匹配预期格式则返回 null。
 */
export function parseRequestId(
  requestId: string,
): { requestType: string; timestamp: number; agentId: string } | null {
  const atIndex = requestId.indexOf('@')
  if (atIndex === -1) {
    return null
  }

  const prefix = requestId.slice(0, atIndex)
  const agentId = requestId.slice(atIndex + 1)

  const lastDashIndex = prefix.lastIndexOf('-')
  if (lastDashIndex === -1) {
    return null
  }

  const requestType = prefix.slice(0, lastDashIndex)
  const timestampStr = prefix.slice(lastDashIndex + 1)
  const timestamp = parseInt(timestampStr, 10)

  if (isNaN(timestamp)) {
    return null
  }

  return { requestType, timestamp, agentId }
}
