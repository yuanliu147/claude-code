/**
 * classifierApprovals store 的 React hook。
 * 从 classifierApprovals.ts 分离出来，以便纯状态的导入方（permissions.ts、
 * toolExecution.ts、postCompactCleanup.ts）不会将 React 引入 print.ts。
 */

import { useSyncExternalStore } from 'react'
import {
  isClassifierChecking,
  subscribeClassifierChecking,
} from './classifierApprovals.js'

export function useIsClassifierChecking(toolUseID: string): boolean {
  return useSyncExternalStore(subscribeClassifierChecking, () =>
    isClassifierChecking(toolUseID),
  )
}
