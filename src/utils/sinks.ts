
import { initializeErrorLogSink } from './errorLogSink.js'
import { initializeAnalyticsSink } from '../services/analytics/sink.js'

/**
 * 附加错误日志和 analytics sink，排空挂载前排队的任何事件。
 * 两个初始化都是幂等的。从 setup() 调用以执行默认命令；
 * 其他入口点（子命令、daemon、bridge）直接调用此函数，
 * 因为它们绕过了 setup()。
 *
 * 叶子模块 — 放在 setup.ts 之外以避免 setup → commands → bridge
 * → setup 的导入循环。
 */
export function initSinks(): void {
  initializeErrorLogSink()
  initializeAnalyticsSink()
}
