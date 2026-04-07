import { randomBytes, type UUID } from 'crypto'
import type { AgentId } from 'src/types/ids.js'

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 验证 uuid
 * @param maybeUUID 要检查是否为 uuid 的值
 * @returns 如果有效则返回 string as UUID，否则返回 null
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  // UUID 格式：8-4-4-4-12 十六进制数字
  if (typeof maybeUuid !== 'string') return null

  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * Generate a new agent ID with prefix for consistency with task IDs.
 * Format: a{label-}{16 hex chars}
 * Example: aa3f2c1b4d5e6f7a8, acompact-a3f2c1b4d5e6f7a8
 */
export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  return (label ? `a${label}-${suffix}` : `a${suffix}`) as AgentId
}
