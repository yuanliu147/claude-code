import { useEffect, useRef, useState } from 'react'

/**
 * 节流值，以便每个不同的值至少保持可见 `minMs`。
 * 防止快速循环的进度文本在可读之前闪烁过去。
 *
 * 与 debounce（等待安静）或 throttle（限制速率）不同，这保证了
 * 每个值在被替换之前都有其最低屏幕时间。
 */
export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [displayed, setDisplayed] = useState(value)
  const lastShownAtRef = useRef(0)

  useEffect(() => {
    const elapsed = Date.now() - lastShownAtRef.current
    if (elapsed >= minMs) {
      lastShownAtRef.current = Date.now()
      setDisplayed(value)
      return
    }
    const timer = setTimeout(
      (shownAtRef, setFn, v) => {
        shownAtRef.current = Date.now()
        setFn(v)
      },
      minMs - elapsed,
      lastShownAtRef,
      setDisplayed,
      value,
    )
    return () => clearTimeout(timer)
  }, [value, minMs])

  return displayed
}
