import { useEffect, useRef } from 'react'
import { useTheme } from '@anthropic/ink'
import type { useSelection } from '@anthropic/ink'
import { getGlobalConfig } from '../utils/config.js'
import { getTheme } from '../utils/theme.js'

type Selection = ReturnType<typeof useSelection>

/**
 * 当用户完成拖动（非空选择时释放鼠标）
 * 或多次点击选择单词/行时，自动将选择复制到剪贴板。
 * 类似于 iTerm2 的"选择时复制到粘贴板" - 突出显示保持
 * 不变，以便用户可以看到复制的内容。仅在 alt-screen 模式下触发
 * （选择状态由 ink 实例拥有；在 alt-screen 外部，
 * 原生终端处理选择，此 hook 通过 ink stub 成为空操作）。
 *
 * selection.subscribe 在每次变更（开始/更新/完成/清除/
 * 多击）时触发。字符拖动和多次点击在按下时都设置 isDragging=true，
 * 因此带有 isDragging=false 的选择出现始终是拖动完成。
 * copiedRef 防止虚假通知时的重复触发。
 *
 * onCopied 是可选的 — 省略时，复制是静默的（剪贴板被写入
 * 但不会触发 toast/通知）。FleetView 使用这种静默模式；
 * 全屏 REPL 传递 showCopiedToast 以提供用户反馈。
 */
export function useCopyOnSelect(
  selection: Selection,
  isActive: boolean,
  onCopied?: (text: string) => void,
): void {
  // Tracks whether the *previous* notification had a visible selection with
  // isDragging=false (i.e., we already auto-copied it). Without this, the
  // finish→clear transition would look like a fresh selection-gone-idle
  // event and we'd toast twice for a single drag.
  const copiedRef = useRef(false)
  // onCopied is a fresh closure each render; read through a ref so the
  // effect doesn't re-subscribe (which would reset copiedRef via unmount).
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied

  useEffect(() => {
    if (!isActive) return

    const unsubscribe = selection.subscribe(() => {
      const sel = selection.getState()
      const has = selection.hasSelection()
      // Drag in progress — wait for finish. Reset copied flag so a new drag
      // that ends on the same range still triggers a fresh copy.
      if (sel?.isDragging) {
        copiedRef.current = false
        return
      }
      // No selection (cleared, or click-without-drag) — reset.
      if (!has) {
        copiedRef.current = false
        return
      }
      // Selection settled (drag finished OR multi-click). Already copied
      // this one — the only way to get here again without going through
      // isDragging or !has is a spurious notify (shouldn't happen, but safe).
      if (copiedRef.current) return

      // Default true: macOS users expect cmd+c to work. It can't — the
      // terminal's Edit > Copy intercepts it before the pty sees it, and
      // finds no native selection (mouse tracking disabled it). Auto-copy
      // on mouse-up makes cmd+c a no-op that leaves the clipboard intact
      // with the right content, so paste works as expected.
      const enabled = getGlobalConfig().copyOnSelect ?? true
      if (!enabled) return

      const text = selection.copySelectionNoClear()
      // Whitespace-only (e.g., blank-line multi-click) — not worth a
      // clipboard write or toast. Still set copiedRef so we don't retry.
      if (!text || !text.trim()) {
        copiedRef.current = true
        return
      }
      copiedRef.current = true
      onCopiedRef.current?.(text)
    })
    return unsubscribe
  }, [isActive, selection])
}

/**
 * Pipe the theme's selectionBg color into the Ink StylePool so the
 * selection overlay renders a solid blue bg instead of SGR-7 inverse.
 * Ink is theme-agnostic (layering: colorize.ts "theme resolution happens
 * at component layer, not here") — this is the bridge. Fires on mount
 * (before any mouse input is possible) and again whenever /theme flips,
 * so the selection color tracks the theme live.
 */
export function useSelectionBgColor(selection: Selection): void {
  const [themeName] = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
