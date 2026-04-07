/**
 * User-Agent 字符串辅助函数。
 *
 * 保持零依赖，以便 SDK 打包的代码（bridge、cli/transports）可以在
 * 不引入 auth.ts 及其传递依赖的情况下导入。
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}
