/**
 * 注册命令绑定键绑定处理器的组件。
 *
 * 必须在 KeybindingSetup 内部渲染才能访问键绑定上下文。
 * 从当前键绑定配置中读取 "command:*" 操作并注册
 * 通过 onSubmit 调用相应斜杠命令的处理程序。
 *
 * 通过键绑定触发的命令被视为"即时"执行 - 它们立即
 * 执行并保留用户现有的输入文本（提示不会被清除）。
 */
import { useMemo } from 'react'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import type { PromptInputHelpers } from '../utils/handlePromptSubmit.js'

type Props = {
  // onSubmit accepts additional parameters beyond what we pass here,
  // so we use a rest parameter to allow any additional args
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    ...rest: [
      speculationAccept?: undefined,
      options?: { fromKeybinding?: boolean },
    ]
  ) => void
  /** Set to false to disable command keybindings (e.g., when a dialog is open) */
  isActive?: boolean
}

const NOOP_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

/**
 * Registers keybinding handlers for all "command:*" actions found in the
 * user's keybinding configuration. When triggered, each handler submits
 * the corresponding slash command (e.g., "command:commit" submits "/commit").
 */
export function CommandKeybindingHandlers({
  onSubmit,
  isActive = true,
}: Props): null {
  const keybindingContext = useOptionalKeybindingContext()
  const isModalOverlayActive = useIsModalOverlayActive()

  // Extract command actions from parsed bindings
  const commandActions = useMemo(() => {
    if (!keybindingContext) return new Set<string>()
    const actions = new Set<string>()
    for (const binding of keybindingContext.bindings) {
      if (binding.action?.startsWith('command:')) {
        actions.add(binding.action)
      }
    }
    return actions
  }, [keybindingContext])

  // Build handler map for all command actions
  const handlers = useMemo(() => {
    const map: Record<string, () => void> = {}
    for (const action of commandActions) {
      const commandName = action.slice('command:'.length)
      map[action] = () => {
        onSubmit(`/${commandName}`, NOOP_HELPERS, undefined, {
          fromKeybinding: true,
        })
      }
    }
    return map
  }, [commandActions, onSubmit])

  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !isModalOverlayActive,
  })

  return null
}
