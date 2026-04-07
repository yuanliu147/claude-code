import { useKeybindings } from '../keybindings/useKeybinding.js'
import { type ExitState, useExitOnCtrlCD } from './useExitOnCtrlCD.js'

export type { ExitState }

/**
 * 将 useExitOnCtrlCD 与 useKeybindings 连接的便捷 Hook。
 *
 * 这是组件中使用 useExitOnCtrlCD 的标准方式。
 * 分离是为了避免导入循环 - useExitOnCtrlCD.ts
 * 不直接从 keybindings 模块导入。
 *
 * @param onExit - 可选的自定义退出处理程序
 * @param onInterrupt - 功能处理中断的可选回调（ctrl+c）。
 *                      如果已处理返回 true，false 则继续双击退出。
 * @param isActive - 键绑定是否激活（默认为 true）。
 */
export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  return useExitOnCtrlCD(useKeybindings, onInterrupt, onExit, isActive)
}
