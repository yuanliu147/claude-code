/**
 * 共享的 analytics 配置
 *
 * 确定 analytics 应在何时禁用的通用逻辑
 * 跨所有 analytics 系统（Datadog、1P）
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * 检查 analytics 操作是否应被禁用
 *
 * Analytics 在以下情况下被禁用：
 * - 测试环境（NODE_ENV === 'test'）
 * - 第三方云提供商（Bedrock/Vertex）
 * - 隐私级别为 no-telemetry 或 essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isTelemetryDisabled()
  )
}

/**
 * 检查是否应禁止反馈调查。
 *
 * 与 isAnalyticsDisabled() 不同，这不会阻塞 3P 提供商
 *（Bedrock/Vertex/Foundry）。调查是本地 UI 提示，没有
 * transcript 数据 — 企业客户通过 OTEL 捕获响应。
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
