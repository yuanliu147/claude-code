import { extname } from 'path'
import React, { Suspense, use, useMemo } from 'react'
import { Ansi, Text } from '@anthropic/ink'
import { getCliHighlightPromise } from '../../utils/cliHighlight.js'
import { logForDebugging } from '../../utils/debug.js'
import { convertLeadingTabsToSpaces } from '../../utils/file.js'
import { hashPair } from '../../utils/hash.js'

type Props = {
  code: string
  filePath: string
  dim?: boolean
  skipColoring?: boolean
}

// 模块级别的高亮缓存 — hl.highlight() 是虚拟滚动
// 重新挂载时的热点成本。useMemo 不能在卸载→重新挂载后存活。
// 通过 code+language 的哈希作为键以避免保留完整的源代码字符串（#24180 RSS 修复）。
const HL_CACHE_MAX = 500
const hlCache = new Map<string, string>()
function cachedHighlight(
  hl: NonNullable<Awaited<ReturnType<typeof getCliHighlightPromise>>>,
  code: string,
  language: string,
): string {
  const key = hashPair(language, code)
  const hit = hlCache.get(key)
  if (hit !== undefined) {
    hlCache.delete(key)
    hlCache.set(key, hit)
    return hit
  }
  const out = hl.highlight(code, { language })
  if (hlCache.size >= HL_CACHE_MAX) {
    const first = hlCache.keys().next().value
    if (first !== undefined) hlCache.delete(first)
  }
  hlCache.set(key, out)
  return out
}

export function HighlightedCodeFallback({
  code,
  filePath,
  dim = false,
  skipColoring = false,
}: Props): React.ReactElement {
  const codeWithSpaces = convertLeadingTabsToSpaces(code)
  if (skipColoring) {
    return (
      <Text dimColor={dim}>
        <Ansi>{codeWithSpaces}</Ansi>
      </Text>
    )
  }
  const language = extname(filePath).slice(1)
  return (
    <Text dimColor={dim}>
      <Suspense fallback={<Ansi>{codeWithSpaces}</Ansi>}>
        <Highlighted codeWithSpaces={codeWithSpaces} language={language} />
      </Suspense>
    </Text>
  )
}

function Highlighted({
  codeWithSpaces,
  language,
}: {
  codeWithSpaces: string
  language: string
}): React.ReactElement {
  const hl = use(getCliHighlightPromise())
  const out = useMemo(() => {
    if (!hl) return codeWithSpaces
    let highlightLang = 'markdown'
    if (language) {
      if (hl.supportsLanguage(language)) {
        highlightLang = language
      } else {
        logForDebugging(
          `Language not supported while highlighting code, falling back to markdown: ${language}`,
        )
      }
    }
    try {
      return cachedHighlight(hl, codeWithSpaces, highlightLang)
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unknown language')) {
        logForDebugging(
          `Language not supported while highlighting code, falling back to markdown: ${e}`,
        )
        return cachedHighlight(hl, codeWithSpaces, 'markdown')
      }
      return codeWithSpaces
    }
  }, [codeWithSpaces, language, hl])
  return <Ansi>{out}</Ansi>
}
