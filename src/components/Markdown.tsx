import { marked, type Token, type Tokens } from 'marked'
import React, { Suspense, use, useMemo, useRef } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { Ansi, Box, useTheme } from '@anthropic/ink'
import {
  type CliHighlight,
  getCliHighlightPromise,
} from '../utils/cliHighlight.js'
import { hashContent } from '../utils/hash.js'
import { configureMarked, formatToken } from '../utils/markdown.js'
import { stripPromptXMLTags } from '../utils/messages.js'
import { MarkdownTable } from './MarkdownTable.js'

type Props = {
  children: string
  /** 当为 true 时，将所有文本内容渲染为暗淡色 */
  dimColor?: boolean
}

// 模块级别的 token 缓存 — marked.lexer 是虚拟滚动
// 重新挂载时的热点成本（每条消息约 3ms）。useMemo 不能在卸载→重新挂载后存活，所以
// 滚动回之前可见的消息会重新解析。消息在历史中是
// 不可变的；相同内容 → 相同 tokens。通过哈希作为键以避免
// 保留完整内容字符串（turn50→turn99 RSS 回归，#24180）。
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

// 指示 markdown 语法的字符。如果没有，则跳过
// 约 3ms 的 marked.lexer 调用 — 作为单个段落渲染。覆盖
// 大多数简短的助手响应和用户提示，它们是
// 纯句子。为速度通过 indexOf（而不是 regex）检查。
// 单个正则表达式：匹配任何 MD 标记或有序列表开始（行首的 N.）。
// 一次扫描而不是 10× includes 扫描。
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  // Sample first 500 chars — if markdown exists it's usually early (headers,
  // code fence, list). Long tool outputs are mostly plain text tails.
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // 快速路径：没有 markdown 语法的纯文本 → 单个段落 token。
  // 跳过 marked.lexer 的完整 GFM 解析（长内容约 3ms）。不缓存 —
  // 重建是单个对象分配，缓存会在 raw/text 字段中保留
  // 4× 内容加上哈希键，零收益。
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to MRU — without this the eviction is FIFO (scrolling back to
    // an early message evicts the very item you're looking at).
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    // LRU-ish: drop oldest. Map preserves insertion order.
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
}

/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as React components with proper flexbox layout
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown(props: Props): React.ReactNode {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
    return <MarkdownBody {...props} highlight={null} />
  }
  // Suspense fallback renders with highlight=null — plain markdown shows
  // for ~50ms on first ever render while cli-highlight loads.
  return (
    <Suspense fallback={<MarkdownBody {...props} highlight={null} />}>
      <MarkdownWithHighlight {...props} />
    </Suspense>
  )
}

function MarkdownWithHighlight(props: Props): React.ReactNode {
  const highlight = use(getCliHighlightPromise())
  return <MarkdownBody {...props} highlight={highlight} />
}

function MarkdownBody({
  children,
  dimColor,
  highlight,
}: Props & { highlight: CliHighlight | null }): React.ReactNode {
  const [theme] = useTheme()
  configureMarked()

  const elements = useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children))
    const elements: React.ReactNode[] = []
    let nonTableContent = ''

    function flushNonTableContent(): void {
      if (nonTableContent) {
        elements.push(
          <Ansi key={elements.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Ansi>,
        )
        nonTableContent = ''
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent()
        elements.push(
          <MarkdownTable
            key={elements.length}
            token={token as Tokens.Table}
            highlight={highlight}
          />,
        )
      } else {
        nonTableContent += formatToken(token, theme, 0, null, null, highlight)
      }
    }

    flushNonTableContent()
    return elements
  }, [children, dimColor, highlight, theme])

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  )
}

type StreamingProps = {
  children: string
}

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta. marked.lexer() correctly handles
 * unclosed code fences as a single token, so block boundaries are always safe.
 *
 * The stable boundary only advances (monotonic), so ref mutation during render
 * is idempotent and safe under StrictMode double-rendering. Component unmounts
 * between turns (streamingText → null), resetting the ref.
 */
export function StreamingMarkdown({
  children,
}: StreamingProps): React.ReactNode {
  // React Compiler: this component reads and writes stablePrefixRef.current
  // during render by design. The boundary only advances (monotonic), so
  // the ref mutation is idempotent under StrictMode double-render — but the
  // compiler can't prove that, and memoizing around the ref reads would
  // break the algorithm (stale boundary). Opt out.
  'use no memo'
  configureMarked()

  // Strip before boundary tracking so it matches <Markdown>'s stripping
  // (line 29). When a closing tag arrives, stripped(N+1) is not a prefix
  // of stripped(N), but the startsWith reset below handles that with a
  // one-time re-lex on the smaller stripped string.
  const stripped = stripPromptXMLTags(children)

  const stablePrefixRef = useRef('')

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance)
  }

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = stripped.substring(stablePrefix.length)

  // stablePrefix is memoized inside <Markdown> via useMemo([children, ...])
  // so it never re-parses as the unstable suffix grows
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
