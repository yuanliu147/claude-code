import { useCallback, useEffect } from 'react'
import type { InputEvent } from '@anthropic/ink'
import { type Key, useInput } from '@anthropic/ink'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

type Options = {
  /** Which context this binding belongs to (default: 'Global') */
  context?: KeybindingContextName
  /** Only handle when active (like useInput's isActive) */
  isActive?: boolean
}

/**
 * Ink-native hook for handling a keybinding.
 *
 * The handler stays in the component (React way).
 * The binding (keystroke → action) comes from config.
 *
 * Supports chord sequences (e.g., "ctrl+k ctrl+s"). When a chord is started,
 * the hook will manage the pending state automatically.
 *
 * Uses stopImmediatePropagation() to prevent other handlers from firing
 * once this binding is handled.
 *
 * @example
 * ```tsx
 * useKeybinding('app:toggleTodos', () => {
 *   setShowTodos(prev => !prev)
 * }, { context: 'Global' })
 * ```
 */
export function useKeybinding(
  action: string,
  handler: () => void | false | Promise<void>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // Register handler with the context for ChordInterceptor to invoke
  useEffect(() => {
    if (!keybindingContext || !isActive) return
    return keybindingContext.registerHandler({ action, context, handler })
  }, [action, context, handler, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // If no keybinding context available, skip resolution
      if (!keybindingContext) return

      // Build context list: registered active contexts + this context + Global
      // More specific contexts (registered ones) take precedence over Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // Deduplicate while preserving order (first occurrence wins for priority)
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // Chord completed (if any) - clear pending state
          keybindingContext.setPendingChord(null)
          if (result.action === action) {
            if (handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // User started a chord sequence - update pending state
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // Chord was cancelled (escape or invalid key)
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // Explicitly unbound - clear any pending chord
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // No match - let other handlers try
          break
      }
    },
    [action, context, handler, keybindingContext],
  )

  useInput(handleInput, { isActive })
}

/**
 * Handle multiple keybindings in one hook (reduces useInput calls).
 *
 * Supports chord sequences. When a chord is started, the hook will
 * manage the pending state automatically.
 *
 * @example
 * ```tsx
 * useKeybindings({
 *   'chat:submit': () => handleSubmit(),
 *   'chat:cancel': () => handleCancel(),
 * }, { context: 'Chat' })
 * ```
 */
export function useKeybindings(
  // 处理程序返回 `false` 意味着"未消耗"——事件传播到
  // 后面的 useInput/useKeybindings 处理程序。对失败切换很有用：
  // 例如 ScrollKeybindingHandler 的 scroll:line* 在
  // ScrollBox 内容适合时返回 false（滚动是无操作），
  // 让子组件的处理程序接管滚轮事件以进行列表导航。
  // 允许 Promise<void> 用于fire-and-forget 异步处理程序
  //（`!== false` 检查仅跳过同步 `false` 的传播，不是待处理的 Promise）。
  handlers: Record<string, () => void | false | Promise<void>>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // 向上下文注册所有处理程序以供 ChordInterceptor 调用
  useEffect(() => {
    if (!keybindingContext || !isActive) return

    const unregisterFns: Array<() => void> = []
    for (const [action, handler] of Object.entries(handlers)) {
      unregisterFns.push(
        keybindingContext.registerHandler({ action, context, handler }),
      )
    }

    return () => {
      for (const unregister of unregisterFns) {
        unregister()
      }
    }
  }, [context, handlers, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // 如果没有 keybinding 上下文可用，跳过解析
      if (!keybindingContext) return

      // 构建上下文列表：已注册的活动上下文 + 此上下文 + Global
      // 更具体的上下文（已注册的）优先于 Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // 去重同时保持顺序（第一个出现优先）
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // 和弦完成（如果有）——清除待处理状态
          keybindingContext.setPendingChord(null)
          if (result.action in handlers) {
            const handler = handlers[result.action]
            if (handler && handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // 用户开始了一个和弦序列——更新待处理状态
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // 和弦被取消（escape 或无效键）
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // 明确取消绑定——清除任何待处理和弦
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // 没有匹配——让其他处理程序尝试
          break
      }
    },
    [context, handlers, keybindingContext],
  )

  useInput(handleInput, { isActive })
}
