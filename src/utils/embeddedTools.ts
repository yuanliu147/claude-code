import { isEnvTruthy } from './envUtils.js'

/**
 * 此构建是否在 bun 二进制文件中嵌入了 bfs/ugrep（仅限 ant-native）。
 *
 * 当为 true 时：
 * - Claude 的 Bash shell 中的 `find` 和 `grep` 被 shell 函数遮蔽，
 *   这些函数使用 argv0='bfs' / argv0='ugrep' 调用 bun 二进制文件
 *   （与嵌入 ripgrep 相同的技巧）
 * - 专用的 Glob/Grep 工具从工具注册表中移除
 * - 引导 Claude 避免使用 find/grep 的提示指导被省略
 *
 * 在 scripts/build-with-plugins.ts 中为 ant-native 构建设置构建时定义。
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * 包含嵌入搜索工具的 bun 二进制文件的路径。
 * 仅在 hasEmbeddedSearchTools() 为 true 时有意义。
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
