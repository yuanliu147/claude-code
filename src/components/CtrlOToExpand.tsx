import chalk from 'chalk'
import React, { useContext } from 'react'
import { Text } from '@anthropic/ink'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { KeyboardShortcutHint } from '@anthropic/ink'
import { InVirtualListContext } from './messageActions.js'

// 用于追踪是否在子代理中的上下文
// 类似于 MessageResponseContext，这帮助我们避免在子代理输出中显示
// 太多 "(ctrl+o to expand)" 提示
const SubAgentContext = React.createContext(false)

export function SubAgentProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <SubAgentContext.Provider value={true}>{children}</SubAgentContext.Provider>
  )
}

export function CtrlOToExpand(): React.ReactNode {
  const isInSubAgent = useContext(SubAgentContext)
  const inVirtualList = useContext(InVirtualListContext)
  const expandShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  if (isInSubAgent || inVirtualList) {
    return null
  }
  return (
    <Text dimColor>
      <KeyboardShortcutHint shortcut={expandShortcut} action="expand" parens />
    </Text>
  )
}

export function ctrlOToExpand(): string {
  const shortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  return chalk.dim(`(${shortcut} to expand)`)
}
