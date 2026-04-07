import { useCallback, useMemo, useState } from 'react'
import { useApp } from '@anthropic/ink'
import type { KeybindingContextName } from '../keybindings/types.js'
import { useDoublePress } from './useDoublePress.js'

export type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

type KeybindingOptions = {
  context?: KeybindingContextName
  isActive?: boolean
}

type UseKeybindingsHook = (
  handlers: Record<string, () => void>,
  options?: KeybindingOptions,
) => void

/**
 * 处理 ctrl+c 和 ctrl+d 以退出应用程序。
 *
 * 使用基于时间的双击机制：
 * - 第一次点击：显示"再次按 X 退出"消息
 * - 超时内的第二次点击：退出应用程序
 *
 * 注意：我们使用基于时间的双击而不是和弦系统，因为我们希望
 * 第一次 ctrl+c 也能触发中断（在其他地方处理）。
 * 和弦系统会阻止第一次点击触发任何操作。
 *
 * 这些键是硬编码的，不能通过 keybindings.json 重新绑定。
 *
 * @param useKeybindingsHook - 用于注册处理程序的 useKeybindings hook
 *                            （依赖注入以避免导入循环）
 * @param onInterrupt - 功能处理中断的可选回调（ctrl+c）。
 *                      如果已处理返回 true，false 则继续双击退出。
 * @param onExit - 可选的自定义退出处理程序
 * @param isActive - 键绑定是否激活（默认为 true）。当嵌入的 TextInput
 *                   获得焦点时设置为 false — TextInput 自己的
 *                   ctrl+c/d 处理程序将管理取消/退出，而 Dialog 的
 *                   处理程序否则会双重触发（子 useInput 在
 *                   父 useKeybindings 之前运行，所以两者都看到每个按键）。
 */
export function useExitOnCtrlCD(
  useKeybindingsHook: UseKeybindingsHook,
  onInterrupt?: () => boolean,
  onExit?: () => void,
  isActive = true,
): ExitState {
  const { exit } = useApp()
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })

  const exitFn = useMemo(() => onExit ?? exit, [onExit, exit])

  // Double-press handler for ctrl+c
  const handleCtrlCDoublePress = useDoublePress(
    pending => setExitState({ pending, keyName: 'Ctrl-C' }),
    exitFn,
  )

  // Double-press handler for ctrl+d
  const handleCtrlDDoublePress = useDoublePress(
    pending => setExitState({ pending, keyName: 'Ctrl-D' }),
    exitFn,
  )

  // Handler for app:interrupt (ctrl+c by default)
  // Let features handle interrupt first via callback
  const handleInterrupt = useCallback(() => {
    if (onInterrupt?.()) return // Feature handled it
    handleCtrlCDoublePress()
  }, [handleCtrlCDoublePress, onInterrupt])

  // Handler for app:exit (ctrl+d by default)
  // This also uses double-press to confirm exit
  const handleExit = useCallback(() => {
    handleCtrlDDoublePress()
  }, [handleCtrlDDoublePress])

  const handlers = useMemo(
    () => ({
      'app:interrupt': handleInterrupt,
      'app:exit': handleExit,
    }),
    [handleInterrupt, handleExit],
  )

  useKeybindingsHook(handlers, { context: 'Global', isActive })

  return exitState
}
