// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { useMemo } from 'react'
import type { Tools, ToolPermissionContext } from '../Tool.js'
import { assembleToolPool } from '../tools.js'
import { useAppState } from '../state/AppState.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'

/**
 * 为 REPL 组装完整工具池的 React Hook。
 *
 * 使用 assembleToolPool()（REPL 和 runAgent 都使用的共享纯函数）
 * 来组合内置工具和 MCP 工具，应用拒绝规则和去重。
 * 任何额外的 initialTools 都合并在上面。
 *
 * @param initialTools - 要包含的额外工具（内置 + 启动时从 props 的 MCP）。
 *   这些与组装池合并，并在去重中优先。
 * @param mcpTools - 动态发现的 MCP 工具（来自 mcp 状态）
 * @param toolPermissionContext - 用于过滤的权限上下文
 */
export function useMergedTools(
  initialTools: Tools,
  mcpTools: Tools,
  toolPermissionContext: ToolPermissionContext,
): Tools {
  let replBridgeEnabled = false
  let replBridgeOutboundOnly = false
  return useMemo(() => {
		// assembleToolPool 是 REPL 和 runAgent 都使用的共享函数。
		// 它处理：getTools() + MCP 拒绝规则过滤 + 去重 + MCP CLI 排除。
		const assembled = assembleToolPool(toolPermissionContext, mcpTools);

		return mergeAndFilterTools(
			initialTools,
			assembled,
			toolPermissionContext.mode,
		);
  }, [
    initialTools,
    mcpTools,
    toolPermissionContext,
    replBridgeEnabled,
    replBridgeOutboundOnly,
  ])
}
