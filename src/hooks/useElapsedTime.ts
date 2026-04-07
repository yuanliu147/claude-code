import { useCallback, useSyncExternalStore } from 'react'
import { formatDuration } from '../utils/format.js'

/**
 * 返回自 startTime 以来格式化的时间的 Hook。
 * 使用 useSyncExternalStore 与基于间隔的更新以提高效率。
 *
 * @param startTime - Unix 时间戳（毫秒）
 * @param isRunning - 是否主动更新计时器
 * @param ms - 我们应该多久触发一次更新？
 * @param pausedMs - 要减去的总暂停时间
 * @param endTime - 如果设置，将持续时间冻结在此时间戳（用于
 *   终端任务）。如果没有这个，查看一个 2 分钟的任务 30 分钟后
 *   会显示 "32m"。
 * @returns 格式化的时间字符串（例如 "1m 23s"）
 */
export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms: number = 1000,
  pausedMs: number = 0,
  endTime?: number,
): string {
  const get = () =>
    formatDuration(Math.max(0, (endTime ?? Date.now()) - startTime - pausedMs))

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!isRunning) return () => {}
      const interval = setInterval(notify, ms)
      return () => clearInterval(interval)
    },
    [isRunning, ms],
  )

  return useSyncExternalStore(subscribe, get, get)
}
