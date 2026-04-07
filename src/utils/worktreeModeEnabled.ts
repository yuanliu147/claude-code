/**
 * Worktree 模式现在无条件地对所有用户启用。
 *
 * 之前由 GrowthBook 标志 'tengu_worktree_mode' 控制，但
 * CACHED_MAY_BE_STALE 模式在首次启动时返回默认值（false），此时缓存尚未填充，
 * 会静默忽略 --worktree 参数。
 * 详见 https://github.com/anthropics/claude-code/issues/27044。
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}
