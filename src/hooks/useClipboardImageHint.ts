import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { hasImageInClipboard } from '../utils/imagePaste.js'

const NOTIFICATION_KEY = 'clipboard-image-hint'
// 小幅防抖以批量处理快速焦点变化
const FOCUS_CHECK_DEBOUNCE_MS = 1000
// 在此间隔内不显示超过一次提示
const HINT_COOLDOWN_MS = 30000

/**
 * 当终端重新获得焦点且剪贴板包含图像时显示通知的 Hook。
 *
 * @param isFocused - 终端当前是否获得焦点
 * @param enabled - 图像粘贴是否启用（onImagePaste 已定义）
 */
export function useClipboardImageHint(
  isFocused: boolean,
  enabled: boolean,
): void {
  const { addNotification } = useNotifications()
  const lastFocusedRef = useRef(isFocused)
  const lastHintTimeRef = useRef(0)
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // Only trigger on focus regain (was unfocused, now focused)
    const wasFocused = lastFocusedRef.current
    lastFocusedRef.current = isFocused

    if (!enabled || !isFocused || wasFocused) {
      return
    }

    // Clear any pending check
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current)
    }

    // Small debounce to batch rapid focus changes
    checkTimeoutRef.current = setTimeout(
      async (checkTimeoutRef, lastHintTimeRef, addNotification) => {
        checkTimeoutRef.current = null

        // Check cooldown to avoid spamming the user
        const now = Date.now()
        if (now - lastHintTimeRef.current < HINT_COOLDOWN_MS) {
          return
        }

        // Check if clipboard has an image (async osascript call)
        if (await hasImageInClipboard()) {
          lastHintTimeRef.current = now
          addNotification({
            key: NOTIFICATION_KEY,
            text: `Image in clipboard · ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} to paste`,
            priority: 'immediate',
            timeoutMs: 8000,
          })
        }
      },
      FOCUS_CHECK_DEBOUNCE_MS,
      checkTimeoutRef,
      lastHintTimeRef,
      addNotification,
    )

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current)
        checkTimeoutRef.current = null
      }
    }
  }, [isFocused, enabled, addNotification])
}
