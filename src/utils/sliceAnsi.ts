import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '@anthropic/ink'

// 如果代码的 code 等于其 endCode（例如超链接关闭），则该代码是"结束代码"
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// 仅过滤"开始代码"（不包括结束代码）
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(c => !isEndCode(c))
}

/**
 * 切片包含 ANSI 转义码的字符串。
 *
 * 与 slice-ansi 包不同，这正确处理了 OSC 8 超链接
 * 序列，因为 @alcalzone/ansi-tokenize 正确地对它们进行了标记化。
 */
export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
): string {
  // 不要传递 `end` 给 tokenize — 它计算代码单元而不是显示单元格，
  // 所以对于带有零宽组合标记的文本，它会提前丢弃标记。
  const tokens = tokenize(str)
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // 按显示宽度前进，而不是代码单元。组合标记（天城文元音符号、
    // virama、变音符号）宽度为 0 — 通过 .length 计算会使位置
    // 提前超过 `end` 并截断切片。调用方通过显示单元格传递 start/end
    //（通过 stringWidth），所以位置必须跟踪相同的单位。
    const width =
      token.type === 'ansi' ? 0 : token.type === 'char' ? (token.fullWidth ? 2 : stringWidth(token.value)) : 0

    // 在尾随零宽标记之后中断 — 组合标记附加到
    // 前面的基础字符，所以 "भा"（भ + ा，1 个显示单元格）在
    // end=1 切片时必须包含 ा。在位置 >= end 但在
    // 零宽检查之前中断会丢失它并仅渲染 भ。ANSI 代码
    // 宽度为 0，但不得包含在 end 之后（它们打开新的样式运行
    // 泄漏到撤销序列中），所以也要根据字符类型进行门控。
    // !include guard 确保空切片（start===end）在字符串以
    // 零宽字符（BOM、ZWJ）开头时保持为空。
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !include) break
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // 在切片期间发出所有 ANSI 代码
        result += token.code
      }
    } else {
      if (!include && position >= start) {
        // 跳过开始边界处的尾随零宽标记 — 它们属于
        // 左半部分中前面的基础字符。没有这个，
        // 标记会出现在两部分中：left+right ≠ 原始。
        // 仅在 start > 0 时适用（否则没有前面的字符来拥有它）。
        if (start > 0 && width === 0) continue
        include = true
        // 减少并过滤到仅活跃的开始代码
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        result += (token as any).value
      }

      position += width
    }
  }

  // 仅撤销仍然活跃的开始代码
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return result
}
