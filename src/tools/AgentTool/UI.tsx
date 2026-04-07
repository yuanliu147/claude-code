import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { ConfigurableShortcutHint } from 'src/components/ConfigurableShortcutHint.js'
import {
  CtrlOToExpand,
  SubAgentProvider,
} from 'src/components/CtrlOToExpand.js'
import { Byline, KeyboardShortcutHint } from '@anthropic/ink'
import type { z } from 'zod/v4'
import { AgentProgressLine } from '../../components/AgentProgressLine.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { Markdown } from '../../components/Markdown.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolUseLoader } from '../../components/ToolUseLoader.js'
import { Box, Text } from '@anthropic/ink'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { findToolByName, type Tools } from '../../Tool.js'
import type { Message, ProgressMessage } from '../../types/message.js'
import type { AgentToolProgress } from '../../types/tools.js'
import { count } from '../../utils/array.js'
import {
  getSearchOrReadFromContent,
  getSearchReadSummaryText,
} from '../../utils/collapseReadSearch.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import {
  buildSubagentLookups,
  createAssistantMessage,
  EMPTY_LOOKUPS,
} from '../../utils/messages.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
  renderModelName,
} from '../../utils/model/model.js'
import type { Theme, ThemeName } from '../../utils/theme.js'
import type {
  outputSchema,
  Progress,
  RemoteLaunchedOutput,
} from './AgentTool.js'
import { inputSchema } from './AgentTool.js'
import { getAgentColor } from './agentColorManager.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const MAX_PROGRESS_MESSAGES_TO_SHOW = 3

/**
 * 守卫：检查进度数据是否有 `message` 字段（agent_progress 或
 * skill_progress）。其他进度类型（例如从子代理转发的 bash_progress）
 * 缺少此字段，必须被 UI 帮助函数跳过。
 */
function hasProgressMessage(data: Progress): data is AgentToolProgress {
  if (!('message' in data)) {
    return false
  }
  const msg = (data as AgentToolProgress).message
  return msg != null && typeof msg === 'object' && 'type' in msg
}

/**
 * 检查进度消息是否是搜索/读取/REPL 操作（工具调用或结果）。
 * 如果是可折叠操作，返回 { isSearch, isRead, isREPL }，否则返回 null。
 *
 * 对于 tool_result 消息，使用提供的 `toolUseByID` map 查找
 * 对应的 tool_use 块，而不是依赖 `normalizedMessages`。
 */
function getSearchOrReadInfo(
  progressMessage: ProgressMessage<Progress>,
  tools: Tools,
  toolUseByID: Map<string, ToolUseBlockParam>,
): { isSearch: boolean; isRead: boolean; isREPL: boolean } | null {
  if (!hasProgressMessage(progressMessage.data)) {
    return null
  }
  const message = progressMessage.data.message

  // Check tool_use (assistant message)
  if (message.type === 'assistant') {
    return getSearchOrReadFromContent(message.message.content[0], tools)
  }

  // Check tool_result (user message) - find corresponding tool use from the map
  if (message.type === 'user') {
    const content = message.message.content[0]
    if (content?.type === 'tool_result') {
      const toolUse = toolUseByID.get(content.tool_use_id)
      if (toolUse) {
        return getSearchOrReadFromContent(toolUse, tools)
      }
    }
  }

  return null
}

type SummaryMessage = {
  type: 'summary'
  searchCount: number
  readCount: number
  replCount: number
  uuid: string
  isActive: boolean // 如果仍在进行中则为 true（最后一条消息是 tool_use，而不是 tool_result）
}

type ProcessedMessage =
  | { type: 'original'; message: ProgressMessage<AgentToolProgress> }
  | SummaryMessage

/**
 * 处理进度消息以将连续的搜索/读取操作分组为摘要。
 * 仅适用于 ant - 对非 ant 返回原始消息。
 * @param isAgentRunning - 如果为 true，最后一组始终标记为活动（进行中）
 */
function processProgressMessages(
  messages: ProgressMessage<Progress>[],
  tools: Tools,
  isAgentRunning: boolean,
): ProcessedMessage[] {
  // Only process for ants
  if ("external" !== 'ant') {
    return messages
      .filter(
        (m): m is ProgressMessage<AgentToolProgress> =>
          hasProgressMessage(m.data) && m.data.message.type !== 'user',
      )
      .map(m => ({ type: 'original', message: m }))
  }

  const result: ProcessedMessage[] = []
  let currentGroup: {
    searchCount: number
    readCount: number
    replCount: number
    startUuid: string
  } | null = null

  function flushGroup(isActive: boolean): void {
    if (
      currentGroup &&
      (currentGroup.searchCount > 0 ||
        currentGroup.readCount > 0 ||
        currentGroup.replCount > 0)
    ) {
      result.push({
        type: 'summary',
        searchCount: currentGroup.searchCount,
        readCount: currentGroup.readCount,
        replCount: currentGroup.replCount,
        uuid: `summary-${currentGroup.startUuid}`,
        isActive,
      })
    }
    currentGroup = null
  }

  const agentMessages = messages.filter(
    (m): m is ProgressMessage<AgentToolProgress> => hasProgressMessage(m.data),
  )

  // 构建 tool_use 查询表，随迭代递增
  const toolUseByID = new Map<string, ToolUseBlockParam>()
  for (const msg of agentMessages) {
    // Track tool_use blocks as we see them
    if (msg.data.message.type === 'assistant') {
      for (const c of msg.data.message.message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam)
        }
      }
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID)

    if (info && (info.isSearch || info.isRead || info.isREPL)) {
      // 这是搜索/读取/REPL 操作 - 添加到当前组
      if (!currentGroup) {
        currentGroup = {
          searchCount: 0,
          readCount: 0,
          replCount: 0,
          startUuid: msg.uuid,
        }
      }
      // Only count tool_result messages (not tool_use) to avoid double counting
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          currentGroup.searchCount++
        } else if (info.isREPL) {
          currentGroup.replCount++
        } else if (info.isRead) {
          currentGroup.readCount++
        }
      }
    } else {
      // 非搜索/读取/REPL 消息 - 刷新当前组（完成）并添加此消息
      flushGroup(false)
      // 跳过用户 tool_result 消息 —— 子代理进度消息缺少
      // toolUseResult，所以 UserToolSuccessMessage 返回 null，而
      // renderToolUseProgressMessage 中 height=1 的 Box 显示为空白行。
      if (msg.data.message.type !== 'user') {
        result.push({ type: 'original', message: msg })
      }
    }
  }

  // Flush any remaining group - it's active if the agent is still running
  flushGroup(isAgentRunning)

  return result
}

const ESTIMATED_LINES_PER_TOOL = 9
const TERMINAL_BUFFER_LINES = 7

type Output = z.input<ReturnType<typeof outputSchema>>

export function AgentPromptDisplay({
  prompt,
  dim: _dim = false,
}: {
  prompt: string
  theme?: ThemeName // 已弃用，为兼容性保留 - Markdown 在内部使用 useTheme
  dim?: boolean // 已弃用，为兼容性保留 - dimColor 无法应用于 Box（Markdown 返回 Box）
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="success" bold>
        Prompt:
      </Text>
      <Box paddingLeft={2}>
        <Markdown>{prompt}</Markdown>
      </Box>
    </Box>
  )
}

export function AgentResponseDisplay({
  content,
}: {
  content: { type: string; text: string }[]
  theme?: ThemeName // deprecated, kept for compatibility - Markdown uses useTheme internally
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="success" bold>
        Response:
      </Text>
      {content.map((block: { type: string; text: string }, index: number) => (
        <Box key={index} paddingLeft={2} marginTop={index === 0 ? 0 : 1}>
          <Markdown>{block.text}</Markdown>
        </Box>
      ))}
    </Box>
  )
}

type VerboseAgentTranscriptProps = {
  progressMessages: ProgressMessage<Progress>[]
  tools: Tools
  verbose: boolean
}

function VerboseAgentTranscript({
  progressMessages,
  tools,
  verbose,
}: VerboseAgentTranscriptProps): React.ReactNode {
  const { lookups: agentLookups, inProgressToolUseIDs } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )

  // Filter out user tool_result messages that lack toolUseResult.
  // Subagent progress messages don't carry the parsed tool output,
  // so UserToolSuccessMessage returns null and MessageResponse renders
  // a bare ⎿ with no content.
  const filteredMessages = progressMessages.filter(
    (pm): pm is ProgressMessage<AgentToolProgress> => {
      if (!hasProgressMessage(pm.data)) {
        return false
      }
      const msg = pm.data.message
      if (msg.type === 'user' && msg.toolUseResult === undefined) {
        return false
      }
      return true
    },
  )

  return (
    <>
      {filteredMessages.map(progressMessage => (
        <MessageResponse key={progressMessage.uuid} height={1}>
          <MessageComponent
            message={progressMessage.data.message}
            lookups={agentLookups}
            addMargin={false}
            tools={tools}
            commands={[]}
            verbose={verbose}
            inProgressToolUseIDs={inProgressToolUseIDs}
            progressMessagesForMessage={[]}
            shouldAnimate={false}
            shouldShowDot={false}
            isTranscriptMode={false}
            isStatic={true}
          />
        </MessageResponse>
      ))}
    </>
  )
}

export function renderToolResultMessage(
  data: Output,
  progressMessagesForMessage: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    theme,
    isTranscriptMode = false,
  }: {
    tools: Tools
    verbose: boolean
    theme: ThemeName
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  // 远程启动的代理（仅限 ant）使用不在公共 schema 中的私有输出类型。
  // 通过内部判别式收窄。
  const internal = data as Output | RemoteLaunchedOutput
  if (internal.status === 'remote_launched') {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Remote agent launched{' '}
            <Text dimColor>
              · {internal.taskId} · {internal.sessionUrl}
            </Text>
          </Text>
        </MessageResponse>
      </Box>
    )
  }
  if (data.status === 'async_launched') {
    const { prompt } = data
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Backgrounded agent
            {!isTranscriptMode && (
              <Text dimColor>
                {' ('}
                <Byline>
                  <KeyboardShortcutHint shortcut="↓" action="manage" />
                  {prompt && (
                    <ConfigurableShortcutHint
                      action="app:toggleTranscript"
                      context="Global"
                      fallback="ctrl+o"
                      description="expand"
                    />
                  )}
                </Byline>
                {')'}
              </Text>
            )}
          </Text>
        </MessageResponse>
        {isTranscriptMode && prompt && (
          <MessageResponse>
            <AgentPromptDisplay prompt={prompt} theme={theme} />
          </MessageResponse>
        )}
      </Box>
    )
  }

  if (data.status !== 'completed') {
    return null
  }

  const {
    agentId,
    totalDurationMs,
    totalToolUseCount,
    totalTokens,
    usage,
    content,
    prompt,
  } = data
  const result = [
    totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`,
    formatNumber(totalTokens) + ' tokens',
    formatDuration(totalDurationMs),
  ]

  const completionMessage = `Done (${result.join(' · ')})`

  const finalAssistantMessage = createAssistantMessage({
    content: completionMessage,
    usage: { ...usage, inference_geo: null, iterations: null, speed: null },
  })

  return (
    <Box flexDirection="column">
      {process.env.USER_TYPE === 'ant' && (
        <MessageResponse>
          <Text color="warning">
            [ANT-ONLY] API calls: {getDisplayPath(getDumpPromptsPath(agentId))}
          </Text>
        </MessageResponse>
      )}
      {isTranscriptMode && prompt && (
        <MessageResponse>
          <AgentPromptDisplay prompt={prompt} theme={theme} />
        </MessageResponse>
      )}
      {isTranscriptMode ? (
        <SubAgentProvider>
          <VerboseAgentTranscript
            progressMessages={progressMessagesForMessage}
            tools={tools}
            verbose={verbose}
          />
        </SubAgentProvider>
      ) : null}
      {isTranscriptMode && content && content.length > 0 && (
        <MessageResponse>
          <AgentResponseDisplay content={content} theme={theme} />
        </MessageResponse>
      )}
      <MessageResponse height={1}>
        <MessageComponent
          message={finalAssistantMessage}
          lookups={EMPTY_LOOKUPS}
          addMargin={false}
          tools={tools}
          commands={[]}
          verbose={verbose}
          inProgressToolUseIDs={new Set()}
          progressMessagesForMessage={[]}
          shouldAnimate={false}
          shouldShowDot={false}
          isTranscriptMode={false}
          isStatic={true}
        />
      </MessageResponse>
      {!isTranscriptMode && (
        <Text dimColor>
          {'  '}
          <CtrlOToExpand />
        </Text>
      )}
    </Box>
  )
}

export function renderToolUseMessage({
  description,
  prompt,
}: Partial<{
  description: string
  prompt: string
}>): React.ReactNode {
  if (!description || !prompt) {
    return null
  }
  return description
}

export function renderToolUseTag(
  input: Partial<{
    description: string
    prompt: string
    subagent_type: string
    model?: ModelAlias
  }>,
): React.ReactNode {
  const tags: React.ReactNode[] = []

  if (input.model) {
    const mainModel = getMainLoopModel()
    const agentModel = parseUserSpecifiedModel(input.model)
    if (agentModel !== mainModel) {
      tags.push(
        <Box key="model" flexWrap="nowrap" marginLeft={1}>
          <Text dimColor>{renderModelName(agentModel)}</Text>
        </Box>,
      )
    }
  }

  if (tags.length === 0) {
    return null
  }

  return <>{tags}</>
}

const INITIALIZING_TEXT = 'Initializing…'

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    terminalSize,
    inProgressToolCallCount,
    isTranscriptMode = false,
  }: {
    tools: Tools
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  if (!progressMessages.length) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>
    )
  }

  // Checks to see if we should show a super condensed progress message summary.
  // This prevents flickers when the terminal size is too small to render all the dynamic content
  const toolToolRenderLinesEstimate =
    (inProgressToolCallCount ?? 1) * ESTIMATED_LINES_PER_TOOL +
    TERMINAL_BUFFER_LINES
  const shouldUseCondensedMode =
    !isTranscriptMode &&
    terminalSize &&
    terminalSize.rows &&
    terminalSize.rows < toolToolRenderLinesEstimate

  const getProgressStats = () => {
    const toolUseCount = count(progressMessages, msg => {
      if (!hasProgressMessage(msg.data)) {
        return false
      }
      const message = msg.data.message
      return message.message.content.some(
        content => content.type === 'tool_use',
      )
    })

    const latestAssistant = progressMessages.findLast(
      (msg): msg is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(msg.data) && msg.data.message.type === 'assistant',
    )

    let tokens = null
    if (latestAssistant?.data.message.type === 'assistant') {
      const usage = latestAssistant.data.message.message.usage
      tokens =
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        usage.input_tokens +
        usage.output_tokens
    }

    return { toolUseCount, tokens }
  }

  if (shouldUseCondensedMode) {
    const { toolUseCount, tokens } = getProgressStats()

    return (
      <MessageResponse height={1}>
        <Text dimColor>
          In progress… · <Text bold>{toolUseCount}</Text> tool{' '}
          {toolUseCount === 1 ? 'use' : 'uses'}
          {tokens && ` · ${formatNumber(tokens)} tokens`} ·{' '}
          <ConfigurableShortcutHint
            action="app:toggleTranscript"
            context="Global"
            fallback="ctrl+o"
            description="expand"
            parens
          />
        </Text>
      </MessageResponse>
    )
  }

  // 处理消息以将连续的搜索/读取操作分组为摘要（仅限 ant）
  // isAgentRunning=true 因为这是代理仍在运行时的进度视图
  const processedMessages = processProgressMessages(
    progressMessages,
    tools,
    true,
  )

  // For display, take the last few processed messages
  const displayedMessages = isTranscriptMode
    ? processedMessages
    : processedMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)

  // 专门计算隐藏的工具调用（不是所有消息）以匹配
  // 最终的 "Done (N tool uses)" 计数。每个工具调用生成多个
  // 进度消息（tool_use + tool_result + text），所以计算所有
  // 隐藏消息会夸大向用户显示的数量。
  const hiddenMessages = isTranscriptMode
    ? []
    : processedMessages.slice(
        0,
        Math.max(0, processedMessages.length - MAX_PROGRESS_MESSAGES_TO_SHOW),
      )
  const hiddenToolUseCount = count(hiddenMessages, m => {
    if (m.type === 'summary') {
      return m.searchCount + m.readCount + m.replCount > 0
    }
    const data = m.message.data
    if (!hasProgressMessage(data)) {
      return false
    }
    return data.message.message.content.some(
      content => content.type === 'tool_use',
    )
  })

  const firstData = progressMessages[0]?.data
  const prompt =
    firstData && hasProgressMessage(firstData) ? firstData.prompt : undefined

  // After grouping, displayedMessages can be empty when the only progress so
  // far is an assistant tool_use for a search/read op (grouped but not yet
  // counted, since counts increment on tool_result). Fall back to the
  // initializing text so MessageResponse doesn't render a bare ⎿.
  if (displayedMessages.length === 0 && !(isTranscriptMode && prompt)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>
    )
  }

  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs,
  } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {isTranscriptMode && prompt && (
            <Box marginBottom={1}>
              <AgentPromptDisplay prompt={prompt} />
            </Box>
          )}
          {displayedMessages.map(processed => {
            if (processed.type === 'summary') {
              // 使用共享格式渲染分组搜索/读取/REPL 操作的摘要
              const summaryText = getSearchReadSummaryText(
                processed.searchCount,
                processed.readCount,
                processed.isActive,
                processed.replCount,
              )
              return (
                <Box key={processed.uuid} height={1} overflow="hidden">
                  <Text dimColor>{summaryText}</Text>
                </Box>
              )
            }
            // Render original message without height=1 wrapper so null
            // content (tool not found, renderToolUseMessage returns null)
            // doesn't leave a blank line. Tool call headers are single-line
            // anyway so truncation isn't needed.
            return (
              <MessageComponent
                key={processed.message.uuid}
                message={processed.message.data.message}
                lookups={subagentLookups}
                addMargin={false}
                tools={tools}
                commands={[]}
                verbose={verbose}
                inProgressToolUseIDs={collapsedInProgressIDs}
                progressMessagesForMessage={[]}
                shouldAnimate={false}
                shouldShowDot={false}
                style="condensed"
                isTranscriptMode={false}
                isStatic={true}
              />
            )
          })}
        </SubAgentProvider>
        {hiddenToolUseCount > 0 && (
          <Text dimColor>
            +{hiddenToolUseCount} more tool{' '}
            {hiddenToolUseCount === 1 ? 'use' : 'uses'} <CtrlOToExpand />
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseRejectedMessage(
  _input: { description: string; prompt: string; subagent_type: string },
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    columns: number
    messages: Message[]
    style?: 'condensed'
    theme: ThemeName
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  // 如果有可用的话，从进度消息中获取 agentId（代理在拒绝前正在运行）
  const firstData = progressMessagesForMessage[0]?.data
  const agentId =
    firstData && hasProgressMessage(firstData) ? firstData.agentId : undefined

  return (
    <>
      {process.env.USER_TYPE === 'ant' && agentId && (
        <MessageResponse>
          <Text color="warning">
            [ANT-ONLY] API calls: {getDisplayPath(getDumpPromptsPath(agentId))}
          </Text>
        </MessageResponse>
      )}
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
        isTranscriptMode,
      })}
      <FallbackToolUseRejectedMessage />
    </>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  return (
    <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
        isTranscriptMode,
      })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>
  )
}

function calculateAgentStats(progressMessages: ProgressMessage<Progress>[]): {
  toolUseCount: number
  tokens: number | null
} {
  const toolUseCount = count(progressMessages, msg => {
    if (!hasProgressMessage(msg.data)) {
      return false
    }
    const message = msg.data.message
    return (
      message.type === 'user' &&
      message.message.content.some(content => content.type === 'tool_result')
    )
  })

  const latestAssistant = progressMessages.findLast(
    (msg): msg is ProgressMessage<AgentToolProgress> =>
      hasProgressMessage(msg.data) && msg.data.message.type === 'assistant',
  )

  let tokens = null
  if (latestAssistant?.data.message.type === 'assistant') {
    const usage = latestAssistant.data.message.message.usage
    tokens =
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.input_tokens +
      usage.output_tokens
  }

  return { toolUseCount, tokens }
}

export function renderGroupedAgentToolUse(
  toolUses: Array<{
    param: ToolUseBlockParam
    isResolved: boolean
    isError: boolean
    isInProgress: boolean
    progressMessages: ProgressMessage<Progress>[]
    result?: {
      param: ToolResultBlockParam
      output: Output
    }
  }>,
  options: {
    shouldAnimate: boolean
    tools: Tools
  },
): React.ReactNode | null {
  const { shouldAnimate, tools } = options

  // Calculate stats for each agent
  const agentStats = toolUses.map(
    ({ param, isResolved, isError, progressMessages, result }) => {
      const stats = calculateAgentStats(progressMessages)
      const lastToolInfo = extractLastToolInfo(progressMessages, tools)
      const parsedInput = inputSchema().safeParse(param.input)

      // teammate_spawned 不是导出 Output 类型的一部分（通过 unknown 转换
      // 以实现死代码消除），所以通过原始值的字符串比较进行检查
      const isTeammateSpawn =
        (result?.output?.status as string) === 'teammate_spawned'

      // For teammate spawns, show @name with type in parens and description as status
      let agentType: string
      let description: string | undefined
      let color: keyof Theme | undefined
      let descriptionColor: keyof Theme | undefined
      let taskDescription: string | undefined
      if (isTeammateSpawn && parsedInput.success && parsedInput.data.name) {
        agentType = `@${parsedInput.data.name}`
        const subagentType = parsedInput.data.subagent_type
        description = isCustomSubagentType(subagentType)
          ? subagentType
          : undefined
        taskDescription = parsedInput.data.description
        // 在类型上使用自定义代理定义的颜色，而不是名称
        descriptionColor = isCustomSubagentType(subagentType)
          ? (getAgentColor(subagentType) as keyof Theme | undefined)
          : undefined
      } else {
        agentType = parsedInput.success
          ? userFacingName(parsedInput.data)
          : 'Agent'
        description = parsedInput.success
          ? parsedInput.data.description
          : undefined
        color = parsedInput.success
          ? userFacingNameBackgroundColor(parsedInput.data)
          : undefined
        taskDescription = undefined
      }

      // Check if this was launched as a background agent OR backgrounded mid-execution
      const launchedAsAsync =
        parsedInput.success &&
        'run_in_background' in parsedInput.data &&
        parsedInput.data.run_in_background === true
      const outputStatus = (result?.output as { status?: string } | undefined)
        ?.status
      const backgroundedMidExecution =
        outputStatus === 'async_launched' || outputStatus === 'remote_launched'
      const isAsync =
        launchedAsAsync || backgroundedMidExecution || isTeammateSpawn

      const name = parsedInput.success ? parsedInput.data.name : undefined

      return {
        id: param.id,
        agentType,
        description,
        toolUseCount: stats.toolUseCount,
        tokens: stats.tokens,
        isResolved,
        isError,
        isAsync,
        color,
        descriptionColor,
        lastToolInfo,
        taskDescription,
        name,
      }
    },
  )

  const anyUnresolved = toolUses.some(t => !t.isResolved)
  const anyError = toolUses.some(t => t.isError)
  const allComplete = !anyUnresolved

  // 检查所有代理是否相同类型
  const allSameType =
    agentStats.length > 0 &&
    agentStats.every(stat => stat.agentType === agentStats[0]?.agentType)
  const commonType =
    allSameType && agentStats[0]?.agentType !== 'Agent'
      ? agentStats[0]?.agentType
      : null

  // Check if all resolved agents are async (background)
  const allAsync = agentStats.every(stat => stat.isAsync)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <ToolUseLoader
          shouldAnimate={shouldAnimate && anyUnresolved}
          isUnresolved={anyUnresolved}
          isError={anyError}
        />
        <Text>
          {allComplete ? (
            allAsync ? (
              <>
                <Text bold>{toolUses.length}</Text> background agents launched{' '}
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="↓" action="manage" parens />
                </Text>
              </>
            ) : (
              <>
                <Text bold>{toolUses.length}</Text>{' '}
                {commonType ? `${commonType} agents` : 'agents'} finished
              </>
            )
          ) : (
            <>
              Running <Text bold>{toolUses.length}</Text>{' '}
              {commonType ? `${commonType} agents` : 'agents'}…
            </>
          )}{' '}
        </Text>
        {!allAsync && <CtrlOToExpand />}
      </Box>
      {agentStats.map((stat, index) => (
        <AgentProgressLine
          key={stat.id}
          agentType={stat.agentType}
          description={stat.description}
          descriptionColor={stat.descriptionColor}
          taskDescription={stat.taskDescription}
          toolUseCount={stat.toolUseCount}
          tokens={stat.tokens}
          color={stat.color}
          isLast={index === agentStats.length - 1}
          isResolved={stat.isResolved}
          isError={stat.isError}
          isAsync={stat.isAsync}
          shouldAnimate={shouldAnimate}
          lastToolInfo={stat.lastToolInfo}
          hideType={allSameType}
          name={stat.name}
        />
      ))}
    </Box>
  )
}

export function userFacingName(
  input:
    | Partial<{
        description: string
        prompt: string
        subagent_type: string
        name: string
        team_name: string
      }>
    | undefined,
): string {
  if (
    input?.subagent_type &&
    input.subagent_type !== GENERAL_PURPOSE_AGENT.agentType
  ) {
    // 将 "worker" 代理显示为 "Agent" 以获得更清晰的 UI
    if (input.subagent_type === 'worker') {
      return 'Agent'
    }
    return input.subagent_type
  }
  return 'Agent'
}

export function userFacingNameBackgroundColor(
  input:
    | Partial<{ description: string; prompt: string; subagent_type: string }>
    | undefined,
): keyof Theme | undefined {
  if (!input?.subagent_type) {
    return undefined
  }

  // Get the color for this agent
  return getAgentColor(input.subagent_type) as keyof Theme | undefined
}

export function extractLastToolInfo(
  progressMessages: ProgressMessage<Progress>[],
  tools: Tools,
): string | null {
  // 从所有进度消息构建 tool_use 查询（用于反向迭代）
  const toolUseByID = new Map<string, ToolUseBlockParam>()
  for (const pm of progressMessages) {
    if (!hasProgressMessage(pm.data)) {
      continue
    }
    if (pm.data.message.type === 'assistant') {
      for (const c of pm.data.message.message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam)
        }
      }
    }
  }

  // Count trailing consecutive search/read operations from the end
  let searchCount = 0
  let readCount = 0
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const msg = progressMessages[i]!
    if (!hasProgressMessage(msg.data)) {
      continue
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID)
    if (info && (info.isSearch || info.isRead)) {
      // 只计算 tool_result 消息以避免重复计数
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          searchCount++
        } else if (info.isRead) {
          readCount++
        }
      }
    } else {
      break
    }
  }

  if (searchCount + readCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true)
  }

  // Find the last tool_result message
  const lastToolResult = progressMessages.findLast(
    (msg): msg is ProgressMessage<AgentToolProgress> => {
      if (!hasProgressMessage(msg.data)) {
        return false
      }
      const message = msg.data.message
      return (
        message.type === 'user' &&
        message.message.content.some(c => c.type === 'tool_result')
      )
    },
  )

  if (lastToolResult?.data.message.type === 'user') {
    const toolResultBlock = lastToolResult.data.message.message.content.find(
      c => c.type === 'tool_result',
    )

    if (toolResultBlock?.type === 'tool_result') {
      // Look up the corresponding tool_use — already indexed above
      const toolUseBlock = toolUseByID.get(toolResultBlock.tool_use_id)

      if (toolUseBlock) {
        const tool = findToolByName(tools, toolUseBlock.name)
        if (!tool) {
          return toolUseBlock.name // 后备到原始名称
        }

        const input = toolUseBlock.input as Record<string, unknown>
        const parsedInput = tool.inputSchema.safeParse(input)

        // Get user-facing tool name
        const userFacingToolName = tool.userFacingName(
          parsedInput.success ? parsedInput.data : undefined,
        )

        // Try to get summary from the tool itself
        if (tool.getToolUseSummary) {
          const summary = tool.getToolUseSummary(
            parsedInput.success ? parsedInput.data : undefined,
          )
          if (summary) {
            return `${userFacingToolName}: ${summary}`
          }
        }

        // Default: just show user-facing tool name
        return userFacingToolName
      }
    }
  }

  return null
}

function isCustomSubagentType(
  subagentType: string | undefined,
): subagentType is string {
  return (
    !!subagentType &&
    subagentType !== GENERAL_PURPOSE_AGENT.agentType &&
    subagentType !== 'worker'
  )
}
