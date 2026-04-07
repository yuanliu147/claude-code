/**
 * Session Memory 工具函数，可以导入而无需循环依赖。
 * 与主 sessionMemory.ts 分开以避免导入 runAgent。
 */

import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sleep } from '../../utils/sleep.js'
import { logEvent } from '../analytics/index.js'

const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000 // 1 分钟

/**
 * session memory 提取阈值的配置
 */
export type SessionMemoryConfig = {
  /** 初始化 session memory 前的最小上下文窗口 token 数。
   * 使用与 autocompact 相同的 token 计数（input + output + cache tokens）
   * 以确保两个功能之间的一致行为。 */
  minimumMessageTokensToInit: number
  /** session memory 更新之间的最小上下文窗口增长（以 token 为单位）。
   * 使用与 autocompact 相同的 token 计数（tokenCountWithEstimation）
   * 来测量实际上下文增长，而非累积 API 使用量。 */
  minimumTokensBetweenUpdate: number
  /** session memory 更新之间的工具调用次数 */
  toolCallsBetweenUpdates: number
}

// 默认配置值
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}

// 当前 session memory 配置
let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
}

// 跟踪最后总结的消息 ID（共享状态）
let lastSummarizedMessageId: string | undefined

// 跟踪提取状态和时间戳（由 sessionMemory.ts 设置）
let extractionStartedAt: number | undefined

// 跟踪上次记忆提取时的上下文大小（用于 minimumTokensBetweenUpdate）
let tokensAtLastExtraction = 0

// 跟踪 session memory 是否已初始化（达到 minimumMessageTokensToInit）
let sessionMemoryInitialized = false

/**
 * 获取 session memory 当前更新到的消息 ID
 */
export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

/**
 * 设置最后总结的消息 ID（从 sessionMemory.ts 调用）
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
): void {
  lastSummarizedMessageId = messageId
}

/**
 * 将提取标记为已开始（从 sessionMemory.ts 调用）
 */
export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

/**
 * 将提取标记为已完成（从 sessionMemory.ts 调用）
 */
export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

/**
 * 等待任何进行中的 session memory 提取完成（15 秒超时）
 * 如果没有提取在进行中或提取已过时（>1 分钟前），立即返回。
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      // 提取已过时，不等待
      return
    }

    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      // 超时 — 无论如何都继续
      return
    }

    await sleep(1000)
  }
}

/**
 * 获取当前 session memory 内容
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  const memoryPath = getSessionMemoryPath()

  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' })

    logEvent('tengu_session_memory_loaded', {
      content_length: content.length,
    })

    return content
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * 设置 session memory 配置
 */
export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>,
): void {
  sessionMemoryConfig = {
    ...sessionMemoryConfig,
    ...config,
  }
}

/**
 * 获取当前 session memory 配置
 */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

/**
 * 记录提取时的上下文大小。
 * 用于测量 minimumTokensBetweenUpdate 阈值的上下文增长。
 */
export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

/**
 * 检查 session memory 是否已初始化（达到 minimumTokensToInit 阈值）
 */
export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

/**
 * 将 session memory 标记为已初始化
 */
export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

/**
 * 检查是否已达到初始化 session memory 的阈值。
 * 使用总上下文窗口 token（与 autocompact 相同）以保持行为一致。
 */
export function hasMetInitializationThreshold(
  currentTokenCount: number,
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

/**
 * 检查是否已达到下次更新的阈值。
 * 测量自上次提取以来的实际上下文窗口增长
 *（与 autocompact 和初始化阈值相同的指标）。
 */
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return (
    tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
  )
}

/**
 * 获取配置的更新之间的工具调用次数
 */
export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * 重置 session memory 状态（用于测试）
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  tokensAtLastExtraction = 0
  sessionMemoryInitialized = false
  lastSummarizedMessageId = undefined
  extractionStartedAt = undefined
}
