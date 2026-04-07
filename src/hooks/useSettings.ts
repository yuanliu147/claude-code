import { type AppState, useAppState } from '../state/AppState.js'

/**
 * 在 AppState 中存储的设置类型（DeepImmutable 包装）。
 * 当需要注解从 useSettings() 获取的设置的变量时使用此类型。
 */
export type ReadonlySettings = AppState['settings']

/**
 * 从 AppState 访问当前设置的 React Hook。
 * 设置在通过 settingsChangeDetector 检测到磁盘上的文件更改时自动更新。
 *
 * 在 React 组件中用于响应式更新，而不是使用 getSettings_DEPRECATED()。
 */
export function useSettings(): ReadonlySettings {
  return useAppState(s => s.settings)
}
