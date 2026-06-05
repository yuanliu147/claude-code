/**
 * 启动性能分析工具，用于测量和报告各个初始化阶段所花费的时间。
 *
 * 两种模式：
 * 1. 采样日志：ant 用户 100%，外部用户 0.1% - 将阶段数据记录到 Statsig
 * 2. 详细分析：CLAUDE_CODE_PROFILE_STARTUP=1 - 包含内存快照的完整报告
 *
 * 使用 Node.js 内置的性能钩子 API 进行标准时间测量。
 */

import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'

// 模块级状态 - 在模块加载时确定一次
// eslint-disable-next-line custom-rules/no-process-env-top-level
const DETAILED_PROFILING = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_STARTUP)

// Statsig 日志采样：ant 用户 100%，外部用户 0.5%
// 在启动时确定一次 - 未被采样的用户无需承担性能分析开销
const STATSIG_SAMPLE_RATE = 0.005
// eslint-disable-next-line custom-rules/no-process-env-top-level
const STATSIG_LOGGING_SAMPLED =
  process.env.USER_TYPE === 'ant' || Math.random() < STATSIG_SAMPLE_RATE

// 如果启用了详细模式或被 Statsig 采样，则启用性能分析
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED

// 单独跟踪内存快照（perf_hooks 不跟踪内存）。
// 仅在 DETAILED_PROFILING 启用时使用。
// 存储为数组，按与 perf.mark() 调用相同的顺序追加，
// 因此 memorySnapshots[i] 对应 getEntriesByType('mark')[i]。
// 使用 Map 以 checkpoint 名称为 key 是错误的，因为某些 checkpoint
// 会触发多次（例如 loadSettingsFromDisk_start 在初始化时触发一次，
// 在插件重置设置缓存后会再次触发），第二次调用会覆盖第一次的内存快照。
const memorySnapshots: NodeJS.MemoryUsage[] = []

// Statsig 日志的阶段定义：[startCheckpoint, endCheckpoint]
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
} as const

// 如果启用了性能分析，则记录初始 checkpoint
if (SHOULD_PROFILE) {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  profileCheckpoint('profiler_initialized')
}

/**
 * 使用给定名称记录一个 checkpoint
 */
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return

  const perf = getPerformance()
  perf.mark(name)

  // 仅在启用详细性能分析（环境变量）时捕获内存
  if (DETAILED_PROFILING) {
    memorySnapshots.push(process.memoryUsage())
  }
}

/**
 * 获取所有 checkpoints 的格式化报告
 * 仅在 DETAILED_PROFILING 启用时可用
 */
function getReport(): string {
  if (!DETAILED_PROFILING) {
    return '启动性能分析未启用'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return '没有记录性能分析 checkpoints'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('启动性能分析报告')
  lines.push('='.repeat(80))
  lines.push('')

  let prevTime = 0
  for (const [i, mark] of marks.entries()) {
    lines.push(
      formatTimelineLine(
        mark.startTime,
        mark.startTime - prevTime,
        mark.name,
        memorySnapshots[i],
        8,
        7,
      ),
    )
    prevTime = mark.startTime
  }

  const lastMark = marks[marks.length - 1]
  lines.push('')
  lines.push(`总启动时间：${formatMs(lastMark?.startTime ?? 0)}ms`)
  lines.push('='.repeat(80))

  return lines.join('\n')
}

let reported = false

export function profileReport(): void {
  if (reported) return
  reported = true

  // 记录到 Statsig（采样：ant 用户 100%，外部用户 0.1%）
  logStartupPerf()

  // 如果 CLAUDE_CODE_PROFILE_STARTUP=1 则输出详细报告
  if (DETAILED_PROFILING) {
    // 写入文件
    const path = getStartupPerfLogPath()
    const dir = dirname(path)
    const fs = getFsImplementation()
    fs.mkdirSync(dir)
    writeFileSync_DEPRECATED(path, getReport(), {
      encoding: 'utf8',
      flush: true,
    })

    logForDebugging('启动性能分析报告：')
    logForDebugging(getReport())
  }
}

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

export function getStartupPerfLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'startup-perf', `${getSessionId()}.txt`)
}

/**
 * 将启动性能阶段记录到 Statsig。
 * 仅在该会话在启动时被采样时才记录。
 */
export function logStartupPerf(): void {
  // 仅在我们被采样时才记录（在模块加载时确定的决策）
  if (!STATSIG_LOGGING_SAMPLED) return

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) return

  // 构建 checkpoint 查找表
  const checkpointTimes = new Map<string, number>()
  for (const mark of marks) {
    checkpointTimes.set(mark.name, mark.startTime)
  }

  // 计算阶段持续时间
  const metadata: Record<string, number | undefined> = {}

  for (const [phaseName, [startCheckpoint, endCheckpoint]] of Object.entries(
    PHASE_DEFINITIONS,
  )) {
    const startTime = checkpointTimes.get(startCheckpoint)
    const endTime = checkpointTimes.get(endCheckpoint)

    if (startTime !== undefined && endTime !== undefined) {
      metadata[`${phaseName}_ms`] = Math.round(endTime - startTime)
    }
  }

  // 添加 checkpoint 数量用于调试
  metadata.checkpoint_count = marks.length

  logEvent(
    'tengu_startup_perf',
    metadata as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  )
}
