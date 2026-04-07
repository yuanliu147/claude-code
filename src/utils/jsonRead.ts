/**
 * 叶子节点 stripBOM — 从 json.ts 提取出来以打破 settings → json → log →
 * types/logs → … → settings 的循环依赖。json.ts 为其 memoized+logging
 * safeParseJSON 导入此模块；叶子调用方如果无法导入 json.ts 则直接使用 stripBOM +
 * jsonParse（syncCacheState 就是这样做的）。
 *
 * UTF-8 BOM (U+FEFF): PowerShell 5.x 默认以 UTF-8 with BOM 写入
 * (Out-File, Set-Content)。我们无法控制用户环境，所以在读取时剥离。
 * 没有这个，JSON.parse 会因 "Unexpected token" 而失败。
 */

const UTF8_BOM = '\uFEFF'

export function stripBOM(content: string): string {
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content
}
