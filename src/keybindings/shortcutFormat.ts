import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): Remove fallback parameter after migration is
// complete and we've confirmed no 'keybinding_fallback_used' events are being
// logged. The fallback exists as a safety net during migration - if bindings
// fail to load or an action isn't found, we fall back to hardcoded values.
// Once stable, callers should be able to trust that getBindingDisplayText
// always returns a value for known actions, and we can remove this defensive
// pattern.

// Track which action+context pairs have already logged a fallback event
// to avoid duplicate events from repeated calls in non-React contexts.
const LOGGED_FALLBACKS = new Set<string>()

/**
 * 在非 React 上下文中获取已配置快捷键的显示文本。
 * 用于命令、服务等非 React 调用场景。
 *
 * 单独放在一个模块中（不是 useShortcutDisplay.ts），
 * 这样非 React 调用方（如 query/stopHooks.ts）不会通过
 * sibling hook 将 React 引入其模块图。
 *
 * @param action - 操作名称（例如 'app:toggleTranscript'）
 * @param context - keybinding 上下文（例如 'Global'）
 * @param fallback - 如果找不到绑定时的备用文本
 * @returns 已配置的快捷键显示文本
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，或 'ctrl+o' 作为默认值
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const bindings = loadKeybindingsSync()
  const resolved = getBindingDisplayText(action, context, bindings)
  if (resolved === undefined) {
    const key = `${action}:${context}`
    if (!LOGGED_FALLBACKS.has(key)) {
      LOGGED_FALLBACKS.add(key)
      logEvent('tengu_keybinding_fallback_used', {
        action:
          action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context:
          context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback:
          fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason:
          'action_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    return fallback
  }
  return resolved
}
