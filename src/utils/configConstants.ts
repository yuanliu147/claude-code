// 这些常量放在单独的文件中以避免循环依赖问题。
// 不要在此文件中添加 imports — 必须保持零依赖。

export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

// 有效的编辑器模式（不包括已弃用的 'emacs'，它会自动迁移到 'normal'）
export const EDITOR_MODES = ['normal', 'vim'] as const

// 用于派生 teammate 的有效模式
// 'tmux' = 传统的基于 tmux 的 teammates
// 'in-process' = 在同一进程中运行的 in-process teammates
// 'auto' = 根据上下文自动选择（默认）
export const TEAMMATE_MODES = ['auto', 'tmux', 'in-process'] as const
