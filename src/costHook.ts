import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { hasConsoleBillingAccess } from './utils/billing.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

/**
 * 成本摘要 Hook
 * 在进程退出时显示当前会话的成本并保存会话费用
 */
export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      // 仅在有控制台计费访问权限时输出成本
      if (hasConsoleBillingAccess()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }

      // 保存当前会话费用
      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    // 监听进程退出事件
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
