/**
 * 协调器模式下子代理的周期性后台摘要生成。
 *
 * 每隔约 30 秒使用 runForkedAgent() 分叉子代理的对话，
 * 生成 1-2 句进度摘要。摘要存储在 AgentProgress 中用于 UI 显示。
 *
 * 缓存共享：使用与父代理相同的 CacheSafeParams 来共享提示词缓存。
 * 工具保留在请求中以匹配缓存键，但通过 canUseTool 回调拒绝使用。
 */

import type { TaskContext } from '../../Task.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

const SUMMARY_INTERVAL_MS = 30_000

function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : ''

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

export function startAgentSummarization(
  taskId: string,
  agentId: AgentId,
  cacheSafeParams: CacheSafeParams,
  setAppState: TaskContext['setAppState'],
): { stop: () => void } {
  // 从闭包中移除 forkContextMessages — runSummary 每次 tick 都会从
  // getAgentTranscript() 重新构建。没有这个，原始的分叉消息
  // （从 AgentTool.tsx 传入）会被定时器生命周期固定住。
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  let summaryAbortController: AbortController | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let previousSummary: string | null = null

  async function runSummary(): Promise<void> {
    if (stopped) return

    logForDebugging(`[AgentSummary] Timer fired for agent ${agentId}`)

    try {
      // 从 transcript 读取当前消息
      const transcript = await getAgentTranscript(agentId)
      if (!transcript || transcript.messages.length < 3) {
        // 上下文不足 — finally 块会安排下次重试
        logForDebugging(
          `[AgentSummary] Skipping summary for ${taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        )
        return
      }

      // 过滤以获得干净的消息状态
      const cleanMessages = filterIncompleteToolCalls(transcript.messages)

      // 使用当前消息构建分叉参数
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      }

      logForDebugging(
        `[AgentSummary] Forking for summary, ${cleanMessages.length} messages in context`,
      )

      // 为本次摘要创建中止控制器
      summaryAbortController = new AbortController()

      // 通过回调拒绝工具，而不是传递 tools:[] — 那会破坏缓存
      const canUseTool = async () => ({
        behavior: 'deny' as const,
        message: 'No tools needed for summary',
        decisionReason: { type: 'other' as const, reason: 'summary only' },
      })

      // 不要在这里设置 maxOutputTokens。分叉通过发送相同的缓存键参数
      // （system、tools、model、messages 前缀、thinking 配置）来搭主线程
      // 提示词缓存的便车。设置 maxOutputTokens 会限制 budget_tokens，
      // 导致 thinking 配置不匹配而使缓存失效。
      //
      // ContentReplacementState 在 createSubagentContext 中默认从
      // forkParams.toolUseContext（子代理在 onCacheSafeParams 时捕获的
      // 实时状态）克隆。无需显式覆盖。
      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool,
        querySource: 'agent_summary',
        forkLabel: 'agent_summary',
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,
      })

      if (stopped) return

      // 从结果中提取摘要文本
      for (const msg of result.messages) {
        if (msg.type !== 'assistant') continue
        // 跳过 API 错误消息
        if (msg.isApiErrorMessage) {
          logForDebugging(
            `[AgentSummary] Skipping API error message for ${taskId}`,
          )
          continue
        }
        const contentArr = Array.isArray(msg.message.content) ? msg.message.content : []
        const textBlock = contentArr.find(b => b.type === 'text')
        if (textBlock?.type === 'text' && textBlock.text.trim()) {
          const summaryText = textBlock.text.trim()
          logForDebugging(
            `[AgentSummary] Summary result for ${taskId}: ${summaryText}`,
          )
          previousSummary = summaryText
          updateAgentSummary(taskId, summaryText, setAppState)
          break
        }
      }
    } catch (e) {
      if (!stopped && e instanceof Error) {
        logError(e)
      }
    } finally {
      summaryAbortController = null
      // 在完成时（而非启动时）重置计时器，以防止摘要重叠
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS)
  }

  function stop(): void {
    logForDebugging(`[AgentSummary] Stopping summarization for ${taskId}`)
    stopped = true
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  // 启动第一个计时器
  scheduleNext()

  return { stop }
}
