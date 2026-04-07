import { whichSync } from './which.js'

/**
 * 通过搜索 PATH 查找可执行文件，类似于 `which`。
 * 替换 spawn-rx 的 findActualExecutable 以避免引入 rxjs（约 313 KB）。
 *
 * 返回 { cmd, args } 以匹配 spawn-rx 的 API 形状。
 * `cmd` 是解析后的路径（如果找到），否则是原始名称。
 * `args` 始终是输入参数的直通。
 */
export function findExecutable(
  exe: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
