/**
 * 用于在优雅关闭期间运行的清理函数的全局注册表。
 * 此模块与 gracefulShutdown.ts 分开以避免循环依赖。
 */

// 清理函数的全局注册表
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // Return unregister function
}

/**
 * 运行所有已注册的清理函数。
 * 由 gracefulShutdown 内部使用。
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
