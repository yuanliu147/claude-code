/**
 * Magic Docs 自动维护带有特殊头部的 markdown 文档文件。
 * 当读取带有 "# MAGIC DOC: [title]" 的文件时，它会在后台周期性运行，
 * 使用分叉的子代理来根据对话中的新学习内容更新文档。
 *
 * 更多信息请参阅 docs/magic-docs.md。
 */

import type { Tool, ToolUseContext } from '../../Tool.js'
import type { BuiltInAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
  registerFileReadListener,
} from '../../tools/FileReadTool/FileReadTool.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import {
  type REPLHookContext,
  registerPostSamplingHook,
} from '../../utils/hooks/postSamplingHooks.js'
import {
  createUserMessage,
  hasToolCallsInLastAssistantTurn,
} from '../../utils/messages.js'
import { sequential } from '../../utils/sequential.js'
import { buildMagicDocsUpdatePrompt } from './prompts.js'

// Magic Doc 头部模式: # MAGIC DOC: [title]
// 匹配文件开头（第一行）
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
// 匹配头部正下方一行的斜体
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m

// 跟踪 magic docs
type MagicDocInfo = {
  path: string
}

const trackedMagicDocs = new Map<string, MagicDocInfo>()

export function clearTrackedMagicDocs(): void {
  trackedMagicDocs.clear()
}

/**
 * 检测文件内容是否包含 Magic Doc 头部
 * 返回包含标题和可选指令的对象，如果不是 magic doc 则返回 null
 */
export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match || !match[1]) {
    return null
  }

  const title = match[1].trim()

  // 查找头部下一行的斜体（允许一个可选的空白行）
  const headerEndIndex = match.index! + match[0].length
  const afterHeader = content.slice(headerEndIndex)
  // 匹配: 换行、可选空白行、然后是内容行
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/)

  if (nextLineMatch && nextLineMatch[1]) {
    const nextLine = nextLineMatch[1]
    const italicsMatch = nextLine.match(ITALICS_PATTERN)
    if (italicsMatch && italicsMatch[1]) {
      const instructions = italicsMatch[1].trim()
      return {
        title,
        instructions,
      }
    }
  }

  return { title }
}

/**
 * 当文件被读取时将其注册为 Magic Doc
 * 每个文件路径只注册一次 — hook 始终读取最新内容
 */
export function registerMagicDoc(filePath: string): void {
  // 仅在尚未被跟踪时注册
  if (!trackedMagicDocs.has(filePath)) {
    trackedMagicDocs.set(filePath, {
      path: filePath,
    })
  }
}

/**
 * 创建 Magic Docs 代理定义
 */
function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    whenToUse: 'Update Magic Docs',
    tools: [FILE_EDIT_TOOL_NAME], // 只允许 Edit
    model: 'sonnet',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '', // 将使用 override systemPrompt
  }
}

/**
 * 更新单个 Magic Doc
 */
async function updateMagicDoc(
  docInfo: MagicDocInfo,
  context: REPLHookContext,
): Promise<void> {
  const { messages, systemPrompt, userContext, systemContext, toolUseContext } =
    context

  // 克隆 FileStateCache 以隔离 Magic Docs 操作。删除此
  // doc 的条目以避免 FileReadTool 的去重返回 file_unchanged
  // stub — 我们需要实际内容来重新检测头部。
  const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
  clonedReadFileState.delete(docInfo.path)
  const clonedToolUseContext: ToolUseContext = {
    ...toolUseContext,
    readFileState: clonedReadFileState,
  }

  // 读取文档；如果已删除或不可读，从跟踪中移除
  let currentDoc = ''
  try {
    const result = await FileReadTool.call(
      { file_path: docInfo.path },
      clonedToolUseContext,
    )
    const output = result.data as FileReadToolOutput
    if (output.type === 'text') {
      currentDoc = output.file.content
    }
  } catch (e: unknown) {
    // FileReadTool 将 ENOENT 包装在普通的 Error("File does not exist...") 中，
    // 没有 .code，所以除了 isFsInaccessible (EACCES/EPERM) 外还要检查消息。
    if (
      isFsInaccessible(e) ||
      (e instanceof Error && e.message.startsWith('File does not exist'))
    ) {
      trackedMagicDocs.delete(docInfo.path)
      return
    }
    throw e
  }

  // 从最新文件内容重新检测标题和指令
  const detected = detectMagicDocHeader(currentDoc)
  if (!detected) {
    // 文件不再有 magic doc 头部，从跟踪中移除
    trackedMagicDocs.delete(docInfo.path)
    return
  }

  // 使用最新标题和指令构建更新提示
  const userPrompt = await buildMagicDocsUpdatePrompt(
    currentDoc,
    docInfo.path,
    detected.title,
    detected.instructions,
  )

  // 创建自定义 canUseTool，只允许对 magic doc 文件使用 Edit
  const canUseTool = async (tool: Tool, input: unknown) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      if (typeof filePath === 'string' && filePath === docInfo.path) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
    }
    return {
      behavior: 'deny' as const,
      message: `only ${FILE_EDIT_TOOL_NAME} is allowed for ${docInfo.path}`,
      decisionReason: {
        type: 'other' as const,
        reason: `only ${FILE_EDIT_TOOL_NAME} is allowed`,
      },
    }
  }

  // 使用分叉上下文运行 Magic Docs 更新
  for await (const _message of runAgent({
    agentDefinition: getMagicDocsAgent(),
    promptMessages: [createUserMessage({ content: userPrompt })],
    toolUseContext: clonedToolUseContext,
    canUseTool,
    isAsync: true,
    forkContextMessages: messages,
    querySource: 'magic_docs',
    override: {
      systemPrompt,
      userContext,
      systemContext,
    },
    availableTools: clonedToolUseContext.options.tools,
  })) {
    // 仅消费 — 让它运行到完成
  }
}

/**
 * 更新所有被跟踪 Magic Docs 的 Magic Docs post-sampling hook
 */
const updateMagicDocs = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, querySource } = context

  if (querySource !== 'repl_main_thread') {
    return
  }

  // 仅在对话空闲时更新（上一轮没有工具调用）
  const hasToolCalls = hasToolCallsInLastAssistantTurn(messages)
  if (hasToolCalls) {
    return
  }

  const docCount = trackedMagicDocs.size
  if (docCount === 0) {
    return
  }

  for (const docInfo of Array.from(trackedMagicDocs.values())) {
    await updateMagicDoc(docInfo, context)
  }
})

export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {
    // 注册监听器以在文件被读取时检测 magic docs
    registerFileReadListener((filePath: string, content: string) => {
      const result = detectMagicDocHeader(content)
      if (result) {
        registerMagicDoc(filePath)
      }
    })

    registerPostSamplingHook(updateMagicDocs)
  }
}
