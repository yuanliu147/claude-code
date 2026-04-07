import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * 推理配置命令（/model, /fast, /effort）是否应该立即执行
 *（在运行中的查询期间）而不是等待当前回合结束。
 *
 * 对内部用户（ant）始终启用；外部用户通过实验控制。
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_immediate_model_command', false)
  )
}
