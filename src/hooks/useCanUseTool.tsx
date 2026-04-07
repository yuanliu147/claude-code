import { feature } from 'bun:bundle'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import * as React from 'react'
import { useCallback } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { Text } from '@anthropic/ink'
import type {
  ToolPermissionContext,
  Tool as ToolType,
  ToolUseContext,
} from '../Tool.js'
import {
  consumeSpeculativeClassifierCheck,
  peekSpeculativeClassifierCheck,
} from '../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { AssistantMessage } from '../types/message.js'
import { recordAutoModeDenial } from '../utils/autoModeDenials.js'
import {
  clearClassifierChecking,
  setClassifierApproval,
  setYoloClassifierApproval,
} from '../utils/classifierApprovals.js'
import { logForDebugging } from '../utils/debug.js'
import { AbortError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { handleCoordinatorPermission } from './toolPermission/handlers/coordinatorHandler.js'
import { handleInteractivePermission } from './toolPermission/handlers/interactiveHandler.js'
import { handleSwarmWorkerPermission } from './toolPermission/handlers/swarmWorkerHandler.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
} from './toolPermission/PermissionContext.js'
import { logPermissionDecision } from './toolPermission/permissionLogging.js'

export type CanUseToolFn<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = (
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision<Input>,
) => Promise<PermissionDecision<Input>>

function useCanUseTool(
  setToolUseConfirmQueue: React.Dispatch<
    React.SetStateAction<ToolUseConfirm[]>
  >,
  setToolPermissionContext: (context: ToolPermissionContext) => void,
): CanUseToolFn {
  return useCallback<CanUseToolFn>(
    async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      return new Promise(resolve => {
        const ctx = createPermissionContext(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
          setToolPermissionContext,
          createPermissionQueueOps(setToolUseConfirmQueue),
        )

        if (ctx.resolveIfAborted(resolve)) return

        const decisionPromise =
          forceDecision !== undefined
            ? Promise.resolve(forceDecision)
            : hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )

        return decisionPromise
          .then(async (result) => {
				// [仅 ANT] 记录所有工具权限决策及工具名称和参数
				if (process.env.USER_TYPE === "ant") {
					logEvent("tengu_internal_tool_permission_decision", {
						toolName: sanitizeToolNameForAnalytics(tool.name),
						behavior:
							result.behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
						// 注意：输入包含代码/文件路径，仅为 ant 记录
						input: jsonStringify(
							input,
						) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
						messageID:
							ctx.messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
						isMcp: tool.isMcp ?? false,
					});
				}

				// 拥有使用工具的权限，在配置中授予
				if (result.behavior === "allow") {
					if (ctx.resolveIfAborted(resolve)) return;
					// 跟踪自动模式分类器批准以供 UI 显示
					if (
						feature("TRANSCRIPT_CLASSIFIER") &&
						result.decisionReason?.type === "classifier" &&
						result.decisionReason.classifier === "auto-mode"
					) {
						setYoloClassifierApproval(
							toolUseID,
							result.decisionReason.reason,
						);
					}

					ctx.logDecision({ decision: "accept", source: "config" });

					resolve(
						ctx.buildAllow(result.updatedInput ?? input, {
							decisionReason: result.decisionReason,
						}),
					);
					return;
				}

				const appState = toolUseContext.getAppState();
				const description = await tool.description(input as never, {
					isNonInteractiveSession:
						toolUseContext.options.isNonInteractiveSession,
					toolPermissionContext: appState.toolPermissionContext,
					tools: toolUseContext.options.tools,
				});

				if (ctx.resolveIfAborted(resolve)) return;

				// 没有使用工具的权限，检查行为
				switch (result.behavior) {
					case "deny": {
						logPermissionDecision(
							{
								tool,
								input,
								toolUseContext,
								messageId: ctx.messageId,
								toolUseID,
							},
							{ decision: "reject", source: "config" },
						);
						if (
							feature("TRANSCRIPT_CLASSIFIER") &&
							result.decisionReason?.type === "classifier" &&
							result.decisionReason.classifier === "auto-mode"
						) {
							recordAutoModeDenial({
								toolName: tool.name,
								display: description,
								reason: result.decisionReason.reason ?? "",
								timestamp: Date.now(),
							});
							toolUseContext.addNotification?.({
								key: "auto-mode-denied",
								priority: "immediate",
								jsx: (
									<>
										<Text color="error">
											{tool
												.userFacingName(input)
												.toLowerCase()}{" "}
											denied by auto mode
										</Text>
										<Text dimColor> · /permissions</Text>
									</>
								),
							});
						}
						resolve(result);
						return;
					}

					case "ask": {
						// 对于协调者 worker，在显示对话框前等待自动化检查。
						// 后台 worker 应仅在自动化检查无法决定时打断用户。
						if (
							appState.toolPermissionContext
								.awaitAutomatedChecksBeforeDialog
						) {
							const coordinatorDecision =
								await handleCoordinatorPermission({
									ctx,
									...(feature("BASH_CLASSIFIER")
										? {
												pendingClassifierCheck:
													result.pendingClassifierCheck,
											}
										: {}),
									updatedInput: result.updatedInput,
									suggestions: result.suggestions,
									permissionMode:
										appState.toolPermissionContext.mode,
								});
							if (coordinatorDecision) {
								resolve(coordinatorDecision);
								return;
							}
							// null 意味着自动化检查都没有解决——继续下面的对话框。
							// 钩子已经运行，分类器已经消耗。
						}

						// 等待自动化检查后，验证请求在此期间是否已中止。
						// 没有此检查，可能会出现陈旧的对话框。
						if (ctx.resolveIfAborted(resolve)) return;

						// 对于 swarm worker，尝试分类器自动批准，然后
						// 通过 mailbox 将权限请求转发给 leader。
						const swarmDecision = await handleSwarmWorkerPermission(
							{
								ctx,
								description,
								...(feature("BASH_CLASSIFIER")
									? {
											pendingClassifierCheck:
												result.pendingClassifierCheck,
										}
									: {}),
								updatedInput: result.updatedInput,
								suggestions: result.suggestions,
							},
						);
						if (swarmDecision) {
							resolve(swarmDecision);
							return;
						}

						// 宽限期：等待最多 2 秒让推测性分类器
						// 在显示对话框前解析（仅限主 agent）
						if (
							feature("BASH_CLASSIFIER") &&
							result.pendingClassifierCheck &&
							tool.name === BASH_TOOL_NAME &&
							!appState.toolPermissionContext
								.awaitAutomatedChecksBeforeDialog
						) {
							const speculativePromise =
								peekSpeculativeClassifierCheck(
									(input as { command: string }).command,
								);
							if (speculativePromise) {
								const raceResult = await Promise.race([
									speculativePromise.then((r) => ({
										type: "result" as const,
										result: r,
									})),
									new Promise<{ type: "timeout" }>((res) =>
										// eslint-disable-next-line no-restricted-syntax -- resolves with a value, not void
										setTimeout(res, 2000, {
											type: "timeout" as const,
										}),
									),
								]);

								if (ctx.resolveIfAborted(resolve)) return;

								if (
									raceResult.type === "result" &&
									raceResult.result.matches &&
									raceResult.result.confidence === "high" &&
									feature("BASH_CLASSIFIER")
								) {
									// Classifier approved within grace period — skip dialog
									void consumeSpeculativeClassifierCheck(
										(input as { command: string }).command,
									);

									const matchedRule =
										raceResult.result.matchedDescription ??
										undefined;
									if (matchedRule) {
										setClassifierApproval(
											toolUseID,
											matchedRule,
										);
									}

									ctx.logDecision({
										decision: "accept",
										source: { type: "classifier" },
									});
									resolve(
										ctx.buildAllow(
											result.updatedInput ??
												(input as Record<
													string,
													unknown
												>),
											{
												decisionReason: {
													type: "classifier" as const,
													classifier:
														"bash_allow" as const,
													reason: `Allowed by prompt rule: "${raceResult.result.matchedDescription}"`,
												},
											},
										),
									);
									return;
								}
								// 超时或无匹配——继续显示对话框
							}
						}

						// 显示对话框并在后台启动钩子/分类器
						handleInteractivePermission(
							{
								ctx,
								description,
								result,
								awaitAutomatedChecksBeforeDialog:
									appState.toolPermissionContext
										.awaitAutomatedChecksBeforeDialog,
								bridgeCallbacks: feature("BRIDGE_MODE")
									? appState.replBridgePermissionCallbacks
									: undefined,
								channelCallbacks:
									feature("KAIROS") ||
									feature("KAIROS_CHANNELS")
										? appState.channelPermissionCallbacks
										: undefined,
							},
							resolve,
						);

						return;
					}
				}
			};)
          .catch(error => {
            if (
              error instanceof AbortError ||
              error instanceof APIUserAbortError
            ) {
              logForDebugging(
                `Permission check threw ${error.constructor.name} for tool=${tool.name}: ${error.message}`,
              )
              ctx.logCancelled()
              resolve(ctx.cancelAndAbort(undefined, true))
            } else {
              logError(error)
              resolve(ctx.cancelAndAbort(undefined, true))
            }
          })
          .finally(() => {
            clearClassifierChecking(toolUseID)
          })
      })
    },
    [setToolUseConfirmQueue, setToolPermissionContext],
  )
}

export default useCanUseTool
