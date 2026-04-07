/**
 * 如果 bash 命令的第一行是 `# comment`（不是 `#!` shebang），
 * 则返回去掉 `#` 前缀的注释文本。否则返回 undefined。
 *
 * 在全屏模式下，这是非 Verbose 的工具使用标签 AND the
 * collapse-group ⎿ 提示——这是 Claude 为人类写的内容。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
