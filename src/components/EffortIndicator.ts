import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from '../constants/figures.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../utils/effort.js'

/**
 * 构建精力变更通知的文本，例如 "◐ medium · /effort"。
 * 如果模型不支持精力则返回 undefined。
 */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const level = getDisplayedEffortLevel(model, effortValue)
  return `${effortLevelToSymbol(level)} ${level} · /effort`
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
		case "low":
			return EFFORT_LOW;
		case "medium":
			return EFFORT_MEDIUM;
		case "high":
			return EFFORT_HIGH;
		case "max":
			return EFFORT_MAX;
		default:
			// 防御性：level 可能来自远程配置。如果未知值穿透，
			// 渲染 high 符号而不是 undefined。
			return EFFORT_HIGH;
  }
}
