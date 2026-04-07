/**
 * 系统提示数组的品牌类型。
 *
 * 此模块故意保持零依赖，以便可以从任何地方导入而不必担心循环初始化问题。
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
