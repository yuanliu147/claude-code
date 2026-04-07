import { feature } from 'bun:bundle'
import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { analyzeContextUsage } from '../../utils/analyzeContext.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { renderToAnsiString } from '../../utils/staticRender.js'

/**
 * 应用与 query.ts 在 API 调用前相同的上下文转换，
 * 以便 /context 显示模型实际看到的内容，而不是 REPL 的原始
 * 历史记录。如果没有 projectView，token 计数会多计算被折叠的量
 * — 用户看到"180k，3 个 span 被折叠"，而 API 实际看到 120k。
 */
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages)
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectView } =
      require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view)
  }
  return view
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context

  const apiView = toApiView(messages)

  // 应用 microcompact 以获得发送到 API 的消息的准确表示
  const { messages: compactedMessages } = await microcompactMessages(apiView)

  // 获取终端宽度以进行响应式调整
  const terminalWidth = process.stdout.columns || 80

  const appState = getAppState()

  // 使用压缩后的消息分析上下文
  // 传递原始消息作为最后一个参数以准确提取 API 使用量
  const data = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    terminalWidth,
    context, // 传递完整上下文以计算系统提示
    undefined, // mainThreadAgentDefinition
    apiView, // 用于 API 使用量提取的原始消息
  )

  // 渲染为 ANSI 字符串以保留颜色，并像本地命令一样传递给 onDone
  const output = await renderToAnsiString(<ContextVisualization data={data} />)
  onDone(output)
  return null
}
