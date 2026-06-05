// 这些副作用必须在所有其他导入之前运行：
// 1. profileCheckpoint 在重型模块评估开始之前标记入口
// 2. startMdmRawRead 启动 MDM 子进程（plutil/reg query），以便它们与
//    下面剩余的 ~135ms 导入并行运行
// 3. startKeychainPrefetch 并行启动两个 macOS 钥匙串读取（OAuth + 旧 API
//    key）——否则 isRemoteManagedSettingsEligible() 通过 applySafeConfigEnvironmentVariables()
//    内的同步生成顺序读取它们（每次 macOS 启动 ~65ms）
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry')

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead()

import {
  ensureKeychainPrefetchCompleted,
  startKeychainPrefetch,
} from './utils/secureStorage/keychainPrefetch.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch()

import { feature } from 'bun:bundle'
import {
  Command as CommanderCommand,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings'
import chalk from 'chalk'
import { readFileSync } from 'fs'
import mapValues from 'lodash-es/mapValues.js'
import pickBy from 'lodash-es/pickBy.js'
import uniqBy from 'lodash-es/uniqBy.js'
import React from 'react'
import { getOauthConfig } from './constants/oauth.js'
import { getRemoteSessionUrl } from './constants/product.js'
import { getSystemContext, getUserContext } from './context.js'
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js'
import { addToHistory } from './history.js'
import type { Root } from '@anthropic/ink'
import { launchRepl } from './replLauncher.js'
import {
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
  refreshGrowthBookAfterAuthChange,
} from './services/analytics/growthbook.js'
import { fetchBootstrapData } from './services/api/bootstrap.js'
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from './services/api/filesApi.js'
import { prefetchPassesEligibility } from './services/api/referral.js'
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js'
import type {
  McpSdkServerConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
} from './services/mcp/types.js'
import {
  isPolicyAllowed,
  loadPolicyLimits,
  refreshPolicyLimits,
  waitForPolicyLimitsToLoad,
} from './services/policyLimits/index.js'
import {
  loadRemoteManagedSettings,
  refreshRemoteManagedSettings,
} from './services/remoteManagedSettings/index.js'
import type { ToolInputJSONSchema } from './Tool.js'
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { getTools } from './tools.js'
import {
  canUserConfigureAdvisor,
  getInitialAdvisorSetting,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from './utils/advisor.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { count, uniq } from './utils/array.js'
import { installAsciicastRecorder } from './utils/asciicast.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  prefetchAwsCredentialsAndBedRockInfoIfSafe,
  prefetchGcpCredentialsIfSafe,
  validateForceLoginOrg,
} from './utils/auth.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getRemoteControlAtStartup,
  isAutoUpdaterDisabled,
  saveGlobalConfig,
} from './utils/config.js'
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js'
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js'
import {
  getInitialFastModeSetting,
  isFastModeEnabled,
  prefetchFastModeStatus,
  resolveFastModeStatusFromCache,
} from './utils/fastMode.js'
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js'
import { createSystemMessage, createUserMessage } from './utils/messages.js'
import { getPlatform } from './utils/platform.js'
import { getBaseRenderOptions } from './utils/renderOptions.js'
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js'
import { settingsChangeDetector } from './utils/settings/changeDetector.js'
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js'
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js'
import { computeInitialTeamContext } from './utils/swarm/reconnection.js'
import { initializeWarningHandler } from './utils/warningHandler.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'

// 惰性 require 以避免循环依赖：teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js')
const getTeammatePromptAddendum = () =>
  require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js')
const getTeammateModeSnapshot = () =>
  require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js')
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：COODINATOR_MODE 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：KAIROS（助手模式）的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS')
  ? (require('./assistant/index.js') as typeof import('./assistant/index.js'))
  : null
const kairosGate = feature('KAIROS')
  ? (require('./assistant/gate.js') as typeof import('./assistant/gate.js'))
  : null

import { relative, resolve } from 'path'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'

import {
  getOriginalCwd,
  setAdditionalDirectoriesForClaudeMd,
  setIsRemoteMode,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setTeleportedSessionInfo,
} from './bootstrap/state.js'
import { filterCommandsForRemoteMode, getCommands } from './commands.js'
import type { StatsStore } from './context/stats.js'
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
  launchInvalidSettingsDialog,
  launchResumeChooser,
  launchSnapshotUpdateDialog,
  launchTeleportRepoMismatchDialog,
  launchTeleportResumeWrapper,
} from './dialogLaunchers.js'
import { SHOW_CURSOR } from '@anthropic/ink'
import {
  exitWithError,
  exitWithMessage,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from './interactiveHelpers.js'
import { initBuiltinPlugins } from './plugins/bundled/index.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/claudeAiLimits.js'
import {
  getMcpToolsCommandsAndResources,
  prefetchAllMcpResources,
} from './services/mcp/client.js'
import {
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from './services/plugins/pluginCliCommands.js'
import { initBundledSkills } from './skills/bundled/index.js'
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
  isCustomAgent,
  parseAgentsFromJson,
} from './tools/AgentTool/loadAgentsDir.js'
import type { LogOption } from './types/logs.js'
import type { Message as MessageType } from './types/message.js'
import { assertMinVersion } from './utils/autoUpdater.js'
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from './utils/claudeInChrome/prompt.js'
import {
  setupClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from './utils/claudeInChrome/setup.js'
import { getContextWindowForModel } from './utils/context.js'
import { loadConversationForResume } from './utils/conversationRecovery.js'
import { buildDeepLinkBanner } from './utils/deepLink/banner.js'
import {
  hasNodeOption,
  isBareMode,
  isEnvTruthy,
  isInProtectedNamespace,
} from './utils/envUtils.js'
import { refreshExampleCommands } from './utils/exampleCommands.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getWorktreePaths } from './utils/getWorktreePaths.js'
import {
  findGitRoot,
  getBranch,
  getIsGit,
  getWorktreeCount,
} from './utils/git.js'
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js'
import { safeParseJSON } from './utils/json.js'
import { logError } from './utils/log.js'
import { getModelDeprecationWarning } from './utils/model/deprecation.js'
import {
  getDefaultMainLoopModel,
  getUserSpecifiedModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js'
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js'
import {
  checkAndDisableBypassPermissions,
  getAutoModeEnabledStateIfCached,
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  verifyAutoModeGateAccess,
} from './utils/permissions/permissionSetup.js'
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js'
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js'
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js'
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js'
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js'
import { countFilesRoundedRg } from './utils/ripgrep.js'
import {
  processSessionStartHooks,
  processSetupHooks,
} from './utils/sessionStart.js'
import {
  cacheSessionTitle,
  getSessionIdFromLog,
  loadTranscriptFromFile,
  saveAgentSetting,
  saveMode,
  searchSessionsByCustomTitle,
  sessionIdExists,
} from './utils/sessionStorage.js'
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js'
import {
  getInitialSettings,
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
  getSettingsWithErrors,
} from './utils/settings/settings.js'
import { resetSettingsCache } from './utils/settings/settingsCache.js'
import type { ValidationError } from './utils/settings/validation.js'
import {
  DEFAULT_TASKS_MODE_TASK_LIST_ID,
  TASK_STATUSES,
} from './utils/tasks.js'
import {
  logPluginLoadErrors,
  logPluginsEnabledForSession,
} from './utils/telemetry/pluginTelemetry.js'
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js'
import { generateTempFilePath } from './utils/tempfile.js'
import { validateUuid } from './utils/uuid.js'
// 插件启动检查现在在 REPL.tsx 中非阻塞处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js'
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js'
import { logPermissionContextForAnts } from 'src/services/internalLogging.js'
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/services/mcp/claudeai.js'
import { clearServerCache } from 'src/services/mcp/client.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  getMcpServerSignature,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js'
import {
  excludeCommandsByServer,
  excludeResourcesByServer,
} from 'src/services/mcp/utils.js'
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js'
import { getRelevantTips } from 'src/services/tips/tipRegistry.js'
import { logContextMetrics } from 'src/utils/api.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  isClaudeInChromeMCPServer,
} from 'src/utils/claudeInChrome/common.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { eagerParseCliFlag } from 'src/utils/cliArgs.js'
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionName,
} from 'src/utils/concurrentSessions.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js'
import {
  errorMessage,
  getErrnoCode,
  isENOENT,
  TeleportOperationError,
  toError,
} from 'src/utils/errors.js'
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
} from 'src/utils/gracefulShutdown.js'
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js'
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js'
import { peekForStdinData, writeToStderr } from 'src/utils/process.js'
import { setCwd } from 'src/utils/Shell.js'
import {
  type ProcessedResume,
  processResumedConversation,
} from 'src/utils/sessionRestore.js'
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js'
import { plural } from 'src/utils/stringUtils.js'
import {
  type ChannelEntry,
  getInitialMainLoopModel,
  getIsNonInteractiveSession,
  getSdkBetas,
  getSessionId,
  getUserMsgOptIn,
  setAllowedChannels,
  setAllowedSettingSources,
  setChromeFlagOverride,
  setClientType,
  setCwdState,
  setDirectConnectServerUrl,
  setFlagSettingsPath,
  setInitialMainLoopModel,
  setInlinePlugins,
  setIsInteractive,
  setKairosActive,
  setOriginalCwd,
  setQuestionPreviewFormat,
  setSdkBetas,
  setSessionBypassPermissionsMode,
  setSessionPersistenceDisabled,
  setSessionSource,
  setUserMsgOptIn,
  switchSession,
} from './bootstrap/state.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js'))
  : null

// TeleportRepoMismatchDialog、TeleportResumeWrapper 在调用点动态导入
import { migrateAutoUpdatesToSettings } from './migrations/migrateAutoUpdatesToSettings.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js'
import { migrateFennecToOpus } from './migrations/migrateFennecToOpus.js'
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js'
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js'
import { migrateSonnet45ToSonnet46 } from './migrations/migrateSonnet45ToSonnet46.js'
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js'
import { resetProToOpusDefault } from './migrations/resetProToOpusDefault.js'
import { createRemoteSessionConfig } from './remote/RemoteSessionManager.js'
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress 在调用点动态导入
import {
  createDirectConnectSession,
  DirectConnectError,
} from './server/createDirectConnectSession.js'
import { initializeLspServerManager } from './services/lsp/manager.js'
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js'
import {
  type AppState,
  getDefaultAppState,
  IDLE_SPECULATION_STATE,
} from './state/AppStateStore.js'
import { onChangeAppState } from './state/onChangeAppState.js'
import { createStore } from './state/store.js'
import { asSessionId } from './types/ids.js'
import { filterAllowedSdkBetas } from './utils/betas.js'
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import {
  filterExistingPaths,
  getKnownPathsForRepo,
} from './utils/githubRepoPathMapping.js'
import {
  clearPluginCache,
  loadAllPluginsCacheOnly,
} from './utils/plugins/pluginLoader.js'
import { migrateChangelogFromConfig } from './utils/releaseNotes.js'
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js'
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  teleportToRemoteWithErrorHandling,
  validateGitState,
  validateSessionRepository,
} from './utils/teleport.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'
import { initUser, resetUserCache } from './utils/user.js'
import { initializeAnalyticsGates } from './services/analytics/sink.js'
import {
  getTmuxInstallInstructions,
  isTmuxAvailable,
  parsePRReference,
} from './utils/worktree.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded')

/**
 * 将托管设置键记录到 Statsig 用于分析。
 * 这在 init() 完成后调用，以确保在模型解析之前
 * 加载了设置并应用了环境变量。
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings')
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings)
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(
          ',',
        ) as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch {
    // 静默忽略错误——这只是用于分析
  }
}

// 检查是否在调试/检查模式中
function isBeingDebugged() {
  const isBun = isRunningWithBun()

  // 检查进程参数中的 inspect 标志（包括所有变体）
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // 注意：Bun 在单文件可执行文件上有问题，应用程序参数
      // 从 process.argv 泄漏到 process.execArgv（类似于 https://github.com/oven-sh/bun/issues/11673）
      // 如果我们省略这个分支，这会破坏 --debug 模式的使用
      // 我们可以跳过该检查，因为 Bun 不支持 Node.js 遗留的 --debug 或 --debug-brk 标志
      return /--inspect(-brk)?/.test(arg)
    } else {
      // 在 Node.js 中，检查 --inspect 和遗留的 --debug 标志
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg)
    }
  })

  // 检查 NODE_OPTIONS 是否包含 inspect 标志
  const hasInspectEnv =
    process.env.NODE_OPTIONS &&
    /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS)

  // 检查检查器是否可用且处于活动状态（表示正在调试）
  try {
    // 动态导入会更好，但是异步的——改为使用全局对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector')
    const hasInspectorUrl = !!inspector.url()
    return hasInspectorUrl || hasInspectArg || hasInspectEnv
  } catch {
    // 忽略错误并回退到参数检测
    return hasInspectArg || hasInspectEnv
  }
}

// 如果检测到节点调试或检查则退出
if ("external" !== 'ant' && isBeingDebugged()) {
  // 由于我们在顶级代码中导入之前直接使用 process.exit，
  // gracefulShutdown 尚不可用
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1)
}

/**
 * 每个会话的技能/插件遥测。从交互路径和
 * 头less -p 路径（在 runHeadless 之前）调用——两者都经过
 * main.tsx，但在交互启动路径之前分支，所以它需要两个
 * 此处的调用站点，而不是一个在此处 + 一个在 QueryEngine 中。
 */
function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(
    getInitialMainLoopModel() ?? getDefaultMainLoopModel(),
  )
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()))
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames()
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs())
      logPluginLoadErrors(errors, managedNames)
    })
    .catch(err => logError(err))
}

function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true
  }
  return result
}

async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([
    getIsGit(),
    getWorktreeCount(),
    getGhAuthStatus(),
  ])

  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status:
      ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed:
      SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled:
      SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  })
}

// @[MODEL LAUNCH]: 考虑模型字符串可能需要的任何迁移。参见 migrateSonnet1mToSonnet45.ts 示例。
// 添加新的同步迁移时增加此值，以便现有用户重新运行集合。
const CURRENT_MIGRATION_VERSION = 11
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings()
    migrateBypassPermissionsAcceptedToSettings()
    migrateEnableAllProjectMcpServersToSettings()
    resetProToOpusDefault()
    migrateSonnet1mToSonnet45()
    migrateLegacyOpusToCurrent()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer()
    }
    if (process.env.USER_TYPE === 'ant') {
      migrateFennecToOpus()
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION },
    )
  }
  // 异步迁移——fire and forget，因为它是非阻塞的
  migrateChangelogFromConfig().catch(() => {
    // 静默忽略迁移错误——下次启动时会重试
  })
}

/**
 * 仅在安全时预取系统上下文（包括 git 状态）。
 * Git 命令可以通过 hooks 和配置执行任意代码（例如 core.fsmonitor、
 * diff.external），所以我们必须只在信任建立后或
 * 非交互模式下（信任是隐式的）运行它们。
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()

  // 在非交互模式（--print）中，信任对话框被跳过，
  // 执行被认为是受信任的（如帮助文本中所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
    void getSystemContext()
    return
  }

  // 在交互模式中，仅在信任已建立时预取
  const hasTrust = checkHasTrustDialogAccepted()
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
    void getSystemContext()
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
  }
  // 否则，不预取——等待信任首先建立
}

/**
 * 启动不需要在首次渲染之前完成的后台预取和清理。
 * 这些从 setup() 延迟以减少关键启动路径中的事件循环竞争和子进程生成。
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // 此函数在首次渲染后运行，所以它不会阻塞初始绘制。
  // 但是，生成的进程和异步工作仍会争夺 CPU 和事件
  // 循环时间，这会扭曲启动基准测试（CPU 配置、首次渲染时间
  // 测量）。当我们只测量启动性能时，跳过所有这些。
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare: skip ALL prefetches. These are cache-warms for the REPL's
    // first-turn responsiveness (initUser, getUserContext, tips, countFiles,
    // modelCapabilities, change detectors). Scripted -p calls don't have a
    // "user is typing" window to hide this work in — it's pure overhead on
    // the critical path.
    isBareMode()
  ) {
    return
  }

  // 进程生成预取（在首次 API 调用时消费，用户仍在输入）
  void initUser()
  void getUserContext()
  prefetchSystemContextIfSafe()
  void getRelevantTips()
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)
  ) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe()
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
  ) {
    void prefetchGcpCredentialsIfSafe()
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), [])

  // 分析和功能标志初始化
  void initializeAnalyticsGates()
  void prefetchOfficialMcpUrls()

  void refreshModelCapabilities()

  // 文件更改检测器从 init() 延迟以解锁首次渲染
  void settingsChangeDetector.initialize()
  if (!isBareMode()) {
    void skillChangeDetector.initialize()
  }

  // 事件循环停滞检测器——当主线程被阻塞 >500ms 时记录
  if (process.env.USER_TYPE === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m =>
      m.startEventLoopStallDetector(),
    )
  }
}

function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson =
      trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')

    let settingsPath: string

    if (looksLikeJson) {
      // 这是一个 JSON 字符串——验证并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(
          chalk.red('Error: Invalid JSON provided to --settings\n'),
        )
        process.exit(1)
      }

      // 创建一个临时文件并将 JSON 写入其中。
      // 使用基于内容哈希的路径而不是随机 UUID，以避免
      // 破坏 Anthropic API 提示缓存。设置路径最终位于
      // Bash 工具的 sandbox denyWithinAllow 列表中，这是
      // 发送给 API 的工具描述的一部分。每个子进程的随机 UUID
      // 在每次 query() 调用时更改工具描述，使
      // 缓存前缀失效并导致 12 倍的输入令牌成本惩罚。
      // 内容哈希确保相同的设置在跨进程边界时产生相同的路径
      // （每个 SDK query() 都会生成一个新进程）。
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      // 这是一个文件路径——通过尝试读取来解析和验证
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(
        getFsImplementation(),
        settingsFile,
      )
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(
            chalk.red(
              `Error: Settings file not found: ${resolvedSettingsPath}\n`,
            ),
          )
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }

    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(
      chalk.red(`Error processing settings: ${errorMessage(error)}\n`),
    )
    process.exit(1)
  }
}

function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(
      chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`),
    )
    process.exit(1)
  }
}

/**
 * Parse and load settings flags early, before init()
 * This ensures settings are filtered from the start of initialization
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  // 提前解析 --settings 标志以确保设置在 init() 之前加载
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  // 提前解析 --setting-sources 标志以控制加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
  profileCheckpoint('eagerLoadSettings_end')
}

function initializeEntrypoint(isNonInteractive: boolean): void {
  // 如果已设置则跳过（例如，由 SDK 或其他入口点）
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return
  }

  const cliArgs = process.argv.slice(2)

  // 检查 MCP serve 命令（在 mcp serve 之前处理标志，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp')
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp'
    return
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action'
    return
  }

  // 注意：'local-agent' 入口点由本地 agent 模式启动器通过
  // CLAUDE_CODE_ENTRYPOINT 环境变量设置（由上面的提前返回处理）

  // 基于交互状态设置
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}

// 在早期 argv 处理期间设置，当检测到 `claude open <url>` 时（仅交互模式）
type PendingConnect = {
  url: string | undefined
  authToken: string | undefined
  dangerouslySkipPermissions: boolean
}
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT')
  ? { url: undefined, authToken: undefined, dangerouslySkipPermissions: false }
  : undefined

// 在早期 argv 处理期间设置，当检测到 `claude assistant [sessionId]` 时
type PendingAssistantChat = { sessionId?: string; discover: boolean }
const _pendingAssistantChat: PendingAssistantChat | undefined = feature(
  'KAIROS',
)
  ? { sessionId: undefined, discover: false }
  : undefined

// `claude ssh <host> [dir]` — 从 argv 早期解析（与上面的
// DIRECT_CONNECT 相同模式），以便主命令路径获取它并为 REPL 提供
// SSH 支持的会话而不是本地会话。
type PendingSSH = {
  host: string | undefined
  cwd: string | undefined
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[]
}
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE')
  ? {
      host: undefined,
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
    }
  : undefined

export async function main() {
  profileCheckpoint('main_function_start')

  // 安全：防止 Windows 从当前目录执行命令
  // 这必须在任何命令执行之前设置，以防止 PATH 劫持攻击
  // 见：https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  // 提前初始化警告处理器以捕获警告
  initializeWarningHandler()

  process.on('exit', () => {
    resetCursor()
  })
  process.on('SIGINT', () => {
    // 在 print 模式中，print.ts 注册自己的 SIGINT 处理器来中止
    // 飞行中的查询并调用 gracefulShutdown；在这里跳过以避免
    // 用同步 process.exit() 抢占它。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    process.exit(0)
  })
  profileCheckpoint('main_warning_handler_initialized')

  // 检查 argv 中的 cc:// 或 cc+unix:// URL——重写以便主命令
  // 处理它，提供完整的交互式 TUI 而不是精简的子命令。
  // 对于无头（-p），我们重写为内部 `open` 子命令。
  if (feature('DIRECT_CONNECT')) {
    const rawCliArgs = process.argv.slice(2)
    const ccIdx = rawCliArgs.findIndex(
      a => a.startsWith('cc://') || a.startsWith('cc+unix://'),
    )
    if (ccIdx !== -1 && _pendingConnect) {
      const ccUrl = rawCliArgs[ccIdx]!
      const { parseConnectUrl } = await import('./server/parseConnectUrl.js')
      const parsed = parseConnectUrl(ccUrl)
      _pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes(
        '--dangerously-skip-permissions',
      )

      if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
        // 无头模式：重写为内部 `open` 子命令
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1)
        }
        process.argv = [
          process.argv[0]!,
          process.argv[1]!,
          'open',
          ccUrl,
          ...stripped,
        ]
      } else {
        // 交互模式：剥离 cc:// URL 和标志，运行主命令
        _pendingConnect.url = parsed.serverUrl
        _pendingConnect.authToken = parsed.authToken
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1)
        }
        process.argv = [process.argv[0]!, process.argv[1]!, ...stripped]
      }
    }
  }

  // 提前处理深度链接 URI——这由 OS 协议处理器调用，
  // 应该在完整 init 之前退出，因为它只需要解析 URI 并打开终端。
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri')
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const { enableConfigs } = await import('./utils/config.js')
      enableConfigs()
      const uri = process.argv[handleUriIdx + 1]!
      const { handleDeepLinkUri } = await import(
        './utils/deepLink/protocolHandler.js'
      )
      const exitCode = await handleDeepLinkUri(uri)
      process.exit(exitCode)
    }

    // macOS URL 处理器：当 LaunchServices 启动我们的 .app bundle 时，
    // URL 通过 Apple Event 到达（不是 argv）。LaunchServices 覆盖
    // __CFBundleIdentifier 为启动 bundle 的 ID，这是一个精确的
    // 肯定信号——比导入和用启发式猜测更便宜。
    if (
      process.platform === 'darwin' &&
      process.env.__CFBundleIdentifier ===
        'com.anthropic.claude-code-url-handler'
    ) {
      const { enableConfigs } = await import('./utils/config.js')
      enableConfigs()
      const { handleUrlSchemeLaunch } = await import(
        './utils/deepLink/protocolHandler.js'
      )
      const urlSchemeResult = await handleUrlSchemeLaunch()
      process.exit(urlSchemeResult ?? 1)
    }
  }

  // `claude assistant [sessionId]` — stash and strip so the main
  // command handles it, giving the full interactive TUI. Position-0 only
  // (matching the ssh pattern below) — indexOf would false-positive on
  // `claude -p "explain assistant"`. Root-flag-before-subcommand
  // (e.g. `--debug assistant`) falls through to the stub, which
  // prints usage.
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2)
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1]
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg
        rawArgs.splice(0, 2) // drop 'assistant' and sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true
        rawArgs.splice(0, 1) // drop 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
      }
      // else: `claude assistant --help` → fall through to stub
    }
  }

  // `claude ssh <host> [dir]` — strip from argv so the main command handler
  // runs (full interactive TUI), stash the host/dir for the REPL branch at
  // ~line 3720 to pick up. Headless (-p) mode not supported in v1: SSH
  // sessions need the local REPL to drive them (interrupt, permissions).
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2)
    // SSH 特定标志可以出现在 host 位置参数之前（例如
    // `ssh --permission-mode auto host /tmp`——标准 POSIX 标志优先于
    // 位置参数）。在检查是否提供了 host 之前将它们全部抽出，
    // 以便 `claude ssh --permission-mode auto host` 和 `claude ssh host
    // --permission-mode auto` 等效。下面的 host 检查只需要
    // 防范 `-h`/`--help`（commander 应该处理）。
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local')
      if (localIdx !== -1) {
        _pendingSSH.local = true
        rawCliArgs.splice(localIdx, 1)
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions')
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true
        rawCliArgs.splice(dspIdx, 1)
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode')
      if (
        pmIdx !== -1 &&
        rawCliArgs[pmIdx + 1] &&
        !rawCliArgs[pmIdx + 1]!.startsWith('-')
      ) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1]
        rawCliArgs.splice(pmIdx, 2)
      }
      const pmEqIdx = rawCliArgs.findIndex(a =>
        a.startsWith('--permission-mode='),
      )
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1]
        rawCliArgs.splice(pmEqIdx, 1)
      }
      // 将 session-resume + model 标志转发到远程 CLI 的初始生成。
      // --continue/-c 和 --resume <uuid> 操作远程会话历史
      // （它保存在远程的 ~/.claude/projects/<cwd>/ 下）。
      // --model 控制远程使用的模型。
      const extractFlag = (
        flag: string,
        opts: { hasValue?: boolean; as?: string } = {},
      ) => {
        const i = rawCliArgs.indexOf(flag)
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag)
          const val = rawCliArgs[i + 1]
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val)
            rawCliArgs.splice(i, 2)
          } else {
            rawCliArgs.splice(i, 1)
          }
        }
        const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`))
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(
            opts.as ?? flag,
            rawCliArgs[eqI]!.slice(flag.length + 1),
          )
          rawCliArgs.splice(eqI, 1)
        }
      }
      extractFlag('-c', { as: '--continue' })
      extractFlag('--continue')
      extractFlag('--resume', { hasValue: true })
      extractFlag('--model', { hasValue: true })
    }
    // 预提取之后，[1] 处任何剩余的 dash-arg 要么是 -h/--help
    // （commander 处理），要么是 ssh 不知道的标志（落入 commander
    // 以便它显示正确的错误）。只有 non-dash arg 才是 host。
    if (
      rawCliArgs[0] === 'ssh' &&
      rawCliArgs[1] &&
      !rawCliArgs[1].startsWith('-')
    ) {
      _pendingSSH.host = rawCliArgs[1]
      // 可选的位置参数 cwd。
      let consumed = 2
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2]
        consumed = 3
      }
      const rest = rawCliArgs.slice(consumed)

      // 无头（-p）模式在 v1 中不支持 SSH——尽早拒绝，
      // 以便标志不会静默导致本地执行。
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write(
          'Error: headless (-p/--print) mode is not supported with claude ssh\n',
        )
        gracefulShutdownSync(1)
        return
      }

      // 重写 argv，以便主命令看到剩余标志但不包含 `ssh`。
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest]
    }
  }

  // 提前检查 -p/--print 和 --init-only 标志以在 init() 之前设置 isInteractiveSession
  // 这是必需的，因为遥测初始化调用需要此标志的 auth 函数
  const cliArgs = process.argv.slice(2)
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
  const hasInitOnlyFlag = cliArgs.includes('--init-only')
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))
  const isNonInteractive =
    hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

  // 停止捕获非交互模式的早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }

  // 设置简化的跟踪字段
  const isInteractive = !isNonInteractive
  setIsInteractive(isInteractive)

  // 基于模式初始化入口点——需要在任何事件记录之前设置
  initializeEntrypoint(isNonInteractive)

  // 确定客户端类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode')
      return 'claude-vscode'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent')
      return 'local-agent'
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop')
      return 'claude-desktop'

    // 检查是否提供了 session-ingress token（表示远程会话）
    const hasSessionIngressToken =
      process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN ||
      process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
    if (
      process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' ||
      hasSessionIngressToken
    ) {
      return 'remote'
    }

    return 'cli'
  })()
  setClientType(clientType)

  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat)
  } else if (
    !clientType.startsWith('sdk-') &&
    // Desktop 和 CCR 通过 toolConfig 传递 previewFormat；当功能
    // 被 gate 关闭时，它们传递 undefined——不要用 markdown 覆盖它。
    clientType !== 'claude-desktop' &&
    clientType !== 'local-agent' &&
    clientType !== 'remote'
  ) {
    setQuestionPreviewFormat('markdown')
  }

  // 标记通过 `claude remote-control` 创建的会话，以便后端可以识别它们
  if (process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control')
  }

  profileCheckpoint('main_client_type_determined')

  // 在 init() 之前提前解析和加载设置标志
  eagerLoadSettings()

  profileCheckpoint('main_before_run')

  await run()
  profileCheckpoint('main_after_run')
}

async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (
    !process.stdin.isTTY &&
    // 输入劫持会破坏 MCP。
    !process.argv.includes('mcp')
  ) {
    if (inputFormat === 'stream-json') {
      return process.stdin
    }
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    // 如果 3 秒内没有数据到达，停止等待并发出警告。Stdin 可能是
    // 从不写入的父进程继承的管道（子进程生成时没有明确的 stdin 处理）。
    // 3 秒涵盖慢生产者，如 curl、在大文件上的 jq、有导入开销的 python。
    // 该警告使罕见的更慢生产者的静默数据丢失可见。
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}

async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start')

  // 创建按长选项名排序选项的帮助配置。
  // Commander 在运行时支持 compareOptions，但 @commander-js/extra-typings
  // 在类型定义中不包含它，所以我们使用 Object.assign 来添加它。
  function createSortedHelpConfig(): {
    sortSubcommands: true
    sortOptions: true
  } {
    const getOptionSortKey = (opt: Option): string =>
      opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? ''
    return Object.assign(
      { sortSubcommands: true, sortOptions: true } as const,
      {
        compareOptions: (a: Option, b: Option) =>
          getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
      },
    )
  }
  const program = new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
  profileCheckpoint('run_commander_initialized')

  // 使用 preAction hook 仅在执行命令时运行初始化，
  // 而不是在显示帮助时。这避免了环境变量信号的需要。
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start')
    // 等待在模块评估时启动的异步子进程加载（第 12-20 行）。
    // 几乎免费——子进程在上述约 135ms 的导入期间完成。
    // 必须在 init() 之前解析，init() 触发第一次设置读取
    // (applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → sync keychain reads otherwise ~65ms).
    await Promise.all([
      ensureMdmSettingsLoaded(),
      ensureKeychainPrefetchCompleted(),
    ])
    profileCheckpoint('preAction_after_mdm')
    await init()
    profileCheckpoint('preAction_after_init')

    // process.title on Windows sets the console title directly; on POSIX,
    // terminal shell integration may mirror the process name to the tab.
    // 在 init() 之后，以便 settings.json env 也可以限制此（gh-4765）。
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude'
    }

    // 连接日志接收器，以便子命令处理程序可以使用 logEvent/logError。
    // 在 PR #11106 之前，logEvent 直接发送；之后，事件排队直到
    // 接收器连接。setup() 为默认命令连接接收器，但
    // 子命令（doctor、mcp、plugin、auth）从不调用 setup()，
    // 在 process.exit() 时会静默丢弃事件。两种初始化都是幂等的。
    const { initSinks } = await import('./utils/sinks.js')
    initSinks()
    profileCheckpoint('preAction_after_sinks')

    // gh-33508: --plugin-dir is a top-level program option. The default
    // action reads it from its own options destructure, but subcommands
    // (plugin list, plugin install, mcp *) have their own actions and
    // never see it. Wire it up here so getInlinePlugins() works everywhere.
    // thisCommand.opts() is typed {} here because this hook is attached
    // before .option('--plugin-dir', ...) in the chain — extra-typings
    // builds the type as options are added. Narrow with a runtime guard;
    // the collect accumulator + [] default guarantee string[] in practice.
    const pluginDir = thisCommand.getOptionValue('pluginDir')
    if (
      Array.isArray(pluginDir) &&
      pluginDir.length > 0 &&
      pluginDir.every(p => typeof p === 'string')
    ) {
      setInlinePlugins(pluginDir)
      clearPluginCache('preAction: --plugin-dir inline plugins')
    }

    runMigrations()
    profileCheckpoint('preAction_after_migrations')

    // 为企业客户加载远程托管设置（非阻塞）
    // 失败时开放——如果获取失败，继续 without 远程设置
    // 设置通过热加载在到达时应用
    // 必须在 init() 之后发生，以确保允许配置读取
    void loadRemoteManagedSettings()
    void loadPolicyLimits()

    profileCheckpoint('preAction_after_remote_settings')

    // 加载设置同步（非阻塞，失败开放）
    // CLI：将本地设置上传到远程（CCR 下载由 print.ts 处理）
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then(m =>
        m.uploadUserSettingsInBackground(),
      )
    }

    profileCheckpoint('preAction_after_settings_sync')
  })

  program
    .name('claude')
    .description(
      `Claude Code - starts an interactive session by default, use -p/--print for non-interactive output`,
    )
    .argument('[prompt]', 'Your prompt', String)
    // 子命令通过 commander 的 copyInheritedSettings 继承 helpOption——
    // 在这里设置一次涵盖 mcp、plugin、auth 和所有其他子命令。
    .helpOption('-h, --help', 'Display help for command')
    .option(
      '-d, --debug [filter]',
      'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")',
      (_value: string | true) => {
        // 如果提供了值，它将是过滤字符串
        // 如果未提供但标志存在，则值为 true
        // 实际过滤在 debug.ts 中通过解析 process.argv 处理
        return true
      },
    )
    .addOption(
      new Option('--debug-to-stderr', 'Enable debug mode (to stderr)')
        .argParser(Boolean)
        .hideHelp(),
    )
    .option(
      '--debug-file <path>',
      'Write debug logs to a specific file path (implicitly enables debug mode)',
      () => true,
    )
    .option(
      '--verbose',
      'Override verbose mode setting from config',
      () => true,
    )
    .option(
      '-p, --print',
      'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.',
      () => true,
    )
    .option(
      '--bare',
      'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.',
      () => true,
    )
    .addOption(
      new Option(
        '--init',
        'Run Setup hooks with init trigger, then continue',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--init-only',
        'Run Setup and SessionStart:startup hooks, then exit',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--maintenance',
        'Run Setup hooks with maintenance trigger, then continue',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)',
      ).choices(['text', 'json', 'stream-json']),
    )
    .addOption(
      new Option(
        '--json-schema <schema>',
        'JSON Schema for structured output validation. ' +
          'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
      ).argParser(String),
    )
    .option(
      '--include-hook-events',
      'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)',
      () => true,
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option(
        '--input-format <format>',
        'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)',
      ).choices(['text', 'stream-json']),
    )
    .option(
      '--mcp-debug',
      '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)',
      () => true,
    )
    .option(
      '--dangerously-skip-permissions',
      'Bypass all permission checks. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .option(
      '--allow-dangerously-skip-permissions',
      'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .addOption(
      new Option(
        '--thinking <mode>',
        'Thinking mode: enabled (equivalent to adaptive), disabled',
      )
        .choices(['enabled', 'adaptive', 'disabled'])
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-thinking-tokens <tokens>',
        '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-turns <turns>',
        'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-budget-usd <amount>',
        'Maximum dollar amount to spend on API calls (only works with --print)',
      ).argParser(value => {
        const amount = Number(value)
        if (isNaN(amount) || amount <= 0) {
          throw new Error(
            '--max-budget-usd must be a positive number greater than 0',
          )
        }
        return amount
      }),
    )
    .addOption(
      new Option(
        '--task-budget <tokens>',
        'API-side task budget in tokens (output_config.task_budget)',
      )
        .argParser(value => {
          const tokens = Number(value)
          if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
            throw new Error('--task-budget must be a positive integer')
          }
          return tokens
        })
        .hideHelp(),
    )
    .option(
      '--replay-user-messages',
      'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option(
        '--enable-auth-status',
        'Enable auth status messages in SDK mode',
      )
        .default(false)
        .hideHelp(),
    )
    .option(
      '--allowedTools, --allowed-tools <tools...>',
      'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")',
    )
    .option(
      '--tools <tools...>',
      'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").',
    )
    .option(
      '--disallowedTools, --disallowed-tools <tools...>',
      'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")',
    )
    .option(
      '--mcp-config <configs...>',
      'Load MCP servers from JSON files or strings (space-separated)',
    )
    .addOption(
      new Option(
        '--permission-prompt-tool <tool>',
        'MCP tool to use for permission prompts (only works with --print)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--system-prompt <prompt>',
        'System prompt to use for the session',
      ).argParser(String),
    )
    .addOption(
      new Option(
        '--system-prompt-file <file>',
        'Read system prompt from a file',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--append-system-prompt <prompt>',
        'Append a system prompt to the default system prompt',
      ).argParser(String),
    )
    .addOption(
      new Option(
        '--append-system-prompt-file <file>',
        'Read system prompt from a file and append to the default system prompt',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--permission-mode <mode>',
        'Permission mode to use for the session',
      )
        .argParser(String)
        .choices(PERMISSION_MODES),
    )
    .option(
      '-c, --continue',
      'Continue the most recent conversation in the current directory',
      () => true,
    )
    .option(
      '-r, --resume [value]',
      'Resume a conversation by session ID, or open interactive picker with optional search term',
      value => value || true,
    )
    .option(
      '--fork-session',
      'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)',
      () => true,
    )
    .addOption(
      new Option(
        '--prefill <text>',
        'Pre-fill the prompt input with text without submitting it',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-origin',
        'Signal that this session was launched from a deep link',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-repo <slug>',
        'Repo slug the deep link ?repo= parameter resolved to the current cwd',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-last-fetch <ms>',
        'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline',
      )
        .argParser(v => {
          const n = Number(v)
          return Number.isFinite(n) ? n : undefined
        })
        .hideHelp(),
    )
    .option(
      '--from-pr [value]',
      'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term',
      value => value || true,
    )
    .option(
      '--no-session-persistence',
      'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)',
    )
    .addOption(
      new Option(
        '--resume-session-at <message id>',
        'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--rewind-files <user-message-id>',
        'Restore files to state at the specified user message and exit (requires --resume)',
      ).hideHelp(),
    )
    // @[MODEL LAUNCH]：更新 --model 帮助文本中的示例模型 ID
    .option(
      '--model <model>',
      `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').`,
    )
    .addOption(
      new Option(
        '--effort <level>',
        `Effort level for the current session (low, medium, high, max)`,
      ).argParser((rawValue: string) => {
        const value = rawValue.toLowerCase()
        const allowed = ['low', 'medium', 'high', 'max']
        if (!allowed.includes(value)) {
          throw new InvalidArgumentError(
            `It must be one of: ${allowed.join(', ')}`,
          )
        }
        return value
      }),
    )
    .option(
      '--agent <agent>',
      `Agent for the current session. Overrides the 'agent' setting.`,
    )
    .option(
      '--betas <betas...>',
      'Beta headers to include in API requests (API key users only)',
    )
    .option(
      '--fallback-model <model>',
      'Enable automatic fallback to specified model when default model is overloaded (only works with --print)',
    )
    .addOption(
      new Option(
        '--workload <tag>',
        'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)',
      ).hideHelp(),
    )
    .option(
      '--settings <file-or-json>',
      'Path to a settings JSON file or a JSON string to load additional settings from',
    )
    .option(
      '--add-dir <directories...>',
      'Additional directories to allow tool access to',
    )
    .option(
      '--ide',
      'Automatically connect to IDE on startup if exactly one valid IDE is available',
      () => true,
    )
    .option(
      '--strict-mcp-config',
      'Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
      () => true,
    )
    .option(
      '--session-id <uuid>',
      'Use a specific session ID for the conversation (must be a valid UUID)',
    )
    .option(
      '-n, --name <name>',
      'Set a display name for this session (shown in /resume and terminal title)',
    )
    .option(
      '--agents <json>',
      'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')',
    )
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    // gh-33508: <paths...> (variadic) consumed everything until the next
    // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
    // `mcp` and `add` as paths, then choked on --transport as an unknown
    // top-level option. Single-value + collect accumulator means each
    // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
    .option(
      '--plugin-dir <path>',
      'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--disable-slash-commands', 'Disable all skills', () => true)
    .option('--chrome', 'Enable Claude in Chrome integration')
    .option('--no-chrome', 'Disable Claude in Chrome integration')
    .option(
      '--file <specs...>',
      'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
    )
    .action(async (prompt, options) => {
      profileCheckpoint('action_handler_start')

      // --bare = one-switch minimal mode. Sets SIMPLE so all the existing
      // gates fire (CLAUDE.md, skills, hooks inside executeHooks, agent
      // dir-walk). Must be set before setup() / any of the gated work runs.
      if ((options as { bare?: boolean }).bare) {
        process.env.CLAUDE_CODE_SIMPLE = '1'
      }

      // 忽略 "code" 作为提示——将其视为无提示
      if (prompt === 'code') {
        logEvent('tengu_code_prompt_ignored', {})
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.warn(
          chalk.yellow('Tip: You can launch Claude Code with just `claude`'),
        )
        prompt = undefined
      }

      // 为任何单个词提示记录事件
      if (
        prompt &&
        typeof prompt === 'string' &&
        !/\s/.test(prompt) &&
        prompt.length > 0
      ) {
        logEvent('tengu_single_word_prompt', { length: prompt.length })
      }

      // 助手模式：当 .claude/settings.json 中 assistant: true 且
      // tengu_kairos GrowthBook 开关打开时，强制启用 brief。权限
      // 模式由用户决定 — 设置 defaultMode 或 --permission-mode
      // 正常应用。REPL 类型的消息已经默认为 'next'
      // 优先级（messageQueueManager.enqueue），因此在两次
      // 工具调用之间排出。SendUserMessage（BriefTool）通过 brief env
      // 变量启用。SleepTool 保持禁用（其 isEnabled() 由 proactive 门控）。
      // kairosEnabled 在这里计算一次，在下面的
      // getAssistantSystemPromptAddendum() 调用点重用。
      //
      // 信任门控：.claude/settings.json 在不受信任的克隆中可被攻击者控制。
      // 我们在 showSetupScreens() 显示信任对话框之前运行了约 1000 行，
      // 到那时我们已经将 .claude/agents/assistant.md 添加到系统提示符中。
      // 在目录被明确信任之前拒绝激活。
      let kairosEnabled = false
      let assistantTeamContext:
        | Awaited<
            ReturnType<
              NonNullable<typeof assistantModule>['initializeAssistantTeam']
            >
          >
        | undefined
      if (
        feature('KAIROS') &&
        (options as { assistant?: boolean }).assistant &&
        assistantModule
      ) {
        // --assistant (Agent SDK daemon mode): force the latch before
        // isAssistantMode() runs below. The daemon has already checked
        // entitlement — don't make the child re-check tengu_kairos.
        assistantModule.markAssistantForced()
      }
      if (
        feature('KAIROS') &&
        assistantModule?.isAssistantMode() &&
        // 生成的 teammates 共享 leader 的 cwd + settings.json，所以
        // isAssistantMode() 对它们也为 true。--agent-id 被设置
        // 意味着我们是生成的 teammate（extractTeammateOptions 在
        // ~170 行之后运行，所以检查原始 commander 选项）——不要
        // 重新初始化 team 或覆盖 teammateMode/proactive/brief。
        !(options as { agentId?: unknown }).agentId &&
        kairosGate
      ) {
        if (!checkHasTrustDialogAccepted()) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.warn(
            chalk.yellow(
              'Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.',
            ),
          )
        } else {
          // 阻塞 gate 检查——立即返回缓存的 `true`；如果磁盘
          // 缓存为 false/缺失，则延迟初始化 GrowthBook 并获取最新值
          // （最多约 5s）。--assistant 完全跳过 gate（daemon 是
          // 预授权的）。
          kairosEnabled =
            assistantModule.isAssistantForced() ||
            (await kairosGate.isKairosEnabled())
          if (kairosEnabled) {
            const opts = options as { brief?: boolean }
            opts.brief = true
            setKairosActive(true)
            // 预先植入一个进程内 team，以便 Agent(name: "foo") 生成
            // teammates 而无需 TeamCreate。必须在 setup() 捕获
            // teammateMode 快照之前运行（initializeAssistantTeam 在内部
            // 调用 setCliTeammateModeOverride）。
            assistantTeamContext =
              await assistantModule.initializeAssistantTeam()
          }
        }
      }

      const {
        debug = false,
        debugToStderr = false,
        dangerouslySkipPermissions,
        allowDangerouslySkipPermissions = false,
        tools: baseTools = [],
        allowedTools = [],
        disallowedTools = [],
        mcpConfig = [],
        permissionMode: permissionModeCli,
        addDir = [],
        fallbackModel,
        betas = [],
        ide = false,
        sessionId,
        includeHookEvents,
        includePartialMessages,
      } = options

      if (options.prefill) {
        seedEarlyInput(options.prefill)
      }

      // 文件下载的 Promise——提前启动，在 REPL 渲染之前等待
      let fileDownloadPromise: Promise<DownloadResult[]> | undefined

      const agentsJson = options.agents
      const agentCli = options.agent
      if (feature('BG_SESSIONS') && agentCli) {
        process.env.CLAUDE_CODE_AGENT = agentCli
      }

      // 注意：LSP 管理器初始化有意延迟到信任对话框接受之后。
      // 这样可以防止插件 LSP 服务器在用户同意之前在不受信任的目录中执行代码。

      // 单独提取这些以便在需要时进行修改
      let outputFormat = options.outputFormat
      let inputFormat = options.inputFormat
      let verbose = options.verbose ?? getGlobalConfig().verbose
      let print = options.print
      const init = options.init ?? false
      const initOnly = options.initOnly ?? false
      const maintenance = options.maintenance ?? false

      // 提取禁用斜杠命令标志
      const disableSlashCommands = options.disableSlashCommands || false

      // 提取 tasks 模式选项（仅限 ant）
      const tasksOption =
        process.env.USER_TYPE === 'ant' &&
        (options as { tasks?: boolean | string }).tasks
      const taskListId = tasksOption
        ? typeof tasksOption === 'string'
          ? tasksOption
          : DEFAULT_TASKS_MODE_TASK_LIST_ID
        : undefined
      if (process.env.USER_TYPE === 'ant' && taskListId) {
        process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
      }

      // 提取 worktree 选项
      // worktree 可以是 true（无值的标志）或字符串（自定义名称或 PR 引用）
      const worktreeOption = isWorktreeModeEnabled()
        ? (options as { worktree?: boolean | string }).worktree
        : undefined
      let worktreeName =
        typeof worktreeOption === 'string' ? worktreeOption : undefined
      const worktreeEnabled = worktreeOption !== undefined

      // 检查 worktree 名称是否是 PR 引用（#N 或 GitHub PR URL）
      let worktreePRNumber: number | undefined
      if (worktreeName) {
        const prNum = parsePRReference(worktreeName)
        if (prNum !== null) {
          worktreePRNumber = prNum
          worktreeName = undefined // slug will be generated in setup()
        }
      }

      // 提取 tmux 选项（需要 --worktree）
      const tmuxEnabled =
        isWorktreeModeEnabled() && (options as { tmux?: boolean }).tmux === true

      // 验证 tmux 选项
      if (tmuxEnabled) {
        if (!worktreeEnabled) {
          process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'))
          process.exit(1)
        }
        if (getPlatform() === 'windows') {
          process.stderr.write(
            chalk.red('Error: --tmux is not supported on Windows\n'),
          )
          process.exit(1)
        }
        if (!(await isTmuxAvailable())) {
          process.stderr.write(
            chalk.red(
              `Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`,
            ),
          )
          process.exit(1)
        }
      }

      // 提取 teammate 选项（用于 tmux 启动的 agents）
      // 在 if 块外部声明，以便稍后可用于系统提示附加内容
      let storedTeammateOpts: TeammateOptions | undefined
      if (isAgentSwarmsEnabled()) {
        // 提取 agent 身份选项（用于 tmux 启动的 agents）
        // 这些会替换 CLAUDE_CODE_* 环境变量
        const teammateOpts = extractTeammateOptions(options)
        storedTeammateOpts = teammateOpts

        // 如果提供了任何 teammate 身份选项，则必须同时提供全部三个必需选项
        const hasAnyTeammateOpt =
          teammateOpts.agentId ||
          teammateOpts.agentName ||
          teammateOpts.teamName
        const hasAllRequiredTeammateOpts =
          teammateOpts.agentId &&
          teammateOpts.agentName &&
          teammateOpts.teamName

        if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
          process.stderr.write(
            chalk.red(
              'Error: --agent-id, --agent-name, and --team-name must all be provided together\n',
            ),
          )
          process.exit(1)
        }

        // 如果通过 CLI 提供了 teammate 身份，则设置 dynamicTeamContext
        if (
          teammateOpts.agentId &&
          teammateOpts.agentName &&
          teammateOpts.teamName
        ) {
          getTeammateUtils().setDynamicTeamContext?.({
            agentId: teammateOpts.agentId,
            agentName: teammateOpts.agentName,
            teamName: teammateOpts.teamName,
            color: teammateOpts.agentColor,
            planModeRequired: teammateOpts.planModeRequired ?? false,
            parentSessionId: teammateOpts.parentSessionId,
          })
        }

        // 如果提供了 teammate 模式 CLI 覆盖，则在此设置
        // 这必须在 setup() 捕获快照之前完成
        if (teammateOpts.teammateMode) {
          getTeammateModeSnapshot().setCliTeammateModeOverride?.(
            teammateOpts.teammateMode,
          )
        }
      }

      // 提取远程 SDK 选项
      const sdkUrl = (options as { sdkUrl?: string }).sdkUrl ?? undefined

      // 允许环境变量启用部分消息（用于 sandbox gateway for baku）
      const effectiveIncludePartialMessages =
        includePartialMessages ||
        isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES)

      // 当通过 SDK 选项明确请求时，或在 CLAUDE_CODE_REMOTE 模式（CCR 需要它们）中运行时，
      // 启用所有 hook 事件类型。没有这个，只发出 SessionStart 和 Setup 事件。
      if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
        setAllHookEventsEnabled(true)
      }

      // 当提供 SDK URL 时，自动设置输入/输出格式、verbose 模式和 print 模式
      if (sdkUrl) {
        // 如果提供了 SDK URL，自动使用 stream-json 格式，除非明确设置
        if (!inputFormat) {
          inputFormat = 'stream-json'
        }
        if (!outputFormat) {
          outputFormat = 'stream-json'
        }
        // 自动启用 verbose 模式，除非明确禁用或已设置
        if (options.verbose === undefined) {
          verbose = true
        }
        // 自动启用 print 模式，除非明确禁用
        if (!options.print) {
          print = true
        }
      }

      // 提取 teleport 选项
      const teleport =
        (options as { teleport?: string | true }).teleport ?? null

      // 提取 remote 选项（如果没有提供描述可以为 true，或者为字符串）
      const remoteOption = (options as { remote?: string | true }).remote
      const remote = remoteOption === true ? '' : (remoteOption ?? null)

      // Extract --remote-control / --rc flag (enable bridge in interactive session)
      const remoteControlOption =
        (options as { remoteControl?: string | true }).remoteControl ??
        (options as { rc?: string | true }).rc
      // 实际的桥接检查延迟到 showSetupScreens() 之后，
      // 以便信任建立且 GrowthBook 有了 auth headers。
      let remoteControl = false
      const remoteControlName =
        typeof remoteControlOption === 'string' &&
        remoteControlOption.length > 0
          ? remoteControlOption
          : undefined

      // 验证会话 ID（如果提供）
      if (sessionId) {
        // 检查冲突的标志
        // --session-id 可以与 --continue 或 --resume 一起使用，前提是也提供了 --fork-session
        // （用于为 fork 的会话指定自定义 ID）
        if ((options.continue || options.resume) && !options.forkSession) {
          process.stderr.write(
            chalk.red(
              'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
            ),
          )
          process.exit(1)
        }

        // 当提供 --sdk-url 时（bridge/remote 模式），会话 ID 是
        // 服务器分配的带标签的 ID（例如 "session_local_01..."）而不是 UUID。
        // 在这种情况下，跳过 UUID 验证和本地存在性检查。
        if (!sdkUrl) {
          const validatedSessionId = validateUuid(sessionId)
          if (!validatedSessionId) {
            process.stderr.write(
              chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'),
            )
            process.exit(1)
          }

          // 检查会话 ID 是否已存在
          if (sessionIdExists(validatedSessionId)) {
            process.stderr.write(
              chalk.red(
                `Error: Session ID ${validatedSessionId} is already in use.\n`,
              ),
            )
            process.exit(1)
          }
        }
      }

      // 如果通过 --file 标志指定，则下载文件资源
      const fileSpecs = (options as { file?: string[] }).file
      if (fileSpecs && fileSpecs.length > 0) {
        // 获取会话入口 token（由 EnvManager 通过 CLAUDE_CODE_SESSION_ACCESS_TOKEN 提供）
        const sessionToken = getSessionIngressAuthToken()
        if (!sessionToken) {
          process.stderr.write(
            chalk.red(
              'Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n',
            ),
          )
          process.exit(1)
        }

        // 解析会话 ID：优先使用远程会话 ID，回退到内部会话 ID
        const fileSessionId =
          process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId()

        const files = parseFileSpecs(fileSpecs)
        if (files.length > 0) {
          // 如果设置了 ANTHROPIC_BASE_URL（由 EnvManager 设置），则使用它，
          // 否则使用 OAuth 配置。这确保了与所有环境中
          // 会话入口 API 的一致性
          const config: FilesApiConfig = {
            baseUrl:
              process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
            oauthToken: sessionToken,
            sessionId: fileSessionId,
          }

          // 启动下载而不阻塞启动——在 REPL 渲染之前 await
          fileDownloadPromise = downloadSessionFiles(files, config)
        }
      }

      // 从状态获取 isNonInteractiveSession（在 init() 之前设置）
      const isNonInteractiveSession = getIsNonInteractiveSession()

      // 验证备用模型与主模型不同
      if (fallbackModel && options.model && fallbackModel === options.model) {
        process.stderr.write(
          chalk.red(
            'Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n',
          ),
        )
        process.exit(1)
      }

      // 处理系统提示选项
      let systemPrompt = options.systemPrompt
      if (options.systemPromptFile) {
        if (options.systemPrompt) {
          process.stderr.write(
            chalk.red(
              'Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n',
            ),
          )
          process.exit(1)
        }

        try {
          const filePath = resolve(options.systemPromptFile)
          systemPrompt = readFileSync(filePath, 'utf8')
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(
                `Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`,
              ),
            )
            process.exit(1)
          }
          process.stderr.write(
            chalk.red(
              `Error reading system prompt file: ${errorMessage(error)}\n`,
            ),
          )
          process.exit(1)
        }
      }

      // 处理追加系统提示选项
      let appendSystemPrompt = options.appendSystemPrompt
      if (options.appendSystemPromptFile) {
        if (options.appendSystemPrompt) {
          process.stderr.write(
            chalk.red(
              'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n',
            ),
          )
          process.exit(1)
        }

        try {
          const filePath = resolve(options.appendSystemPromptFile)
          appendSystemPrompt = readFileSync(filePath, 'utf8')
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(
                `Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`,
              ),
            )
            process.exit(1)
          }
          process.stderr.write(
            chalk.red(
              `Error reading append system prompt file: ${errorMessage(error)}\n`,
            ),
          )
          process.exit(1)
        }
      }

      // 为 tmux teammates 添加特定于 teammate 的系统提示附加内容
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName
      ) {
        const addendum =
          getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${addendum}`
          : addendum
      }

      const { mode: permissionMode, notification: permissionModeNotification } =
        initialPermissionModeFromCLI({
          permissionModeCli,
          dangerouslySkipPermissions,
        })

      // 存储会话绕过权限模式以进行信任对话框检查
      setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions')
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        // autoModeFlagCli 是"用户是否打算在此会话中使用自动模式"的信号。
        // 设置条件：--enable-auto-mode、--permission-mode auto、解析模式
        // 为 auto、或者设置 defaultMode 为 auto 但开关拒绝它
        //（permissionMode 解析为 default 且没有明确的 CLI 覆盖）。
        // 由 verifyAutoModeGateAccess 使用来决定是否通知
        // 自动模式不可用，以及由 tengu_auto_mode_config 选择加入轮播使用。
        if (
          (options as { enableAutoMode?: boolean }).enableAutoMode ||
          permissionModeCli === 'auto' ||
          permissionMode === 'auto' ||
          (!permissionModeCli && isDefaultPermissionModeAuto())
        ) {
          autoModeStateModule?.setAutoModeFlagCli(true)
        }
      }

      // 解析 MCP 配置文件/字符串（如果提供）
      let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {}

      if (mcpConfig && mcpConfig.length > 0) {
        // 处理 mcpConfig 数组
        const processedConfigs = mcpConfig
          .map(config => config.trim())
          .filter(config => config.length > 0)

        let allConfigs: Record<string, McpServerConfig> = {}
        const allErrors: ValidationError[] = []

        for (const configItem of processedConfigs) {
          let configs: Record<string, McpServerConfig> | null = null
          let errors: ValidationError[] = []

          // 首先尝试解析为 JSON 字符串
          const parsedJson = safeParseJSON(configItem)
          if (parsedJson) {
            const result = parseMcpConfig({
              configObject: parsedJson,
              filePath: 'command line',
              expandVars: true,
              scope: 'dynamic',
            })
            if (result.config) {
              configs = result.config.mcpServers
            } else {
              errors = result.errors
            }
          } else {
            // 尝试作为文件路径
            const configPath = resolve(configItem)
            const result = parseMcpConfigFromFilePath({
              filePath: configPath,
              expandVars: true,
              scope: 'dynamic',
            })
            if (result.config) {
              configs = result.config.mcpServers
            } else {
              errors = result.errors
            }
          }

          if (errors.length > 0) {
            allErrors.push(...errors)
          } else if (configs) {
            // 合并配置，后面的覆盖前面的
            allConfigs = { ...allConfigs, ...configs }
          }
        }

        if (allErrors.length > 0) {
          const formattedErrors = allErrors
            .map(err => `${err.path ? err.path + ': ' : ''}${err.message}`)
            .join('\n')
          logForDebugging(
            `--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`,
            { level: 'error' },
          )
          process.stderr.write(
            `Error: Invalid MCP configuration:\n${formattedErrors}\n`,
          )
          process.exit(1)
        }

        if (Object.keys(allConfigs).length > 0) {
          // SDK 宿主（Nest/Desktop）拥有自己的服务器命名，可能重用
          // 内置名称——对 type:'sdk' 跳过保留名称检查。
          const nonSdkConfigNames = Object.entries(allConfigs)
            .filter(([, config]) => config.type !== 'sdk')
            .map(([name]) => name)

          let reservedNameError: string | null = null
          if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
            reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`
          } else if (feature('CHICAGO_MCP')) {
            const { isComputerUseMCPServer, COMPUTER_USE_MCP_SERVER_NAME } =
              await import('src/utils/computerUse/common.js')
            if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
              reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`
            }
          }
          if (reservedNameError) {
            // stderr+exit(1) — a throw here becomes a silent unhandled
            // rejection in stream-json mode (void main() in cli.tsx).
            process.stderr.write(`Error: ${reservedNameError}\n`)
            process.exit(1)
          }

          // 为所有配置添加动态作用域。type:'sdk' 条目原样通过——它们在下游
          // 被提取到 sdkMcpConfigs 并传递给 print.ts。Python SDK 依赖此路径
          // （它不在初始化消息中发送 sdkMcpServers）。在这里删除它们会破坏
          // Coworker (inc-5122)。下面的策略过滤器已经豁免了 type:'sdk'，
          // 并且如果没有 stdin 上的 SDK 传输，这些条目是无 inert 的，
          // 所以让它们通过没有绕过风险。
          const scopedConfigs = mapValues(allConfigs, config => ({
            ...config,
            scope: 'dynamic' as const,
          }))

          // 对 --mcp-config 服务器强制执行托管策略
          // (allowedMcpServers / deniedMcpServers)。没有这个，CLI 标志会绕过
          // user/project/local 配置在 getClaudeCodeMcpConfigs 中通过的企业
          // 允许列表——调用者将 dynamicMcpConfig 展开在过滤结果之上。
          // 在源头过滤，以便所有下游消费者看到策略过滤后的集合。
          const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs)
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            )
          }
          dynamicMcpConfig = { ...dynamicMcpConfig, ...allowed }
        }
      }

      // 提取 Claude in Chrome 选项并强制执行 claude.ai 订阅者检查（除非用户是 ant）
      const chromeOpts = options as { chrome?: boolean }
      // 存储显式 CLI 标志，以便 teammates 可以继承它
      setChromeFlagOverride(chromeOpts.chrome)
      const enableClaudeInChrome =
        shouldEnableClaudeInChrome(chromeOpts.chrome) &&
        (process.env.USER_TYPE === 'ant' || isClaudeAISubscriber())
      const autoEnableClaudeInChrome =
        !enableClaudeInChrome && shouldAutoEnableClaudeInChrome()

      if (enableClaudeInChrome) {
        const platform = getPlatform()
        try {
          logEvent('tengu_claude_in_chrome_setup', {
            platform:
              platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          const {
            mcpConfig: chromeMcpConfig,
            allowedTools: chromeMcpTools,
            systemPrompt: chromeSystemPrompt,
          } = setupClaudeInChrome()
          dynamicMcpConfig = { ...dynamicMcpConfig, ...chromeMcpConfig }
          allowedTools.push(...chromeMcpTools)
          if (chromeSystemPrompt) {
            appendSystemPrompt = appendSystemPrompt
              ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}`
              : chromeSystemPrompt
          }
        } catch (error) {
          logEvent('tengu_claude_in_chrome_setup_failed', {
            platform:
              platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          logForDebugging(`[Claude in Chrome] Error: ${error}`)
          logError(error)
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(`Error: Failed to run with Claude in Chrome.`)
          process.exit(1)
        }
      } else if (autoEnableClaudeInChrome) {
        try {
          const { mcpConfig: chromeMcpConfig } = setupClaudeInChrome()
          dynamicMcpConfig = { ...dynamicMcpConfig, ...chromeMcpConfig }

          const hint =
            feature('WEB_BROWSER_TOOL') &&
            typeof Bun !== 'undefined' &&
            'WebView' in Bun
              ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
              : CLAUDE_IN_CHROME_SKILL_HINT
          appendSystemPrompt = appendSystemPrompt
            ? `${appendSystemPrompt}\n\n${hint}`
            : hint
        } catch (error) {
          // 静默跳过自动启用的任何错误
          logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`)
        }
      }

      // 提取严格 MCP 配置标志
      const strictMcpConfig = options.strictMcpConfig || false

      // 检查企业 MCP 配置是否存在。当存在时，只允许包含特殊服务器类型（sdk）的动态 MCP 配置
      if (doesEnterpriseMcpConfigExist()) {
        if (strictMcpConfig) {
          process.stderr.write(
            chalk.red(
              'You cannot use --strict-mcp-config when an enterprise MCP config is present',
            ),
          )
          process.exit(1)
        }

        // 对于 --mcp-config，如果所有服务器都是内部类型（sdk），则允许
        if (
          dynamicMcpConfig &&
          !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
        ) {
          process.stderr.write(
            chalk.red(
              'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
            ),
          )
          process.exit(1)
        }
      }

      // chicago MCP：受保护的计算机使用（应用白名单 + 最前台门控 +
      // SCContentFilter 截图）。仅限 Ant，GrowthBook 门控 — 失败
      // 是静默的（这是内部测试）。平台 + 交互检查是内联的，
      // 因此非 macOS / print 模式的 ant 完全跳过重型 @ant/computer-use-mcp
      // 导入。gates.js 是轻量级的（仅类型包导入）。
      //
      // 放在 enterprise-MCP-config 检查之后：该检查拒绝任何
      // `type !== 'sdk'` 的 dynamicMcpConfig 条目，而我们的配置是
      // `type: 'stdio'`。带有 GB 门控的企业配置 ant 会
      // 否则 process.exit(1)。Chrome 有相同的潜在问题但已
      // 无事故发布；chicago 正确地放置了自己。
      if (
        feature('CHICAGO_MCP') &&
        getPlatform() !== 'unknown' &&
        !getIsNonInteractiveSession()
      ) {
        try {
          const { getChicagoEnabled } = await import(
            'src/utils/computerUse/gates.js'
          )
          if (getChicagoEnabled()) {
            const { setupComputerUseMCP } = await import(
              'src/utils/computerUse/setup.js'
            )
            const { mcpConfig, allowedTools: cuTools } = setupComputerUseMCP()
            dynamicMcpConfig = { ...dynamicMcpConfig, ...mcpConfig }
            allowedTools.push(...cuTools)
          }
        } catch (error) {
          logForDebugging(
            `[Computer Use MCP] Setup failed: ${errorMessage(error)}`,
          )
        }
      }

      // 存储用于 CLAUDE.md 加载的额外目录（由环境变量控制）
      setAdditionalDirectoriesForClaudeMd(addDir)

      // 来自 --channels 标志的频道服务器白名单 — 其入站推送通知应该注册此会话。
      // 该选项在 feature() 块内添加，因此 TS 在选项类型上不知道它
      // — 与 main.tsx:1824 处的 --assistant 相同的模式。
      // devChannels 被延迟：showSetupScreens 显示确认对话框，
      // 只有在接受时才追加到 allowedChannels。
      let devChannels: ChannelEntry[] | undefined
      if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
        // 将 plugin:name@marketplace / server:Y 标签解析为类型化条目。
        // 标签决定下游的信任模型：plugin-kind 触发 marketplace
        // 验证 + GrowthBook 白名单，server-kind 总是失败
        // 白名单（模式仅限插件），除非设置了 dev 标志。
        // 未标记或没有 marketplace 的插件条目是硬错误 —
        // 在门控中静默不匹配会让频道看起来是
        // "开启"但没有任何东西触发。
        const parseChannelEntries = (
          raw: string[],
          flag: string,
        ): ChannelEntry[] => {
          const entries: ChannelEntry[] = []
          const bad: string[] = []
          for (const c of raw) {
            if (c.startsWith('plugin:')) {
              const rest = c.slice(7)
              const at = rest.indexOf('@')
              if (at <= 0 || at === rest.length - 1) {
                bad.push(c)
              } else {
                entries.push({
                  kind: 'plugin',
                  name: rest.slice(0, at),
                  marketplace: rest.slice(at + 1),
                })
              }
            } else if (c.startsWith('server:') && c.length > 7) {
              entries.push({ kind: 'server', name: c.slice(7) })
            } else {
              bad.push(c)
            }
          }
          if (bad.length > 0) {
            process.stderr.write(
              chalk.red(
                `${flag} entries must be tagged: ${bad.join(', ')}\n` +
                  `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` +
                  `  server:<name>                — manually configured MCP server\n`,
              ),
            )
            process.exit(1)
          }
          return entries
        }

        const channelOpts = options as {
          channels?: string[]
          dangerouslyLoadDevelopmentChannels?: string[]
        }
        const rawChannels = channelOpts.channels
        const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels
        // 始终解析 + 设置。ChannelsNotice 读取 getAllowedChannels() 并
        // 在启动屏幕上渲染适当的分支（disabled/noAuth/policyBlocked/
        // listening）。gateChannelServer() 强制执行。
        // --channels 在交互模式和 print/SDK 模式下都有效；dev-channels
        // 仅在交互模式下有效（需要确认对话框）。
        let channelEntries: ChannelEntry[] = []
        if (rawChannels && rawChannels.length > 0) {
          channelEntries = parseChannelEntries(rawChannels, '--channels')
          setAllowedChannels(channelEntries)
        }
        if (!isNonInteractiveSession) {
          if (rawDev && rawDev.length > 0) {
            devChannels = parseChannelEntries(
              rawDev,
              '--dangerously-load-development-channels',
            )
          }
        }
        // 标志使用遥测。插件标识符被记录（与 tengu_plugin_installed
        // 同一层级——公共注册风格名称）；服务器种类名称不是
        // （MCP 服务器名称层级，仅选择性加入）。
        // 每个服务器的 gate 结果在服务器连接后进入 tengu_mcp_channel_gate。
        // 开发条目在此之后通过确认对话框——dev_plugins 捕获输入内容，
        // 而不是被接受的内容。
        if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
          const joinPluginIds = (entries: ChannelEntry[]) => {
            const ids = entries.flatMap(e =>
              e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : [],
            )
            return ids.length > 0
              ? (ids
                  .sort()
                  .join(
                    ',',
                  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : undefined
          }
          logEvent('tengu_mcp_channel_flags', {
            channels_count: channelEntries.length,
            dev_count: devChannels?.length ?? 0,
            plugins: joinPluginIds(channelEntries),
            dev_plugins: joinPluginIds(devChannels ?? []),
          })
        }
      }

      // 通过 --tools 为 SendUserMessage 提供 SDK 选择加入。所有会话都需要
      // 明确的选择加入；在 --tools 中列出它表示意图。在
      // initializeToolPermissionContext 之前运行，这样 getToolsForDefaultPreset() 在计算
      // base-tools 禁止过滤器时将工具视为已启用。
      // 条件 require 避免将工具名称字符串泄露到外部构建中。
      if (
        (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
        baseTools.length > 0
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } =
          require('./tools/BriefTool/prompt.js') as typeof import('./tools/BriefTool/prompt.js')
        const { isBriefEntitled } =
          require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        const parsed = parseToolListFromCLI(baseTools)
        if (
          (parsed.includes(BRIEF_TOOL_NAME) ||
            parsed.includes(LEGACY_BRIEF_TOOL_NAME)) &&
          isBriefEntitled()
        ) {
          setUserMsgOptIn(true)
        }
      }

      // 这个 await 替换了已经在启动路径中的阻塞 existsSync/statSync 调用。
      // 挂钟时间不变；我们只是在 fs I/O 期间让出事件循环而不是阻塞它。见 #19661。
      const initResult = await initializeToolPermissionContext({
        allowedToolsCli: allowedTools,
        disallowedToolsCli: disallowedTools,
        baseToolsCli: baseTools,
        permissionMode,
        allowDangerouslySkipPermissions,
        addDirs: addDir,
      })
      let toolPermissionContext = initResult.toolPermissionContext
      const { warnings, dangerousPermissions, overlyBroadBashPermissions } =
        initResult

      // 处理 ant 用户过于宽泛的 shell 允许规则（Bash(*)、PowerShell(*)）
      if (
        process.env.USER_TYPE === 'ant' &&
        overlyBroadBashPermissions.length > 0
      ) {
        for (const permission of overlyBroadBashPermissions) {
          logForDebugging(
            `Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`,
          )
        }
        toolPermissionContext = removeDangerousPermissions(
          toolPermissionContext,
          overlyBroadBashPermissions,
        )
      }

      if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
        toolPermissionContext = stripDangerousPermissionsForAutoMode(
          toolPermissionContext,
        )
      }

      // 打印初始化期间的任何警告
      warnings.forEach(warning => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(warning)
      })

      void assertMinVersion()

      // claude.ai 配置获取：仅 -p 模式（交互模式使用 useManageMCPConnections
      // 两阶段加载）。在这里启动以与 setup() 重叠；在 runHeadless 之前等待，
      // 以便单轮 -p 看到连接器。在 enterprise/strict MCP 下跳过以保留策略边界。
      const claudeaiConfigPromise: Promise<
        Record<string, ScopedMcpServerConfig>
      > =
        isNonInteractiveSession &&
        !strictMcpConfig &&
        !doesEnterpriseMcpConfigExist() &&
        // --bare / SIMPLE：跳过 claude.ai 代理服务器（datadog、Gmail、
        // Slack、BigQuery、PubMed——每个连接需要 6-14 秒）。需要 MCP 的
        // 脚本调用显式传递 --mcp-config。
        !isBareMode()
          ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
              const { allowed, blocked } = filterMcpServersByPolicy(configs)
              if (blocked.length > 0) {
                process.stderr.write(
                  `Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
                )
              }
              return allowed
            })
          : Promise.resolve({})

      // 提前启动 MCP 配置加载（安全——只读取文件，不执行）。
      // 交互模式和 -p 都使用 getClaudeCodeMcpConfigs（仅本地文件读取）。
      // 当地 promise 在稍后等待（在 prefetchAllMcpResources 之前），
      // 以便配置 I/O 与 setup()、命令加载和信任对话框重叠。
      logForDebugging('[STARTUP] Loading MCP configs...')
      const mcpConfigStart = Date.now()
      let mcpConfigResolvedMs: number | undefined
      // --bare skips auto-discovered MCP (.mcp.json, user settings, plugins) —
      // only explicit --mcp-config works. dynamicMcpConfig is spread onto
      // allMcpConfigs downstream so it survives this skip.
      const mcpConfigPromise = (
        strictMcpConfig || isBareMode()
          ? Promise.resolve({
              servers: {} as Record<string, ScopedMcpServerConfig>,
            })
          : getClaudeCodeMcpConfigs(dynamicMcpConfig)
      ).then(result => {
        mcpConfigResolvedMs = Date.now() - mcpConfigStart
        return result
      })

      // 注意：我们不在这里调用 prefetchAllMcpResources - 它被延迟到信任对话框之后

      if (
        inputFormat &&
        inputFormat !== 'text' &&
        inputFormat !== 'stream-json'
      ) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: Invalid input format "${inputFormat}".`)
        process.exit(1)
      }
      if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          `Error: --input-format=stream-json requires output-format=stream-json.`,
        )
        process.exit(1)
      }

      // 验证 sdkUrl 仅与适当格式一起使用（格式在上面自动设置）
      if (sdkUrl) {
        if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(
            `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`,
          )
          process.exit(1)
        }
      }

      // 验证 replayUserMessages 仅与 stream-json 格式一起使用
      if (options.replayUserMessages) {
        if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(
            `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`,
          )
          process.exit(1)
        }
      }

      // 验证 includePartialMessages 仅与 print 模式和 stream-json 输出一起使用
      if (effectiveIncludePartialMessages) {
        if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
          writeToStderr(
            `Error: --include-partial-messages requires --print and --output-format=stream-json.`,
          )
          process.exit(1)
        }
      }

      // 验证 --no-session-persistence 仅与 print 模式一起使用
      if (options.sessionPersistence === false && !isNonInteractiveSession) {
        writeToStderr(
          `Error: --no-session-persistence can only be used with --print mode.`,
        )
        process.exit(1)
      }

      const effectivePrompt = prompt || ''
      let inputPrompt = await getInputPrompt(
        effectivePrompt,
        (inputFormat ?? 'text') as 'text' | 'stream-json',
      )
      profileCheckpoint('action_after_input_prompt')

      // 在 getTools() 之前激活主动模式，以便 SleepTool.isEnabled()
      // （返回 isProactiveActive()）通过且 Sleep 被包含。
      // 稍后 REPL 路径 maybeActivateProactive() 调用是幂等的。
      maybeActivateProactive(options)

      let tools = getTools(toolPermissionContext)

      // 对 headless 路径应用协调器模式工具过滤
      // （镜像 REPL/交互路径的 useMergedTools.ts 过滤）
      if (
        feature('COORDINATOR_MODE') &&
        isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
      ) {
        const { applyCoordinatorToolFilter } = await import(
          './utils/toolPool.js'
        )
        tools = applyCoordinatorToolFilter(tools)
      }

      profileCheckpoint('action_tools_loaded')

      let jsonSchema: ToolInputJSONSchema | undefined
      if (
        isSyntheticOutputToolEnabled({ isNonInteractiveSession }) &&
        options.jsonSchema
      ) {
        jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema
      }

      if (jsonSchema) {
        const syntheticOutputResult = createSyntheticOutputTool(jsonSchema)
        if ('tool' in syntheticOutputResult) {
          // 在 getTools() 过滤之后，将 SyntheticOutputTool 添加到工具数组。
          // 此工具被排除在正常过滤之外（见 tools.ts），因为它是
          // 结构化输出的实现细节，而非用户控制的工具。
          tools = [...tools, syntheticOutputResult.tool]

          logEvent('tengu_structured_output_enabled', {
            schema_property_count: Object.keys(
              (jsonSchema.properties as Record<string, unknown>) || {},
            )
              .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            has_required_fields: Boolean(
              jsonSchema.required,
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        } else {
          logEvent('tengu_structured_output_failure', {
            error:
              'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        }
      }

      // IMPORTANT: setup() must be called before any other code that depends on the cwd or worktree setup
      profileCheckpoint('action_before_setup')
      logForDebugging('[STARTUP] Running setup()...')
      const setupStart = Date.now()
      const { setup } = await import('./setup.js')
      const messagingSocketPath = feature('UDS_INBOX')
        ? (options as { messagingSocketPath?: string }).messagingSocketPath
        : undefined
      // 将 setup() 与 commands+agents 加载并行化。setup() 的约 28ms 主要是
      // startUdsMessaging（socket 绑定，约 20ms）——不是磁盘绑定的，
      // 所以它不与 getCommands' 文件读取竞争。受 !worktreeEnabled 限制，
      // 因为 --worktree 使 setup() 调用 process.chdir()（setup.ts:203），
      // 并且 commands/agents 需要 chdir 后的 cwd。
      const preSetupCwd = getCwd()
      // 在启动 getCommands() 之前注册捆绑的 skills/plugins——它们是
      // 纯内存数组推送（<1ms，零 I/O），getBundledSkills()
      // 同步读取。以前在 setup() 中约 20ms 的 await 点之后运行，
      // 所以并行的 getCommands() 缓存了一个空列表。
      if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
        initBuiltinPlugins()
        initBundledSkills()
      }
      const setupPromise = setup(
        preSetupCwd,
        permissionMode,
        allowDangerouslySkipPermissions,
        worktreeEnabled,
        worktreeName,
        tmuxEnabled,
        sessionId ? validateUuid(sessionId) : undefined,
        worktreePRNumber,
        messagingSocketPath,
      )
      const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)
      const agentDefsPromise = worktreeEnabled
        ? null
        : getAgentDefinitionsWithOverrides(preSetupCwd)
      // 如果这些在 setupPromise 等待的约 28ms 内被拒绝，在 Promise.all 之前抑制瞬态 unhandledRejection。
      commandsPromise?.catch(() => {})
      agentDefsPromise?.catch(() => {})
      await setupPromise
      logForDebugging(
        `[STARTUP] setup() completed in ${Date.now() - setupStart}ms`,
      )
      profileCheckpoint('action_after_setup')

      // 仅在 socket 明确请求时将用户消息重放到 stream-json。
      // 自动生成的 socket 是被动的——它让工具可以注入（如果它们想的话），
      // 但默认开启不应重塑从不接触它的 SDK 消费者的 stream-json。
      // 注入且希望在流中看到这些注入的调用者显式传递
      // --messaging-socket-path（或 --replay-user-messages）。
      let effectiveReplayUserMessages = !!options.replayUserMessages
      if (feature('UDS_INBOX')) {
        if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
          effectiveReplayUserMessages = !!(
            options as { messagingSocketPath?: string }
          ).messagingSocketPath
        }
      }

      if (getIsNonInteractiveSession()) {
        // 立即应用完整的合并设置环境（包括项目范围的
        // .claude/settings.json PATH/GIT_DIR/GIT_WORK_TREE），以便 gitExe() 和
        // 下面的 git spawn 能看到它。在 -p 模式下信任是隐式的；
        // managedEnv.ts:96-97 的文档字符串说明这会应用"潜在的
        // 危险环境变量，如 LD_PRELOAD、PATH"，来自所有来源。
        // 下面 isNonInteractiveSession 块中的后续调用是幂等的
        // （Object.assign，configureGlobalAgents 弹出之前的
        // 拦截器），并在插件初始化后获取任何插件贡献的环境。
        // 项目设置已在此处加载：init() 中调用的
        // applySafeConfigEnvironmentVariables 位于
        // managedEnv.ts:86，它合并了所有启用的来源，
        // 包括 projectSettings/localSettings。
        applyConfigEnvironmentVariables()

        // 立即生成 git status/log/branch，以便子进程执行与下面的
        // getCommands await 和 startDeferredPrefetches 重叠。在 setup() 之后
        // 运行，以便 cwd 最终确定（setup.ts:254 可能为 --worktree 调用
        // process.chdir(worktreePath)），并在上面的
        // applyConfigEnvironmentVariables 之后运行，以便所有来源
        // （受信任 + 项目）的 PATH/GIT_DIR/GIT_WORK_TREE 被应用。
        // getSystemContext 被缓存；startDeferredPrefetches 中的
        // prefetchSystemContextIfSafe 调用变成缓存命中。
        // await getIsGit() 的微任务在下面的 getCommands Promise.all
        // await 处排出。在 -p 模式下信任是隐式的（与
        // prefetchSystemContextIfSafe 相同的 gate）。
        void getSystemContext()
        // 现在也启动 getUserContext——它的第一次 await（getMemoryFiles 中的
        // fs.readFile）自然让出，所以 CLAUDE.md 目录遍历在上下文
        // Promise.all 于 print.ts 中加入之前的约 280ms 重叠窗口期间运行。
        // startDeferredPrefetches 中的 void getUserContext() 变成缓存命中。
        void getUserContext()
        // 现在启动 ensureModelStringsInitialized——对于 Bedrock，这会触发
        // 一个在 print.ts:739 被串行 await 的 100-200ms 配置获取。
        // updateBedrockModelStrings 被 sequential() 包装，
        // 所以 await 加入进行中的获取。非 Bedrock 是同步早期返回（零成本）。
        void ensureModelStringsInitialized()
      }

      // 应用 --name：仅缓存，因此在会话 ID 被 --continue/--resume 确定之前
      // 不会创建孤立文件。materializeSessionFile 在第一个用户消息时
      // 保存它；REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
      const sessionNameArg = options.name?.trim()
      if (sessionNameArg) {
        cacheSessionTitle(sessionNameArg)
      }

      // Ant 模型别名（capybara-fast 等）通过 tengu_ant_model_override GrowthBook 标志解析。
      // _CACHED_MAY_BE_STALE 同步读取磁盘；磁盘由 fire-and-forget 写入填充。
      // 在冷缓存上，parseUserSpecifiedModel 返回未解析的别名，API 404s，
      // 且 -p 在异步写入落地之前退出——在新 pods 上崩溃循环。
      // 在这里 await init 填充内存有效载荷映射，
      // _CACHED_MAY_BE_STALE 现在首先检查。受限制以便热路径保持非阻塞：
      //  - 通过 --model 或 ANTHROPIC_MODEL 的显式模型（两者都提供别名解析）
      //  - 无环境覆盖（这在磁盘之前短路 _CACHED_MAY_BE_STALE）
      //  - 磁盘中缺少标志（== null 也捕获 pre-#22279 中毒的 null）
      const explicitModel = options.model || process.env.ANTHROPIC_MODEL
      if (
        process.env.USER_TYPE === 'ant' &&
        explicitModel &&
        explicitModel !== 'default' &&
        !hasGrowthBookEnvOverride('tengu_ant_model_override') &&
        getGlobalConfig().cachedGrowthBookFeatures?.[
          'tengu_ant_model_override'
        ] == null
      ) {
        await initializeGrowthBook()
      }

      // 使用 null 关键字特殊处理默认模型
      // 注意：模型解析在 setup() 之后进行，以确保在 AWS 认证之前建立信任
      const userSpecifiedModel =
        options.model === 'default' ? getDefaultMainLoopModel() : options.model
      const userSpecifiedFallbackModel =
        fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel

      // 除非 setup() 调用了 chdir()（worktreeEnabled），否则重用 preSetupCwd。
      // 在常见路径中保存一个 getCwd() 系统调用。
      const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd
      logForDebugging('[STARTUP] Loading commands and agents...')
      const commandsStart = Date.now()
      // 加入在 setup() 之前启动的 promises（或者如果 worktreeEnabled 限制了早期启动，则重新开始）。
      // 两者都按 cwd 缓存。
      const [commands, agentDefinitionsResult] = await Promise.all([
        commandsPromise ?? getCommands(currentCwd),
        agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
      ])
      logForDebugging(
        `[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`,
      )
      profileCheckpoint('action_commands_loaded')

      // 如果通过 --agents 标志提供，则解析 CLI agents
      let cliAgents: typeof agentDefinitionsResult.activeAgents = []
      if (agentsJson) {
        try {
          const parsedAgents = safeParseJSON(agentsJson)
          if (parsedAgents) {
            cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings')
          }
        } catch (error) {
          logError(error)
        }
      }

      // 将 CLI agents 与现有 agents 合并
      const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents]
      const agentDefinitions = {
        ...agentDefinitionsResult,
        allAgents,
        activeAgents: getActiveAgentsFromList(allAgents),
      }

      // 从 CLI 标志或设置中查找主线程 agent
      const agentSetting = agentCli ?? getInitialSettings().agent
      let mainThreadAgentDefinition:
        | (typeof agentDefinitions.activeAgents)[number]
        | undefined
      if (agentSetting) {
        mainThreadAgentDefinition = agentDefinitions.activeAgents.find(
          agent => agent.agentType === agentSetting,
        )
        if (!mainThreadAgentDefinition) {
          logForDebugging(
            `Warning: agent "${agentSetting}" not found. ` +
              `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` +
              `Using default behavior.`,
          )
        }
      }

      // 将主线程 agent 类型存储在引导状态中，以便 hooks 可以访问它
      setMainThreadAgentType(mainThreadAgentDefinition?.agentType)

      // 记录 agent 标志使用——仅为内置 agents 记录 agent 名称，以避免泄露自定义 agent 名称
      if (mainThreadAgentDefinition) {
        logEvent('tengu_agent_flag', {
          agentType: isBuiltInAgent(mainThreadAgentDefinition)
            ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          ...(agentCli && {
            source:
              'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          }),
        })
      }

      // 将 agent 设置持久化到会话记录中，以便恢复视图显示和恢复
      if (mainThreadAgentDefinition?.agentType) {
        saveAgentSetting(mainThreadAgentDefinition.agentType)
      }

      // 对非交互会话应用 agent 的系统提示
      // （交互模式使用 buildEffectiveSystemPrompt）
      if (
        isNonInteractiveSession &&
        mainThreadAgentDefinition &&
        !systemPrompt &&
        !isBuiltInAgent(mainThreadAgentDefinition)
      ) {
        const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt()
        if (agentSystemPrompt) {
          systemPrompt = agentSystemPrompt
        }
      }

      // initialPrompt 放在第一位，以便其斜杠命令（如果有）被处理；
      // 用户提供的文本成为尾部上下文。
      // 仅在 inputPrompt 是字符串时连接。当它是
      // AsyncIterable（SDK stream-json 模式）时，模板插值会
      // 调用 .toString() 产生 "[object Object]"。AsyncIterable 情况
      // 在 print.ts 中通过 structuredIO.prependUserMessage() 处理。
      if (mainThreadAgentDefinition?.initialPrompt) {
        if (typeof inputPrompt === 'string') {
          inputPrompt = inputPrompt
            ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}`
            : mainThreadAgentDefinition.initialPrompt
        } else if (!inputPrompt) {
          inputPrompt = mainThreadAgentDefinition.initialPrompt
        }
      }

      // 提前计算有效模型，以便 hooks 可以与 MCP 并行运行
      // 如果用户没有指定模型但 agent 有，则使用 agent 的模型
      let effectiveModel = userSpecifiedModel
      if (
        !effectiveModel &&
        mainThreadAgentDefinition?.model &&
        mainThreadAgentDefinition.model !== 'inherit'
      ) {
        effectiveModel = parseUserSpecifiedModel(
          mainThreadAgentDefinition.model,
        )
      }

      setMainLoopModelOverride(effectiveModel)

      // 为 hooks 计算解析后的模型（使用启动时用户指定的模型）
      setInitialMainLoopModel(getUserSpecifiedModelSetting() || null)
      const initialMainLoopModel = getInitialMainLoopModel()
      const resolvedInitialModel = parseUserSpecifiedModel(
        initialMainLoopModel ?? getDefaultMainLoopModel(),
      )

      let advisorModel: string | undefined
      if (isAdvisorEnabled()) {
        const advisorOption = canUserConfigureAdvisor()
          ? (options as { advisor?: string }).advisor
          : undefined
        if (advisorOption) {
          logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`)
          if (!modelSupportsAdvisor(resolvedInitialModel)) {
            process.stderr.write(
              chalk.red(
                `Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`,
              ),
            )
            process.exit(1)
          }
          const normalizedAdvisorModel = normalizeModelStringForAPI(
            parseUserSpecifiedModel(advisorOption),
          )
          if (!isValidAdvisorModel(normalizedAdvisorModel)) {
            process.stderr.write(
              chalk.red(
                `Error: The model "${advisorOption}" cannot be used as an advisor.\n`,
              ),
            )
            process.exit(1)
          }
        }
        advisorModel = canUserConfigureAdvisor()
          ? (advisorOption ?? getInitialAdvisorSetting())
          : advisorOption
        if (advisorModel) {
          logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`)
        }
      }

      // 对于带有 --agent-type 的 tmux teammates，追加自定义 agent 的提示
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName &&
        storedTeammateOpts?.agentType
      ) {
        // 查找自定义 agent 定义
        const customAgent = agentDefinitions.activeAgents.find(
          a => a.agentType === storedTeammateOpts.agentType,
        )
        if (customAgent) {
          // 获取提示——需要处理内置和自定义 agents
          let customPrompt: string | undefined
          if (customAgent.source === 'built-in') {
            // 内置 agents 有接受 toolUseContext 的 getSystemPrompt
            // 我们在这里无法访问完整的 toolUseContext，所以暂时跳过
            logForDebugging(
              `[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`,
            )
          } else {
            // 自定义 agents 有不接受参数的 getSystemPrompt
            customPrompt = customAgent.getSystemPrompt()
          }

          // 为 tmux teammates 记录 agent 内存加载事件
          if (customAgent.memory) {
            logEvent('tengu_agent_memory_loaded', {
              ...(process.env.USER_TYPE === 'ant' && {
                agent_type:
                  customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }),
              scope:
                customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              source:
                'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }

          if (customPrompt) {
            const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`
            appendSystemPrompt = appendSystemPrompt
              ? `${appendSystemPrompt}\n\n${customInstructions}`
              : customInstructions
          }
        } else {
          logForDebugging(
            `[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`,
          )
        }
      }

      maybeActivateBrief(options)
      // defaultView: 'chat' is a persisted opt-in — check entitlement and set
      // userMsgOptIn so the tool + prompt section activate. Interactive-only:
      // defaultView is a display preference; SDK sessions have no display, and
      // the assistant installer writes defaultView:'chat' to settings.local.json
      // which would otherwise leak into --print sessions in the same directory.
      // 在 maybeActivateBrief() 之后立即运行，以便所有启动选择加入路径
      // 在下面的任何 isBriefEnabled() 读取之前触发（主动提示的
      // briefVisibility). A persisted 'chat' after a GB kill-switch falls
      // through (entitlement fails).
      if (
        (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
        !getIsNonInteractiveSession() &&
        !getUserMsgOptIn() &&
        getInitialSettings().defaultView === 'chat'
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isBriefEntitled } =
          require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        if (isBriefEntitled()) {
          setUserMsgOptIn(true)
        }
      }
      // 协调器模式有自己的系统提示并过滤掉 Sleep，所以
      // the generic proactive prompt would tell it to call a tool it can't
      // access and conflict with delegation instructions.
      if (
        (feature('PROACTIVE') || feature('KAIROS')) &&
        ((options as { proactive?: boolean }).proactive ||
          isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) &&
        !coordinatorModeModule?.isCoordinatorMode()
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const briefVisibility =
          feature('KAIROS') || feature('KAIROS_BRIEF')
            ? (
                require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
              ).isBriefEnabled()
              ? 'Call SendUserMessage at checkpoints to mark where things stand.'
              : 'The user will see any text you output.'
            : 'The user will see any text you output.'
        /* eslint-enable @typescript-eslint/no-require-imports */
        const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${proactivePrompt}`
          : proactivePrompt
      }

      if (feature('KAIROS') && kairosEnabled && assistantModule) {
        const assistantAddendum =
          assistantModule.getAssistantSystemPromptAddendum()
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${assistantAddendum}`
          : assistantAddendum
      }

      // Ink root 仅在交互会话中需要——Ink 构造函数中的 patchConsole
      // 会在 headless 模式下吞噬控制台输出。
      let root!: Root
      let getFpsMetrics!: () => FpsMetrics | undefined
      let stats!: StatsStore

      // 在命令加载后显示设置屏幕
      if (!isNonInteractiveSession) {
        const ctx = getRenderContext(false)
        getFpsMetrics = ctx.getFpsMetrics
        stats = ctx.stats
        // 在 Ink 挂载之前安装 asciicast 录制器（仅 ant，通过 CLAUDE_CODE_TERMINAL_RECORDING=1 选择加入）
        if (process.env.USER_TYPE === 'ant') {
          installAsciicastRecorder()
        }

        const { createRoot } = await import('@anthropic/ink')
        root = await createRoot(ctx.renderOptions)

        // 现在记录启动时间，在任何阻塞对话框渲染之前。从 REPL 首次渲染
        // 记录（旧位置）包含了用户在 trust/OAuth/onboarding/resume-picker 上
        // 花费的时间——p99 约为 70s，以对话框等待时间为主，而非代码路径启动。
        logEvent('tengu_timer', {
          event:
            'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Math.round(process.uptime() * 1000),
        })

        logForDebugging('[STARTUP] Running showSetupScreens()...')
        const setupScreensStart = Date.now()
        const onboardingShown = await showSetupScreens(
          root,
          permissionMode,
          allowDangerouslySkipPermissions,
          commands,
          enableClaudeInChrome,
          devChannels,
        )
        logForDebugging(
          `[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`,
        )

        // 现在信任已建立，GrowthBook 有了 auth headers，
        // 解析 --remote-control / --rc 的授权 gate。
        if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
          const { getBridgeDisabledReason } = await import(
            './bridge/bridgeEnabled.js'
          )
          const disabledReason = await getBridgeDisabledReason()
          remoteControl = disabledReason === null
          if (disabledReason) {
            process.stderr.write(
              chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`),
            )
          }
        }

        // 检查待处理的 agent 内存快照更新（仅适用于 --agent 模式，仅限 ant）
        if (
          feature('AGENT_MEMORY_SNAPSHOT') &&
          mainThreadAgentDefinition &&
          isCustomAgent(mainThreadAgentDefinition) &&
          mainThreadAgentDefinition.memory &&
          mainThreadAgentDefinition.pendingSnapshotUpdate
        ) {
          const agentDef = mainThreadAgentDefinition
          const choice = await launchSnapshotUpdateDialog(root, {
            agentType: agentDef.agentType,
            scope: agentDef.memory!,
            snapshotTimestamp:
              agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
          })
          if (choice === 'merge') {
            const { buildMergePrompt } = await import(
              './components/agents/SnapshotUpdateDialog.js'
            )
            const mergePrompt = buildMergePrompt(
              agentDef.agentType,
              agentDef.memory!,
            )
            inputPrompt = inputPrompt
              ? `${mergePrompt}\n\n${inputPrompt}`
              : mergePrompt
          }
          agentDef.pendingSnapshotUpdate = undefined
        }

        // 如果我们刚刚完成了 onboarding 的 /login，则跳过执行
        if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
          prompt = ''
        }

        if (onboardingShown) {
          // 现在用户已在 onboarding 期间登录，刷新依赖 auth 的服务。
          // 与 src/commands/login.tsx 中的登录后逻辑保持同步
          void refreshRemoteManagedSettings()
          void refreshPolicyLimits()
          // 在 GrowthBook 刷新之前清除用户数据缓存，以便获取新的凭证
          resetUserCache()
          // 登录后刷新 GrowthBook 以获取更新的功能标志（例如，用于 claude.ai MCP）
          refreshGrowthBookAfterAuthChange()
          // 清除任何过期的可信设备令牌，然后为远程控制注册。
          // 两者都在内部以 tengu_sessions_elevated_auth_enforcement 自我 gate
          // ——enrollTrustedDevice() 通过 checkGate_CACHED_OR_BLOCKING
          // （await 上面的 GrowthBook 重新初始化），clearTrustedDeviceToken()
          // 通过同步缓存检查（可以接受，因为清除是幂等的）。
          void import('./bridge/trustedDevice.js').then(m => {
            m.clearTrustedDeviceToken()
            return m.enrollTrustedDevice()
          })
        }

        // 验证活动令牌的 org 与 forceLoginOrgUUID 匹配（如果在
        // 托管设置中设置）。在 onboarding 之后运行，以便托管设置和
        // 登录状态完全加载。
        const orgValidation = await validateForceLoginOrg()
        if (!orgValidation.valid) {
          await exitWithError(root, orgValidation.message)
        }
      }

      // 如果启动了 gracefulShutdown（例如，用户拒绝信任对话框），
      // process.exitCode will be set. Skip all subsequent operations that could
      // trigger code execution before the process exits (e.g. we don't want apiKeyHelper
      // to run if trust was not established).
      if (process.exitCode !== undefined) {
        logForDebugging(
          'Graceful shutdown initiated, skipping further initialization',
        )
        return
      }

      // 在信任建立之后（或在非交互模式下）初始化 LSP 管理器
      // 其中信任是隐式的。这可以防止插件 LSP 服务器在用户同意之前
      // 在不受信任的目录中执行代码。必须在设置内联插件之后（如有），
      // 以便 --plugin-dir LSP 服务器被包含在内。
      initializeLspServerManager()

      // 在信任建立后显示设置验证错误
      // MCP 配置错误不会阻止设置加载，因此排除它们
      if (!isNonInteractiveSession) {
        const { errors } = getSettingsWithErrors()
        const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata)
        if (nonMcpErrors.length > 0) {
          await launchInvalidSettingsDialog(root, {
            settingsErrors: nonMcpErrors,
            onExit: () => gracefulShutdownSync(1),
          })
        }
      }

      // 检查配额状态、快速模式、通行资格和引导数据
      // after trust is established. These make API calls which could trigger
      // apiKeyHelper execution.
      // --bare / SIMPLE: skip — these are cache-warms for the REPL's
      // first-turn responsiveness (quota, passes, fastMode, bootstrap data). Fast
      // mode doesn't apply to the Agent SDK anyway (see getFastModeUnavailableReason).
      const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_cicada_nap_ms',
        0,
      )
      const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0
      const skipStartupPrefetches =
        isBareMode() ||
        (bgRefreshThrottleMs > 0 &&
          Date.now() - lastPrefetched < bgRefreshThrottleMs)

      if (!skipStartupPrefetches) {
        const lastPrefetchedInfo =
          lastPrefetched > 0
            ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`
            : ''
        logForDebugging(
          `Starting background startup prefetches${lastPrefetchedInfo}`,
        )

        checkQuotaStatus().catch(error => logError(error))

        // 从服务器获取引导数据并更新所有缓存值。
        void fetchBootstrapData()

        // 待办：将其他预取合并到单个引导请求中
        void prefetchPassesEligibility()
        if (
          !getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)
        ) {
          void prefetchFastModeStatus()
        } else {
          // 终止开关跳过网络调用，而非 org 策略执行。
          // 从缓存解析，以便 orgStatus 不会保持 'pending'（这会被
          // getFastModeUnavailableReason 视为宽松）。
          resolveFastModeStatusFromCache()
        }
        if (bgRefreshThrottleMs > 0) {
          saveGlobalConfig(current => ({
            ...current,
            startupPrefetchedAt: Date.now(),
          }))
        }
      } else {
        logForDebugging(
          `Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`,
        )
        // 从缓存解析快速模式 org 状态（无网络）
        resolveFastModeStatusFromCache()
      }

      if (!isNonInteractiveSession) {
        void refreshExampleCommands() // Pre-fetch example commands (runs git log, no API call)
      }

      // 解析 MCP 配置（提前启动，与 setup()/信任对话框工作重叠）
      const { servers: existingMcpConfigs } = await mcpConfigPromise
      logForDebugging(
        `[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`,
      )
      // CLI flag (--mcp-config) should override file-based configs, matching settings precedence
      const allMcpConfigs = { ...existingMcpConfigs, ...dynamicMcpConfig }

      // 将 SDK 配置与常规 MCP 配置分开
      const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {}
      const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {}

      for (const [name, config] of Object.entries(allMcpConfigs)) {
        const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig
        if (typedConfig.type === 'sdk') {
          sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig
        } else {
          regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig
        }
      }

      profileCheckpoint('action_mcp_configs_loaded')

      // 在信任对话框之后预取 MCP 资源（这是执行发生的地方）。
      // 仅交互模式：print 模式延迟连接直到 headlessStore 存在
      // and pushes per-server (below), so ToolSearch's pending-client handling works
      // and one slow server doesn't block the batch.
      const localMcpPromise = isNonInteractiveSession
        ? Promise.resolve({ clients: [], tools: [], commands: [] })
        : prefetchAllMcpResources(regularMcpConfigs)
      const claudeaiMcpPromise = isNonInteractiveSession
        ? Promise.resolve({ clients: [], tools: [], commands: [] })
        : claudeaiConfigPromise.then(configs =>
            Object.keys(configs).length > 0
              ? prefetchAllMcpResources(configs)
              : { clients: [], tools: [], commands: [] },
          )
      // 按名称合并去重：每个 prefetchAllMcpResources 调用独立
      // adds helper tools (ListMcpResourcesTool, ReadMcpResourceTool) via
      // local dedup flags, so merging two calls can yield duplicates. print.ts
      // already uniqBy's the final tool pool, but dedup here keeps appState clean.
      const mcpPromise = Promise.all([
        localMcpPromise,
        claudeaiMcpPromise,
      ]).then(([local, claudeai]) => ({
        clients: [...local.clients, ...claudeai.clients],
        tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
        commands: uniqBy([...local.commands, ...claudeai.commands], 'name'),
      }))

      // 提前启动 hooks，以便它们与 MCP 连接并行运行。
      // 对 initOnly/init/maintenance 跳过（单独处理），非交互式
      // (handled via setupTrigger), and resume/continue (conversationRecovery.ts
      // fires 'resume' instead — without this guard, hooks fire TWICE on /resume
      // and the second systemMessage clobbers the first. gh-30825)
      const hooksPromise =
        initOnly ||
        init ||
        maintenance ||
        isNonInteractiveSession ||
        options.continue ||
        options.resume
          ? null
          : processSessionStartHooks('startup', {
              agentType: mainThreadAgentDefinition?.agentType,
              model: resolvedInitialModel,
            })

      // MCP never blocks REPL render OR turn 1 TTFT. useManageMCPConnections
      // populates appState.mcp async as servers connect (connectToServer is
      // memoized — the prefetch calls above and the hook converge on the same
      // connections). getToolUseContext reads store.getState() fresh via
      // computeTools(), so turn 1 sees whatever's connected by query time.
      // 慢服务器为第 2+ 轮填充。匹配交互式无提示行为。
      // behavior. Print mode: per-server push into headlessStore (below).
      const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = []
      // 抑制瞬态 unhandledRejection — 预热 memoized connectToServer 缓存，但在交互式中没有人等待它。
      mcpPromise.catch(() => {})

      const mcpClients: Awaited<typeof mcpPromise>['clients'] = []
      const mcpTools: Awaited<typeof mcpPromise>['tools'] = []
      const mcpCommands: Awaited<typeof mcpPromise>['commands'] = []

      let thinkingEnabled = shouldEnableThinkingByDefault()
      let thinkingConfig: ThinkingConfig =
        thinkingEnabled !== false ? { type: 'adaptive' } : { type: 'disabled' }

      if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
        thinkingEnabled = true
        thinkingConfig = { type: 'adaptive' }
      } else if (options.thinking === 'disabled') {
        thinkingEnabled = false
        thinkingConfig = { type: 'disabled' }
      } else {
        const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
          ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
          : options.maxThinkingTokens
        if (maxThinkingTokens !== undefined) {
          if (maxThinkingTokens > 0) {
            thinkingEnabled = true
            thinkingConfig = {
              type: 'enabled',
              budgetTokens: maxThinkingTokens,
            }
          } else if (maxThinkingTokens === 0) {
            thinkingEnabled = false
            thinkingConfig = { type: 'disabled' }
          }
        }
      }

      logForDiagnosticsNoPII('info', 'started', {
        version: MACRO.VERSION,
        is_native_binary: isInBundledMode(),
      })

      registerCleanup(async () => {
        logForDiagnosticsNoPII('info', 'exited')
      })

      void logTenguInit({
        hasInitialPrompt: Boolean(prompt),
        hasStdin: Boolean(inputPrompt),
        verbose,
        debug,
        debugToStderr,
        print: print ?? false,
        outputFormat: outputFormat ?? 'text',
        inputFormat: inputFormat ?? 'text',
        numAllowedTools: allowedTools.length,
        numDisallowedTools: disallowedTools.length,
        mcpClientCount: Object.keys(allMcpConfigs).length,
        worktreeEnabled,
        skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
        githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
        dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
        permissionMode,
        modeIsBypass: permissionMode === 'bypassPermissions',
        allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
        systemPromptFlag: systemPrompt
          ? options.systemPromptFile
            ? 'file'
            : 'flag'
          : undefined,
        appendSystemPromptFlag: appendSystemPrompt
          ? options.appendSystemPromptFile
            ? 'file'
            : 'flag'
          : undefined,
        thinkingConfig,
        assistantActivationPath:
          feature('KAIROS') && kairosEnabled
            ? assistantModule?.getAssistantActivationPath()
            : undefined,
      })

      // 在初始化时记录一次上下文指标
      void logContextMetrics(regularMcpConfigs, toolPermissionContext)

      void logPermissionContextForAnts(null, 'initialization')

      logManagedSettings()

      // 注册 PID 文件以进行并发会话检测（~/.claude/sessions/）
      // and fire multi-clauding telemetry. Lives here (not init.ts) so only the
      // REPL path registers — not subcommands like `claude doctor`. Chained:
      // count must run after register's write completes or it misses our own file.
      void registerSession().then(registered => {
        if (!registered) return
        if (sessionNameArg) {
          void updateSessionName(sessionNameArg)
        }
        void countConcurrentSessions().then(count => {
          if (count >= 2) {
            logEvent('tengu_concurrent_sessions', { num_sessions: count })
          }
        })
      })

      // 初始化版本化插件系统（触发 V1→V2 迁移，如果
      // needed). Then run orphan GC, THEN warm the Grep/Glob exclusion cache.
      // 排序很重要：warmup 扫描磁盘中的 .orphaned_at 标记，
      // so it must see the GC's Pass 1 (remove markers from reinstalled
      // versions) and Pass 2 (stamp unmarked orphans) already applied. The
      // warm also lands before autoupdate (fires on first submit in REPL)
      // can orphan this session's active version underneath us.
      // --bare / SIMPLE: skip plugin version sync + orphan cleanup. These
      // are install/upgrade bookkeeping that scripted calls don't need —
      // the next interactive session will reconcile. The await here was
      // blocking -p on a marketplace round-trip.
      if (isBareMode()) {
        // skip — no-op
      } else if (isNonInteractiveSession) {
        // 在 headless 模式中，等待以确保插件同步在 CLI 退出前完成
        await initializeVersionedPlugins()
        profileCheckpoint('action_after_plugins_init')
        void cleanupOrphanedPluginVersionsInBackground().then(() =>
          getGlobExclusionsForPluginCache(),
        )
      } else {
        // 在交互模式中，fire-and-forget — 这只是纯粹的记帐工作，
        // 不影响当前会话的运行时行为
        void initializeVersionedPlugins().then(async () => {
          profileCheckpoint('action_after_plugins_init')
          await cleanupOrphanedPluginVersionsInBackground()
          void getGlobExclusionsForPluginCache()
        })
      }

      const setupTrigger =
        initOnly || init ? 'init' : maintenance ? 'maintenance' : null
      if (initOnly) {
        applyConfigEnvironmentVariables()
        await processSetupHooks('init', { forceSyncExecution: true })
        await processSessionStartHooks('startup', { forceSyncExecution: true })
        gracefulShutdownSync(0)
        return
      }

      // --print mode
      if (isNonInteractiveSession) {
        if (outputFormat === 'stream-json' || outputFormat === 'json') {
          setHasFormattedOutput(true)
        }

        // 在 print 模式下应用完整的环境变量，因为信任对话框被跳过
        // 这包括来自不受信任来源的潜在危险环境变量
        // 但 print 模式被认为是受信任的（如帮助文本中所述）
        applyConfigEnvironmentVariables()

        // 在应用环境变量后初始化遥测，以便 OTEL 端点环境变量和
        // otelHeadersHelper（需要信任才能执行）可用。
        initializeTelemetryAfterTrust()

        // 现在启动 SessionStart hooks，以便子进程 spawn 与下面的
        // MCP 连接 + 插件初始化 + print.ts 导入重叠。
        // loadInitialMessages 在 print.ts:4397 加入此过程。
        // 保护与 loadInitialMessages 相同——continue/resume/teleport 路径
        // 不触发启动 hooks（或者在 resume 分支内有条件地触发，
        // 该分支中此 promise 为 undefined，?? 后备运行）。
        // 同样在设置 setupTrigger 时跳过——这些路径首先运行 setup hooks（print.ts:544），
        // session start hooks 必须等待 setup 完成。
        const sessionStartHooksPromise =
          options.continue || options.resume || teleport || setupTrigger
            ? undefined
            : processSessionStartHooks('startup')
        // 如果在 loadInitialMessages await 之前拒绝，则抑制瞬态 unhandledRejection。
        // 下游 await 仍会观察到这个拒绝——这只是阻止了虚假的全局处理器触发。
        sessionStartHooksPromise?.catch(() => {})

        profileCheckpoint('before_validateForceLoginOrg')
        // 验证非交互会话的 org 限制
        const orgValidation = await validateForceLoginOrg()
        if (!orgValidation.valid) {
          process.stderr.write(orgValidation.message + '\n')
          process.exit(1)
        }

        // 无头模式支持所有提示命令和一些本地命令
        // 如果 disableSlashCommands 为 true，返回空数组
        const commandsHeadless = disableSlashCommands
          ? []
          : commands.filter(
              command =>
                (command.type === 'prompt' && !command.disableNonInteractive) ||
                (command.type === 'local' && command.supportsNonInteractive),
            )

        const defaultState = getDefaultAppState()
        const headlessInitialState: AppState = {
          ...defaultState,
          mcp: {
            ...defaultState.mcp,
            clients: mcpClients,
            commands: mcpCommands,
            tools: mcpTools,
          },
          toolPermissionContext,
          effortValue:
            parseEffortValue(options.effort) ?? getInitialEffortSetting(),
          ...(isFastModeEnabled() && {
            fastMode: getInitialFastModeSetting(effectiveModel ?? null),
          }),
          ...(isAdvisorEnabled() && advisorModel && { advisorModel }),
          // kairosEnabled 控制 executeForkedSlashCommand
          // (processSlashCommand.tsx:132) 和 AgentTool 的 shouldRunAsync 中的
          // 异步 fire-and-forget 路径。REPL initialState 在约 3459 行设置
          // 这个；headless 以前默认为 false，所以 daemon child 的调度任务和
          // Agent-tool 调用同步运行——N 个逾期 cron 任务在生成时 = N 个串行
          // subagent turns 阻塞用户输入。在 :1620 计算，远在此分支之前。
          ...(feature('KAIROS') ? { kairosEnabled } : {}),
        }

        // 初始化应用状态
        const headlessStore = createStore(
          headlessInitialState,
          onChangeAppState,
        )

        // 检查是否应基于 Statsig gate 禁用 bypassPermissions
        // 这与下面的代码并行运行，以避免阻塞主循环。
        if (
          toolPermissionContext.mode === 'bypassPermissions' ||
          allowDangerouslySkipPermissions
        ) {
          void checkAndDisableBypassPermissions(toolPermissionContext)
        }

        // 自动模式 gate 的异步检查——纠正状态并在需要时禁用自动。
        // 由 TRANSCRIPT_CLASSIFIER（而非 USER_TYPE）gate，以便 GrowthBook
        // 终止开关也适用于外部构建。
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          void verifyAutoModeGateAccess(
            toolPermissionContext,
            headlessStore.getState().fastMode,
          ).then(({ updateContext }) => {
            headlessStore.setState(prev => {
              const nextCtx = updateContext(prev.toolPermissionContext)
              if (nextCtx === prev.toolPermissionContext) return prev
              return { ...prev, toolPermissionContext: nextCtx }
            })
          })
        }

        // 为会话持久化设置全局状态
        if (options.sessionPersistence === false) {
          setSessionPersistenceDisabled(true)
        }

        // 在全局状态中存储 SDK betas 以供上下文窗口计算
        // 仅存储允许的 betas（按允许列表和订阅者状态过滤）
        setSdkBetas(filterAllowedSdkBetas(betas))

        // Print 模式 MCP：每服务器增量推送到 headlessStore。
        // 镜像 useManageMCPConnections——首先推送 pending（以便 ToolSearch 的
        // pending-check 在 ToolSearchTool.ts:334 看到它们），然后在每个服务器
        // 稳定后替换为 connected/failed。
        const connectMcpBatch = (
          configs: Record<string, ScopedMcpServerConfig>,
          label: string,
        ): Promise<void> => {
          if (Object.keys(configs).length === 0) return Promise.resolve()
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: [
                ...prev.mcp.clients,
                ...Object.entries(configs).map(([name, config]) => ({
                  name,
                  type: 'pending' as const,
                  config,
                })),
              ],
            },
          }))
          return getMcpToolsCommandsAndResources(
            ({ client, tools, commands }) => {
              headlessStore.setState(prev => ({
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients: prev.mcp.clients.some(c => c.name === client.name)
                    ? prev.mcp.clients.map(c =>
                        c.name === client.name ? client : c,
                      )
                    : [...prev.mcp.clients, client],
                  tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
                  commands: uniqBy([...prev.mcp.commands, ...commands], 'name'),
                },
              }))
            },
            configs,
          ).catch(err =>
            logForDebugging(`[MCP] ${label} connect error: ${err}`),
          )
        }
        // 等待所有 MCP 配置 — print 模式通常是单轮的，因此
        // "下一轮可见的晚连接服务器"没有帮助。SDK 初始化
        // 消息和第 1 轮工具列表都需要已配置的 MCP 工具存在。
        // 零服务器情况通过 connectMcpBatch 中的早期返回免费处理。
        // 连接器在 getMcpToolsCommandsAndResources
        // 内部并行化（使用 Promise.all 的 processBatched）。claude.ai 也被等待 — 其
        // 获取很早就启动了（约第 2558 行），所以只有剩余时间阻塞
        // 在这里。--bare 完全跳过 claude.ai 以提高性能敏感脚本的性能。
        profileCheckpoint('before_connectMcp')
        await connectMcpBatch(regularMcpConfigs, 'regular')
        profileCheckpoint('after_connectMcp')
        // 去重：抑制复制 claude.ai 连接器的插件 MCP 服务器（连接器胜出），
        // 然后连接 claude.ai 服务器。有界等待——#23725 使其阻塞，
        // 以便单轮 -p 看到连接器，但有 40+ 慢连接器时，
        // tengu_startup_perf p99 攀升至 76s。如果 fetch+connect
        // 没有及时完成，继续运行；promise 继续在后台运行，
        // 并在 headlessStore 中更新，以便第二轮+仍能看到连接器。
        const CLAUDE_AI_MCP_TIMEOUT_MS = 5_000
        const claudeaiConnect = claudeaiConfigPromise.then(claudeaiConfigs => {
          if (Object.keys(claudeaiConfigs).length > 0) {
            const claudeaiSigs = new Set<string>()
            for (const config of Object.values(claudeaiConfigs)) {
              const sig = getMcpServerSignature(config)
              if (sig) claudeaiSigs.add(sig)
            }
            const suppressed = new Set<string>()
            for (const [name, config] of Object.entries(regularMcpConfigs)) {
              if (!name.startsWith('plugin:')) continue
              const sig = getMcpServerSignature(config)
              if (sig && claudeaiSigs.has(sig)) suppressed.add(name)
            }
            if (suppressed.size > 0) {
              logForDebugging(
                `[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate claude.ai connectors: ${[...suppressed].join(', ')}`,
              )
              // 在从状态过滤之前断开连接。只有已连接的
              // 服务器需要清理——对从未连接的服务器调用 clearServerCache
              // 会触发真正的连接只是为了杀死它（memoize
              // cache-miss 路径，见 useManageMCPConnections.ts:870）。
              for (const c of headlessStore.getState().mcp.clients) {
                if (!suppressed.has(c.name) || c.type !== 'connected') continue
                c.client.onclose = undefined
                void clearServerCache(c.name, c.config).catch(() => {})
              }
              headlessStore.setState(prev => {
                let { clients, tools, commands, resources } = prev.mcp
                clients = clients.filter(c => !suppressed.has(c.name))
                tools = tools.filter(
                  t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName),
                )
                for (const name of suppressed) {
                  commands = excludeCommandsByServer(commands, name)
                  resources = excludeResourcesByServer(resources, name)
                }
                return {
                  ...prev,
                  mcp: { ...prev.mcp, clients, tools, commands, resources },
                }
              })
            }
          }
          // 抑制复制已启用手工服务器（URL 签名匹配）的 claude.ai 连接器。
          // 上面的插件去重只处理 `plugin:*` 键；这捕获手工 `.mcp.json` 条目。
          // plugin:* 必须在这里排除——第 1 步已经抑制了这些（claude.ai 胜出）；
          // 保留它们会抑制连接器，两者都无法存活（gh-39974）。
          const nonPluginConfigs = pickBy(
            regularMcpConfigs,
            (_, n) => !n.startsWith('plugin:'),
          )
          const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(
            claudeaiConfigs,
            nonPluginConfigs,
          )
          return connectMcpBatch(dedupedClaudeAi, 'claudeai')
        })
        let claudeaiTimer: ReturnType<typeof setTimeout> | undefined
        const claudeaiTimedOut = await Promise.race([
          claudeaiConnect.then(() => false),
          new Promise<boolean>(resolve => {
            claudeaiTimer = setTimeout(
              r => r(true),
              CLAUDE_AI_MCP_TIMEOUT_MS,
              resolve,
            )
          }),
        ])
        if (claudeaiTimer) clearTimeout(claudeaiTimer)
        if (claudeaiTimedOut) {
          logForDebugging(
            `[MCP] claude.ai connectors not ready after ${CLAUDE_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`,
          )
        }
        profileCheckpoint('after_connectMcp_claudeai')

        // 在 headless 模式中，立即启动延迟预取（无用户打字延迟）
        // --bare / SIMPLE：startDeferredPrefetches 在内部提前返回。
        // backgroundHousekeeping（initExtractMemories、pruneShellSnapshots、
        // cleanupOldMessageFiles）和 sdkHeapDumpMonitor 都是脚本调用不需要的记帐工作
        // — 下一个交互会话会协调。
        if (!isBareMode()) {
          startDeferredPrefetches()
          void import('./utils/backgroundHousekeeping.js').then(m =>
            m.startBackgroundHousekeeping(),
          )
          if (process.env.USER_TYPE === 'ant') {
            void import('./utils/sdkHeapDumpMonitor.js').then(m =>
              m.startSdkMemoryMonitor(),
            )
          }
        }

        logSessionTelemetry()
        profileCheckpoint('before_print_import')
        const { runHeadless } = await import('src/cli/print.js')
        profileCheckpoint('after_print_import')
        void runHeadless(
          inputPrompt,
          () => headlessStore.getState(),
          headlessStore.setState,
          commandsHeadless,
          tools,
          sdkMcpConfigs,
          agentDefinitions.activeAgents,
          {
            continue: options.continue,
            resume: options.resume,
            verbose: verbose,
            outputFormat: outputFormat,
            jsonSchema,
            permissionPromptToolName: options.permissionPromptTool,
            allowedTools,
            thinkingConfig,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            taskBudget: options.taskBudget
              ? { total: options.taskBudget }
              : undefined,
            systemPrompt,
            appendSystemPrompt,
            userSpecifiedModel: effectiveModel,
            fallbackModel: userSpecifiedFallbackModel,
            teleport,
            sdkUrl,
            replayUserMessages: effectiveReplayUserMessages,
            includePartialMessages: effectiveIncludePartialMessages,
            forkSession: options.forkSession || false,
            resumeSessionAt: options.resumeSessionAt || undefined,
            rewindFiles: options.rewindFiles,
            enableAuthStatus: options.enableAuthStatus,
            agent: agentCli,
            workload: options.workload,
            setupTrigger: setupTrigger ?? undefined,
            sessionStartHooksPromise,
          },
        )
        return
      }

      // 在启动时记录模型配置
      logEvent('tengu_startup_manual_model_config', {
        cli_flag:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        env_var: process.env
          .ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        settings_file: (getInitialSettings() || {})
          .model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        subscriptionType:
          getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        agent:
          agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 获取初始模型的弃用警告（resolvedInitialModel 早些时候为 hooks 并行化计算）
      const deprecationWarning =
        getModelDeprecationWarning(resolvedInitialModel)

      // 构建初始通知队列
      const initialNotifications: Array<{
        key: string
        text: string
        color?: 'warning'
        priority: 'high'
      }> = []
      if (permissionModeNotification) {
        initialNotifications.push({
          key: 'permission-mode-notification',
          text: permissionModeNotification,
          priority: 'high',
        })
      }
      if (deprecationWarning) {
        initialNotifications.push({
          key: 'model-deprecation-warning',
          text: deprecationWarning,
          color: 'warning',
          priority: 'high',
        })
      }
      if (overlyBroadBashPermissions.length > 0) {
        const displayList = uniq(
          overlyBroadBashPermissions.map(p => p.ruleDisplay),
        )
        const displays = displayList.join(', ')
        const sources = uniq(
          overlyBroadBashPermissions.map(p => p.sourceDisplay),
        ).join(', ')
        const n = displayList.length
        initialNotifications.push({
          key: 'overly-broad-bash-notification',
          text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
          color: 'warning',
          priority: 'high',
        })
      }

      const effectiveToolPermissionContext = {
        ...toolPermissionContext,
        mode:
          isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired()
            ? ('plan' as const)
            : toolPermissionContext.mode,
      }
      // 所有启动选择加入路径（--tools、--brief、defaultView）都已触发
      // above; initialIsBriefOnly just reads the resulting state.
      const initialIsBriefOnly =
        feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false
      const fullRemoteControl =
        remoteControl || getRemoteControlAtStartup() || kairosEnabled
      let ccrMirrorEnabled = false
      if (feature('CCR_MIRROR') && !fullRemoteControl) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isCcrMirrorEnabled } =
          require('./bridge/bridgeEnabled.js') as typeof import('./bridge/bridgeEnabled.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        ccrMirrorEnabled = isCcrMirrorEnabled()
      }

      const initialState: AppState = {
        settings: getInitialSettings(),
        tasks: {},
        agentNameRegistry: new Map(),
        verbose: verbose ?? getGlobalConfig().verbose ?? false,
        mainLoopModel: initialMainLoopModel,
        mainLoopModelForSession: null,
        isBriefOnly: initialIsBriefOnly,
        expandedView: getGlobalConfig().showSpinnerTree
          ? 'teammates'
          : getGlobalConfig().showExpandedTodos
            ? 'tasks'
            : 'none',
        showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
        selectedIPAgentIndex: -1,
        coordinatorTaskIndex: -1,
        viewSelectionMode: 'none',
        footerSelection: null,
        toolPermissionContext: effectiveToolPermissionContext,
        agent: mainThreadAgentDefinition?.agentType,
        agentDefinitions,
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: 0,
        },
        plugins: {
          enabled: [],
          disabled: [],
          commands: [],
          errors: [],
          installationStatus: {
            marketplaces: [],
            plugins: [],
          },
          needsRefresh: false,
        },
        statusLineText: undefined,
        kairosEnabled,
        remoteSessionUrl: undefined,
        remoteConnectionStatus: 'connecting',
        remoteBackgroundTaskCount: 0,
        replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
        replBridgeExplicit: remoteControl,
        replBridgeOutboundOnly: ccrMirrorEnabled,
        replBridgeConnected: false,
        replBridgeSessionActive: false,
        replBridgeReconnecting: false,
        replBridgeConnectUrl: undefined,
        replBridgeSessionUrl: undefined,
        replBridgeEnvironmentId: undefined,
        replBridgeSessionId: undefined,
        replBridgeError: undefined,
        replBridgeInitialName: remoteControlName,
        showRemoteCallout: false,
        notifications: {
          current: null,
          queue: initialNotifications,
        },
        elicitation: {
          queue: [],
        },
        todos: {},
        remoteAgentTaskSuggestions: [],
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        attribution: createEmptyAttributionState(),
        thinkingEnabled,
        promptSuggestionEnabled: shouldEnablePromptSuggestion(),
        sessionHooks: new Map(),
        inbox: {
          messages: [],
        },
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
        speculation: IDLE_SPECULATION_STATE,
        speculationSessionTimeSavedMs: 0,
        skillImprovement: {
          suggestion: null,
        },
        workerSandboxPermissions: {
          queue: [],
          selectedIndex: 0,
        },
        pendingWorkerRequest: null,
        pendingSandboxRequest: null,
        authVersion: 0,
        initialMessage: inputPrompt
          ? { message: createUserMessage({ content: String(inputPrompt) }) }
          : null,
        effortValue:
          parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        activeOverlays: new Set<string>(),
        fastMode: getInitialFastModeSetting(resolvedInitialModel),
        ...(isAdvisorEnabled() && advisorModel && { advisorModel }),
        // 同步计算 teamContext 以避免在渲染期间使用 useEffect setState。
        // KAIROS：assistantTeamContext 优先 — 在 KAIROS 块中更早设置，
        // 因此 Agent(name: "foo") 可以生成进程内队友，
        // 无需 TeamCreate。computeInitialTeamContext() 用于 tmux 生成的
        // 队友读取他们自己的身份，而不是助手模式领导者。
        teamContext: feature('KAIROS')
          ? (assistantTeamContext ?? computeInitialTeamContext?.())
          : computeInitialTeamContext?.(),
      }

      // 将 CLI 初始提示添加到历史记录
      if (inputPrompt) {
        addToHistory(String(inputPrompt))
      }

      const initialTools = mcpTools

      // 同步增加 numStartups — 首次渲染读取器如
      // shouldShowEffortCallout（通过 useState 初始化器）需要在 setImmediate 触发之前获得更新的值。
      // 只延迟遥测。
      saveGlobalConfig(current => ({
        ...current,
        numStartups: (current.numStartups ?? 0) + 1,
      }))
      setImmediate(() => {
        void logStartupTelemetry()
        logSessionTelemetry()
      })

      // 设置每轮会话环境数据上传器（仅限 ant 构建）。
      // 在 Anthropic 拥有的仓库中工作时，默认启用所有 ant 用户。
      // 在每轮捕获 git/文件系统状态（不是转录），以便可以在任何用户消息索引处重新创建环境。门控：
      //   - 构建时：此导入在外部构建中被存根。
      //   - 运行时：上传器检查 github.com/anthropics/* remote + gcloud auth。
      //   - 安全：CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD=1 绕过（测试设置此项）。
      // 导入是动态的 + 异步的，以避免增加启动延迟。
      const sessionUploaderPromise =
        process.env.USER_TYPE === 'ant'
          ? import('./utils/sessionDataUploader.js')
          : null

      // 将会话上传程序解析延迟到 onTurnComplete 回调以避免
      // adding a new top-level await in main.tsx (performance-critical path).
      // sessionDataUploader.ts 中每轮 auth 逻辑处理未认证
      // state gracefully (re-checks each turn, so auth recovery mid-session works).
      const uploaderReady = sessionUploaderPromise
        ? sessionUploaderPromise
            .then(mod => mod.createSessionTurnUploader())
            .catch(() => null)
        : null

      const sessionConfig = {
        debug: debug || debugToStderr,
        commands: [...commands, ...mcpCommands],
        initialTools,
        mcpClients,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        dynamicMcpConfig,
        strictMcpConfig,
        systemPrompt,
        appendSystemPrompt,
        taskListId,
        thinkingConfig,
        ...(uploaderReady && {
          onTurnComplete: (messages: MessageType[]) => {
            void uploaderReady.then(uploader => uploader?.(messages))
          },
        }),
      }

      // processResumedConversation 调用的共享上下文
      const resumeContext = {
        modeApi: coordinatorModeModule,
        mainThreadAgentDefinition,
        agentDefinitions,
        currentCwd,
        cliAgents,
        initialState,
      }

      if (options.continue) {
        // 直接继续最近的会话
        let resumeSucceeded = false
        try {
          const resumeStart = performance.now()

          // 在恢复之前清除过时的缓存，以确保新的文件/skill 发现
          const { clearSessionCaches } = await import(
            './commands/clear/caches.js'
          )
          clearSessionCaches()

          const result = await loadConversationForResume(
            undefined /* sessionId */,
            undefined /* sourceFile */,
          )
          if (!result) {
            logEvent('tengu_continue', {
              success: false,
            })
            return await exitWithError(
              root,
              'No conversation found to continue',
            )
          }

          const loaded = await processResumedConversation(
            result,
            {
              forkSession: !!options.forkSession,
              includeAttribution: true,
              transcriptPath: result.fullPath,
            },
            resumeContext,
          )

          if (loaded.restoredAgentDef) {
            mainThreadAgentDefinition = loaded.restoredAgentDef
          }

          maybeActivateProactive(options)
          maybeActivateBrief(options)

          logEvent('tengu_continue', {
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart),
          })
          resumeSucceeded = true

          await launchRepl(
            root,
            { getFpsMetrics, stats, initialState: loaded.initialState },
            {
              ...sessionConfig,
              mainThreadAgentDefinition:
                loaded.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: loaded.messages,
              initialFileHistorySnapshots: loaded.fileHistorySnapshots,
              initialContentReplacements: loaded.contentReplacements,
              initialAgentName: loaded.agentName,
              initialAgentColor: loaded.agentColor,
            },
            renderAndRun,
          )
        } catch (error) {
          if (!resumeSucceeded) {
            logEvent('tengu_continue', {
              success: false,
            })
          }
          logError(error)
          process.exit(1)
        }
      } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
        // `claude connect <url>` — 连接到远程服务器的完整交互式 TUI
        let directConnectConfig
        try {
          const session = await createDirectConnectSession({
            serverUrl: _pendingConnect.url,
            authToken: _pendingConnect.authToken,
            cwd: getOriginalCwd(),
            dangerouslySkipPermissions:
              _pendingConnect.dangerouslySkipPermissions,
          })
          if (session.workDir) {
            setOriginalCwd(session.workDir)
            setCwdState(session.workDir)
          }
          setDirectConnectServerUrl(_pendingConnect.url)
          directConnectConfig = session.config
        } catch (err) {
          return await exitWithError(
            root,
            err instanceof DirectConnectError ? err.message : String(err),
            () => gracefulShutdown(1),
          )
        }

        const connectInfoMessage = createSystemMessage(
          `Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`,
          'info',
        )

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [connectInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            directConnectConfig,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
        // `claude ssh <host> [dir]` — 探测远程，必要时部署二进制文件，
        // 使用 unix-socket -R 转发到本地 auth proxy 产生 ssh，
        // 为 REPL 提供 SSHSession。工具在远程运行，UI 在本地渲染。
        // `--local` 跳过 probe/deploy/ssh 并直接使用相同环境产生当前二进制文件
        // — proxy/auth 管道的 e2e 测试。
        const { createSSHSession, createLocalSSHSession, SSHSessionError } =
          await import('./ssh/createSSHSession.js')
        let sshSession
        try {
          if (_pendingSSH.local) {
            process.stderr.write('Starting local ssh-proxy test session...\n')
            sshSession = createLocalSSHSession({
              cwd: _pendingSSH.cwd,
              permissionMode: _pendingSSH.permissionMode,
              dangerouslySkipPermissions:
                _pendingSSH.dangerouslySkipPermissions,
            })
          } else {
            process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`)
            // 原地进度：\r + EL0（擦除到行尾）。成功后最终 \n 以便下一条消息在新行上。
            // 当 stderr 不是 TTY（管道/重定向）时为 no-op — \r 只会发出噪音。
            const isTTY = process.stderr.isTTY
            let hadProgress = false
            sshSession = await createSSHSession(
              {
                host: _pendingSSH.host,
                cwd: _pendingSSH.cwd,
                localVersion: MACRO.VERSION,
                permissionMode: _pendingSSH.permissionMode,
                dangerouslySkipPermissions:
                  _pendingSSH.dangerouslySkipPermissions,
                extraCliArgs: _pendingSSH.extraCliArgs,
              },
              isTTY
                ? {
                    onProgress: msg => {
                      hadProgress = true
                      process.stderr.write(`\r  ${msg}\x1b[K`)
                    },
                  }
                : {},
            )
            if (hadProgress) process.stderr.write('\n')
          }
          setOriginalCwd(sshSession.remoteCwd)
          setCwdState(sshSession.remoteCwd)
          setDirectConnectServerUrl(
            _pendingSSH.local ? 'local' : _pendingSSH.host,
          )
        } catch (err) {
          return await exitWithError(
            root,
            err instanceof SSHSessionError ? err.message : String(err),
            () => gracefulShutdown(1),
          )
        }

        const sshInfoMessage = createSystemMessage(
          _pendingSSH.local
            ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
            : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
          'info',
        )

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [sshInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            sshSession,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (
        feature('KAIROS') &&
        _pendingAssistantChat &&
        (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)
      ) {
        // `claude assistant [sessionId]` — REPL as a pure viewer client
        // of a remote assistant session. The agentic loop runs remotely; this
        // process streams live events and POSTs messages. History is lazy-
        // loaded by useAssistantHistory on scroll-up (no blocking fetch here).
        const { discoverAssistantSessions } = await import(
          './assistant/sessionDiscovery.js'
        )

        let targetSessionId = _pendingAssistantChat.sessionId

        // 发现流程 — 列出桥接环境，过滤会话
        if (!targetSessionId) {
          let sessions
          try {
            sessions = await discoverAssistantSessions()
          } catch (e) {
            return await exitWithError(
              root,
              `Failed to discover sessions: ${e instanceof Error ? e.message : e}`,
              () => gracefulShutdown(1),
            )
          }
          if (sessions.length === 0) {
            let installedDir: string | null
            try {
              installedDir = await launchAssistantInstallWizard(root)
            } catch (e) {
              return await exitWithError(
                root,
                `Assistant installation failed: ${e instanceof Error ? e.message : e}`,
                () => gracefulShutdown(1),
              )
            }
            if (installedDir === null) {
              await gracefulShutdown(0)
              process.exit(0)
            }
            // 守护进程需要几秒钟来启动其工作进程并建立桥接会话，然后发现才能找到它。
            return await exitWithMessage(
              root,
              `Assistant installed in ${installedDir}. The daemon is starting up — run \`claude assistant\` again in a few seconds to connect.`,
              { exitCode: 0, beforeExit: () => gracefulShutdown(0) },
            )
          }
          if (sessions.length === 1) {
            targetSessionId = sessions[0]!.id
          } else {
            const picked = await launchAssistantSessionChooser(root, {
              sessions,
            })
            if (!picked) {
              await gracefulShutdown(0)
              process.exit(0)
            }
            targetSessionId = picked
          }
        }

        // 认证 — 为 orgUUID 调用一次 prepareApiRequest()，但使用
        // getAccessToken 闭包来获取令牌，以便重新连接获取新令牌。
        const { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens } =
          await import('./utils/auth.js')
        await checkAndRefreshOAuthTokenIfNeeded()
        let apiCreds
        try {
          apiCreds = await prepareApiRequest()
        } catch (e) {
          return await exitWithError(
            root,
            `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`,
            () => gracefulShutdown(1),
          )
        }
        const getAccessToken = (): string =>
          getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken

        // Brief 模式激活：setKairosActive(true) 满足 isBriefEnabled() 的选择加入和授权
        //（BriefTool.ts:124-132）。
        setKairosActive(true)
        setUserMsgOptIn(true)
        setIsRemoteMode(true)

        const remoteSessionConfig = createRemoteSessionConfig(
          targetSessionId,
          getAccessToken,
          apiCreds.orgUUID,
          /* hasInitialPrompt */ false,
          /* viewerOnly */ true,
        )

        const infoMessage = createSystemMessage(
          `Attached to assistant session ${targetSessionId.slice(0, 8)}…`,
          'info',
        )

        const assistantInitialState: AppState = {
          ...initialState,
          isBriefOnly: true,
          kairosEnabled: false,
          replBridgeEnabled: false,
        }

        const remoteCommands = filterCommandsForRemoteMode(commands)
        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState: assistantInitialState },
          {
            debug: debug || debugToStderr,
            commands: remoteCommands,
            initialTools: [],
            initialMessages: [infoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            remoteSessionConfig,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (
        options.resume ||
        options.fromPr ||
        teleport ||
        remote !== null
      ) {
        // 处理恢复流程 - 从文件（仅限 ant）、会话 ID 或交互式选择器

        // 在恢复之前清除过期缓存以确保新的文件/技能发现
        const { clearSessionCaches } = await import(
          './commands/clear/caches.js'
        )
        clearSessionCaches()

        let messages: MessageType[] | null = null
        let processedResume: ProcessedResume | undefined

        let maybeSessionId = validateUuid(options.resume)
        let searchTerm: string | undefined
        // 当通过自定义标题找到时存储完整的 LogOption（用于跨 worktree 恢复）
        let matchedLog: LogOption | null = null
        // --from-pr 标志的 PR 过滤器
        let filterByPr: boolean | number | string | undefined

        // 处理 --from-pr 标志
        if (options.fromPr) {
          if (options.fromPr === true) {
            // 显示所有链接了 PR 的会话
            filterByPr = true
          } else if (typeof options.fromPr === 'string') {
            // 可以是 PR 编号或 URL
            filterByPr = options.fromPr
          }
        }

        // 如果 resume 值不是 UUID，首先尝试按自定义标题精确匹配
        if (
          options.resume &&
          typeof options.resume === 'string' &&
          !maybeSessionId
        ) {
          const trimmedValue = options.resume.trim()
          if (trimmedValue) {
            const matches = await searchSessionsByCustomTitle(trimmedValue, {
              exact: true,
            })

            if (matches.length === 1) {
              // 找到精确匹配——存储完整的 LogOption 以便跨 worktree 恢复
              matchedLog = matches[0]!
              maybeSessionId = getSessionIdFromLog(matchedLog) ?? null
            } else {
              // 没有匹配或多个匹配——用作选择器的搜索词
              searchTerm = trimmedValue
            }
          }
        }

        // --remote 和 --teleport 都创建/恢复 Claude Code Web (CCR) 会话。
        // 远程控制 (--rc) 是一个单独的功能，在 initReplBridge.ts 中 gate。
        if (remote !== null || teleport) {
          await waitForPolicyLimitsToLoad()
          if (!isPolicyAllowed('allow_remote_sessions')) {
            return await exitWithError(
              root,
              "Error: Remote sessions are disabled by your organization's policy.",
              () => gracefulShutdown(1),
            )
          }
        }

        if (remote !== null) {
          // 创建远程会话（可选地带初始提示符）
          const hasInitialPrompt = remote.length > 0

          // 检查 TUI 模式是否启用 - 描述仅在 TUI 模式中可选
          const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
            'tengu_remote_backend',
            false,
          )
          if (!isRemoteTuiEnabled && !hasInitialPrompt) {
            return await exitWithError(
              root,
              'Error: --remote requires a description.\nUsage: claude --remote "your task description"',
              () => gracefulShutdown(1),
            )
          }

          logEvent('tengu_remote_create_session', {
            has_initial_prompt: String(
              hasInitialPrompt,
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // 传递当前分支，以便 CCR 在正确的修订版克隆仓库
          const currentBranch = await getBranch()
          const createdSession = await teleportToRemoteWithErrorHandling(
            root,
            hasInitialPrompt ? remote : null,
            new AbortController().signal,
            currentBranch || undefined,
          )
          if (!createdSession) {
            logEvent('tengu_remote_create_session_error', {
              error:
                'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return await exitWithError(
              root,
              'Error: Unable to create remote session',
              () => gracefulShutdown(1),
            )
          }
          logEvent('tengu_remote_create_session_success', {
            session_id:
              createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // 检查是否通过功能 gate 启用了新的远程 TUI 模式
          if (!isRemoteTuiEnabled) {
            // 原始行为：打印会话信息并退出
            process.stdout.write(
              `Created remote session: ${createdSession.title}\n`,
            )
            process.stdout.write(
              `View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`,
            )
            process.stdout.write(
              `Resume with: claude --teleport ${createdSession.id}\n`,
            )
            await gracefulShutdown(0)
            process.exit(0)
          }

          // 新行为：使用 CCR 引擎启动本地 TUI
          // 标记我们处于远程模式以显示命令
          setIsRemoteMode(true)
          switchSession(asSessionId(createdSession.id))

          // 获取远程会话的 OAuth 凭证
          let apiCreds: { accessToken: string; orgUUID: string }
          try {
            apiCreds = await prepareApiRequest()
          } catch (error) {
            logError(toError(error))
            return await exitWithError(
              root,
              `Error: ${errorMessage(error) || 'Failed to authenticate'}`,
              () => gracefulShutdown(1),
            )
          }

          // 为 REPL 创建远程会话配置
          const { getClaudeAIOAuthTokens: getTokensForRemote } = await import(
            './utils/auth.js'
          )
          const getAccessTokenForRemote = (): string =>
            getTokensForRemote()?.accessToken ?? apiCreds.accessToken
          const remoteSessionConfig = createRemoteSessionConfig(
            createdSession.id,
            getAccessTokenForRemote,
            apiCreds.orgUUID,
            hasInitialPrompt,
          )

          // 添加远程会话信息作为初始系统消息
          const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`
          const remoteInfoMessage = createSystemMessage(
            `/remote-control is active. Code in CLI or at ${remoteSessionUrl}`,
            'info',
          )

          // 如果提供提示，则从提示创建初始用户消息（CCR 会回显，但我们忽略它）
          const initialUserMessage = hasInitialPrompt
            ? createUserMessage({ content: remote })
            : null

          // 在应用状态中设置远程会话 URL 以供页脚指示器使用
          const remoteInitialState = {
            ...initialState,
            remoteSessionUrl,
          }

          // 预过滤命令以仅包括远程安全的命令。
          // CCR 的 init 响应可能会进一步细化列表（通过 REPL 中的 handleRemoteInit）。
          const remoteCommands = filterCommandsForRemoteMode(commands)
          await launchRepl(
            root,
            { getFpsMetrics, stats, initialState: remoteInitialState },
            {
              debug: debug || debugToStderr,
              commands: remoteCommands,
              initialTools: [],
              initialMessages: initialUserMessage
                ? [remoteInfoMessage, initialUserMessage]
                : [remoteInfoMessage],
              mcpClients: [],
              autoConnectIdeFlag: ide,
              mainThreadAgentDefinition,
              disableSlashCommands,
              remoteSessionConfig,
              thinkingConfig,
            },
            renderAndRun,
          )
          return
        } else if (teleport) {
          if (teleport === true || teleport === '') {
            // 交互模式：显示任务选择器并处理恢复
            logEvent('tengu_teleport_interactive_mode', {})
            logForDebugging(
              'selectAndResumeTeleportTask: Starting teleport flow...',
            )
            const teleportResult = await launchTeleportResumeWrapper(root)
            if (!teleportResult) {
              // 用户取消或发生错误
              await gracefulShutdown(0)
              process.exit(0)
            }
            const { branchError } = await checkOutTeleportedSessionBranch(
              teleportResult.branch,
            )
            messages = processMessagesForTeleportResume(
              teleportResult.log,
              branchError,
            )
          } else if (typeof teleport === 'string') {
            logEvent('tengu_teleport_resume_session', {
              mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            try {
              // 首先，获取会话并在检查 git 状态之前验证仓库
              const sessionData = await fetchSession(teleport)
              const repoValidation =
                await validateSessionRepository(sessionData)

              // 处理仓库不匹配或不在仓库中的情况
              if (
                repoValidation.status === 'mismatch' ||
                repoValidation.status === 'not_in_repo'
              ) {
                const sessionRepo = repoValidation.sessionRepo
                if (sessionRepo) {
                  // Check for known paths
                  const knownPaths = getKnownPathsForRepo(sessionRepo)
                  const existingPaths = await filterExistingPaths(knownPaths)

                  if (existingPaths.length > 0) {
                    // 显示目录切换对话框
                    const selectedPath = await launchTeleportRepoMismatchDialog(
                      root,
                      {
                        targetRepo: sessionRepo,
                        initialPaths: existingPaths,
                      },
                    )

                    if (selectedPath) {
                      // Change to the selected directory
                      process.chdir(selectedPath)
                      setCwd(selectedPath)
                      setOriginalCwd(selectedPath)
                    } else {
                      // User cancelled
                      await gracefulShutdown(0)
                    }
                  } else {
                    // No known paths - show original error
                    throw new TeleportOperationError(
                      `You must run claude --teleport ${teleport} from a checkout of ${sessionRepo}.`,
                      chalk.red(
                        `You must run claude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`,
                      ),
                    )
                  }
                }
              } else if (repoValidation.status === 'error') {
                throw new TeleportOperationError(
                  repoValidation.errorMessage || 'Failed to validate session',
                  chalk.red(
                    `Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`,
                  ),
                )
              }

              await validateGitState()

              // 使用进度 UI 进行 teleport
              const { teleportWithProgress } = await import(
                './components/TeleportProgress.js'
              )
              const result = await teleportWithProgress(root, teleport)
              // 跟踪 teleport 的会话以进行可靠性日志记录
              setTeleportedSessionInfo({ sessionId: teleport })
              messages = result.messages
            } catch (error) {
              if (error instanceof TeleportOperationError) {
                process.stderr.write(error.formattedMessage + '\n')
              } else {
                logError(error)
                process.stderr.write(
                  chalk.red(`Error: ${errorMessage(error)}\n`),
                )
              }
              await gracefulShutdown(1)
            }
          }
        }
        if (process.env.USER_TYPE === 'ant') {
          if (
            options.resume &&
            typeof options.resume === 'string' &&
            !maybeSessionId
          ) {
            // 检查 ccshare URL（例如 https://go/ccshare/boris-20260311-211036）
            const { parseCcshareId, loadCcshare } = await import(
              './utils/ccshareResume.js'
            )
            const ccshareId = parseCcshareId(options.resume)
            if (ccshareId) {
              try {
                const resumeStart = performance.now()
                const logOption = await loadCcshare(ccshareId)
                const result = await loadConversationForResume(
                  logOption,
                  undefined,
                )
                if (result) {
                  processedResume = await processResumedConversation(
                    result,
                    {
                      forkSession: true,
                      transcriptPath: result.fullPath,
                    },
                    resumeContext,
                  )
                  if (processedResume.restoredAgentDef) {
                    mainThreadAgentDefinition = processedResume.restoredAgentDef
                  }
                  logEvent('tengu_session_resumed', {
                    entrypoint:
                      'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: true,
                    resume_duration_ms: Math.round(
                      performance.now() - resumeStart,
                    ),
                  })
                } else {
                  logEvent('tengu_session_resumed', {
                    entrypoint:
                      'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: false,
                  })
                }
              } catch (error) {
                logEvent('tengu_session_resumed', {
                  entrypoint:
                    'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                })
                logError(error)
                await exitWithError(
                  root,
                  `Unable to resume from ccshare: ${errorMessage(error)}`,
                  () => gracefulShutdown(1),
                )
              }
            } else {
              const resolvedPath = resolve(options.resume)
              try {
                const resumeStart = performance.now()
                let logOption
                try {
                  // Attempt to load as a transcript file; ENOENT falls through to session-ID handling
                  logOption = await loadTranscriptFromFile(resolvedPath)
                } catch (error) {
                  if (!isENOENT(error)) throw error
                  // ENOENT: not a file path — fall through to session-ID handling
                }
                if (logOption) {
                  const result = await loadConversationForResume(
                    logOption,
                    undefined /* sourceFile */,
                  )
                  if (result) {
                    processedResume = await processResumedConversation(
                      result,
                      {
                        forkSession: !!options.forkSession,
                        transcriptPath: result.fullPath,
                      },
                      resumeContext,
                    )
                    if (processedResume.restoredAgentDef) {
                      mainThreadAgentDefinition =
                        processedResume.restoredAgentDef
                    }
                    logEvent('tengu_session_resumed', {
                      entrypoint:
                        'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: true,
                      resume_duration_ms: Math.round(
                        performance.now() - resumeStart,
                      ),
                    })
                  } else {
                    logEvent('tengu_session_resumed', {
                      entrypoint:
                        'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: false,
                    })
                  }
                }
              } catch (error) {
                logEvent('tengu_session_resumed', {
                  entrypoint:
                    'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                })
                logError(error)
                await exitWithError(
                  root,
                  `Unable to load transcript from file: ${options.resume}`,
                  () => gracefulShutdown(1),
                )
              }
            }
          }
        }

        // 如果未作为文件加载，则尝试作为会话 ID
        if (maybeSessionId) {
          // 按 ID 恢复特定会话
          const sessionId = maybeSessionId
          try {
            const resumeStart = performance.now()
            // 如果可用，使用 matchedLog（用于通过自定义标题跨 worktree 恢复）
            // 否则回退到 sessionId 字符串（用于直接 UUID 恢复）
            const result = await loadConversationForResume(
              matchedLog ?? sessionId,
              undefined,
            )

            if (!result) {
              logEvent('tengu_session_resumed', {
                entrypoint:
                  'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false,
              })
              return await exitWithError(
                root,
                `No conversation found with session ID: ${sessionId}`,
              )
            }

            const fullPath = matchedLog?.fullPath ?? result.fullPath
            processedResume = await processResumedConversation(
              result,
              {
                forkSession: !!options.forkSession,
                sessionIdOverride: sessionId,
                transcriptPath: fullPath,
              },
              resumeContext,
            )

            if (processedResume.restoredAgentDef) {
              mainThreadAgentDefinition = processedResume.restoredAgentDef
            }
            logEvent('tengu_session_resumed', {
              entrypoint:
                'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: true,
              resume_duration_ms: Math.round(performance.now() - resumeStart),
            })
          } catch (error) {
            logEvent('tengu_session_resumed', {
              entrypoint:
                'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false,
            })
            logError(error)
            await exitWithError(root, `Failed to resume session ${sessionId}`)
          }
        }

        // 在渲染 REPL 之前等待文件下载（文件必须可用）
        if (fileDownloadPromise) {
          try {
            const results = await fileDownloadPromise
            const failedCount = count(results, r => !r.success)
            if (failedCount > 0) {
              process.stderr.write(
                chalk.yellow(
                  `Warning: ${failedCount}/${results.length} file(s) failed to download.\n`,
                ),
              )
            }
          } catch (error) {
            return await exitWithError(
              root,
              `Error downloading files: ${errorMessage(error)}`,
            )
          }
        }

        // 如果我们有已处理的 resume 或 teleport 消息，则渲染 REPL
        const resumeData =
          processedResume ??
          (Array.isArray(messages)
            ? {
                messages,
                fileHistorySnapshots: undefined,
                agentName: undefined,
                agentColor: undefined as AgentColorName | undefined,
                restoredAgentDef: mainThreadAgentDefinition,
                initialState,
                contentReplacements: undefined,
              }
            : undefined)
        if (resumeData) {
          maybeActivateProactive(options)
          maybeActivateBrief(options)

          await launchRepl(
            root,
            { getFpsMetrics, stats, initialState: resumeData.initialState },
            {
              ...sessionConfig,
              mainThreadAgentDefinition:
                resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: resumeData.messages,
              initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
              initialContentReplacements: resumeData.contentReplacements,
              initialAgentName: resumeData.agentName,
              initialAgentColor: resumeData.agentColor,
            },
            renderAndRun,
          )
        } else {
          // 显示交互式选择器（包括同仓库 worktrees）
          // 注意：ResumeConversation 在内部加载日志以确保选择后正确的 GC
          await launchResumeChooser(
            root,
            { getFpsMetrics, stats, initialState },
            getWorktreePaths(getOriginalCwd()),
            {
              ...sessionConfig,
              initialSearchQuery: searchTerm,
              forkSession: options.forkSession,
              filterByPr,
            },
          )
        }
      } else {
        // 将未解析的 hooks promise 传递给 REPL，以便它可以立即渲染，
        // 而不是阻塞约 500ms 等待 SessionStart hooks 完成。
        // REPL 会在 hooks 解析时注入 hook 消息，并在第一次 API 调用之前等待它们，
        // 这样模型总是能看到 hook 上下文。
        const pendingHookMessages =
          hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined

        profileCheckpoint('action_after_hooks')
        maybeActivateProactive(options)
        maybeActivateBrief(options)
        // 为新会话持久化当前模式，以便未来的恢复知道使用了什么模式
        if (feature('COORDINATOR_MODE')) {
          saveMode(
            coordinatorModeModule?.isCoordinatorMode()
              ? 'coordinator'
              : 'normal',
          )
        }

        // 如果通过 deep link 启动，显示一个来源横幅，以便用户知道会话来自外部。
        // Linux xdg-open 和设置了"始终允许"的浏览器在没有任何操作系统级别的确认的情况下发送链接，
        // 所以这是用户获得的唯一信号，表明提示符 — 及其隐含的工作目录 / CLAUDE.md — 来自外部来源，
        // 而不是他们输入的内容。
        let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null
        if (feature('LODESTONE')) {
          if (options.deepLinkOrigin) {
            logEvent('tengu_deep_link_opened', {
              has_prefill: Boolean(options.prefill),
              has_repo: Boolean(options.deepLinkRepo),
            })
            deepLinkBanner = createSystemMessage(
              buildDeepLinkBanner({
                cwd: getCwd(),
                prefillLength: options.prefill?.length,
                repo: options.deepLinkRepo,
                lastFetch:
                  options.deepLinkLastFetch !== undefined
                    ? new Date(options.deepLinkLastFetch)
                    : undefined,
              }),
              'warning',
            )
          } else if (options.prefill) {
            deepLinkBanner = createSystemMessage(
              'Launched with a pre-filled prompt — review it before pressing Enter.',
              'warning',
            )
          }
        }
        const initialMessages = deepLinkBanner
          ? [deepLinkBanner, ...hookMessages]
          : hookMessages.length > 0
            ? hookMessages
            : undefined

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            ...sessionConfig,
            initialMessages,
            pendingHookMessages,
          },
          renderAndRun,
        )
      }
    })
    .version(
      `${MACRO.VERSION} (Claude Code)`,
      '-v, --version',
      'Output the version number',
    )

  // Worktree 标志
  program.option(
    '-w, --worktree [name]',
    'Create a new git worktree for this session (optionally specify a name)',
  )
  program.option(
    '--tmux',
    'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.',
  )

  if (canUserConfigureAdvisor()) {
    program.addOption(
      new Option(
        '--advisor <model>',
        'Enable the server-side advisor tool with the specified model (alias or full ID).',
      ).hideHelp(),
    )
  }

  if (process.env.USER_TYPE === 'ant') {
    program.addOption(
      new Option(
        '--delegate-permissions',
        '[ANT-ONLY] Alias for --permission-mode auto.',
      ).implies({ permissionMode: 'auto' }),
    )
    program.addOption(
      new Option(
        '--dangerously-skip-permissions-with-classifiers',
        '[ANT-ONLY] Deprecated alias for --permission-mode auto.',
      )
        .hideHelp()
        .implies({ permissionMode: 'auto' }),
    )
    program.addOption(
      new Option(
        '--afk',
        '[ANT-ONLY] Deprecated alias for --permission-mode auto.',
      )
        .hideHelp()
        .implies({ permissionMode: 'auto' }),
    )
    program.addOption(
      new Option(
        '--tasks [id]',
        '[ANT-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").',
      )
        .argParser(String)
        .hideHelp(),
    )
    program.option(
      '--agent-teams',
      '[ANT-ONLY] Force Claude to use multi-agent mode for solving problems',
      () => true,
    )
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(
      new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp(),
    )
  }

  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(
      new Option('--proactive', 'Start in proactive autonomous mode'),
    )
  }

  if (feature('UDS_INBOX')) {
    program.addOption(
      new Option(
        '--messaging-socket-path <path>',
        'Unix domain socket path for the UDS messaging server (defaults to a tmp path)',
      ),
    )
  }

  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(
      new Option(
        '--brief',
        'Enable SendUserMessage tool for agent-to-user communication',
      ),
    )
  }
  if (feature('KAIROS')) {
    program.addOption(
      new Option(
        '--assistant',
        'Force assistant mode (Agent SDK daemon use)',
      ).hideHelp(),
    )
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(
      new Option(
        '--channels <servers...>',
        'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.',
      ).hideHelp(),
    )
    program.addOption(
      new Option(
        '--dangerously-load-development-channels <servers...>',
        'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.',
      ).hideHelp(),
    )
  }

  // Teammate 身份选项（由 leader 在生成 tmux teammates 时设置）
  // 这些替换 CLAUDE_CODE_* 环境变量
  program.addOption(
    new Option('--agent-id <id>', 'Teammate agent ID').hideHelp(),
  )
  program.addOption(
    new Option('--agent-name <name>', 'Teammate display name').hideHelp(),
  )
  program.addOption(
    new Option(
      '--team-name <name>',
      'Team name for swarm coordination',
    ).hideHelp(),
  )
  program.addOption(
    new Option('--agent-color <color>', 'Teammate UI color').hideHelp(),
  )
  program.addOption(
    new Option(
      '--plan-mode-required',
      'Require plan mode before implementation',
    ).hideHelp(),
  )
  program.addOption(
    new Option(
      '--parent-session-id <id>',
      'Parent session ID for analytics correlation',
    ).hideHelp(),
  )
  program.addOption(
    new Option(
      '--teammate-mode <mode>',
      'How to spawn teammates: "tmux", "in-process", or "auto"',
    )
      .choices(['auto', 'tmux', 'in-process'])
      .hideHelp(),
  )
  program.addOption(
    new Option(
      '--agent-type <type>',
      'Custom agent type for this teammate',
    ).hideHelp(),
  )

  // 为所有构建启用 SDK URL，但从帮助中隐藏
  program.addOption(
    new Option(
      '--sdk-url <url>',
      'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)',
    ).hideHelp(),
  )

  // 为所有构建启用 teleport/remote 标志，但在 GA 之前保持未记录
  program.addOption(
    new Option(
      '--teleport [session]',
      'Resume a teleport session, optionally specify session ID',
    ).hideHelp(),
  )
  program.addOption(
    new Option(
      '--remote [description]',
      'Create a remote session with the given description',
    ).hideHelp(),
  )
  if (feature('BRIDGE_MODE')) {
    program.addOption(
      new Option(
        '--remote-control [name]',
        'Start an interactive session with Remote Control enabled (optionally named)',
      )
        .argParser(value => value || true)
        .hideHelp(),
    )
    program.addOption(
      new Option('--rc [name]', 'Alias for --remote-control')
        .argParser(value => value || true)
        .hideHelp(),
    )
  }

  if (feature('HARD_FAIL')) {
    program.addOption(
      new Option(
        '--hard-fail',
        'Crash on logError calls instead of silently logging',
      ).hideHelp(),
    )
  }

  profileCheckpoint('run_main_options_built')

  // -p/--print mode: skip subcommand registration. The 52 subcommands
  // (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
  // never dispatched in print mode — commander routes the prompt to the
  // default action. The subcommand registration path was measured at ~65ms
  // on baseline — mostly the isBridgeEnabled() call (25ms settings Zod parse
  // + 40ms sync keychain subprocess), both hidden by the try/catch that
  // always returns false before enableConfigs(). cc:// URLs are rewritten to
  // `open` at main() line ~851 BEFORE this runs, so argv check is safe here.
  const isPrintMode =
    process.argv.includes('-p') || process.argv.includes('--print')
  const isCcUrl = process.argv.some(
    a => a.startsWith('cc://') || a.startsWith('cc+unix://'),
  )
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse')
    await program.parseAsync(process.argv)
    profileCheckpoint('run_after_parse')
    return program
  }

  // claude mcp

  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()

  mcp
    .command('serve')
    .description(`Start the Claude Code MCP server`)
    .option('-d, --debug', 'Enable debug mode', () => true)
    .option(
      '--verbose',
      'Override verbose mode setting from config',
      () => true,
    )
    .action(
      async ({ debug, verbose }: { debug?: boolean; verbose?: boolean }) => {
        const { mcpServeHandler } = await import('./cli/handlers/mcp.js')
        await mcpServeHandler({ debug, verbose })
      },
    )

  // 注册 mcp add 子命令（为可测试性提取）
  registerMcpAddCommand(mcp)

  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp)
  }

  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in',
    )
    .action(async (name: string, options: { scope?: string }) => {
      const { mcpRemoveHandler } = await import('./cli/handlers/mcp.js')
      await mcpRemoveHandler(name, options)
    })

  mcp
    .command('list')
    .description(
      'List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const { mcpListHandler } = await import('./cli/handlers/mcp.js')
      await mcpListHandler()
    })

  mcp
    .command('get <name>')
    .description(
      'Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async (name: string) => {
      const { mcpGetHandler } = await import('./cli/handlers/mcp.js')
      await mcpGetHandler(name)
    })

  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server (stdio or SSE) with a JSON string')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    )
    .action(
      async (
        name: string,
        json: string,
        options: { scope?: string; clientSecret?: true },
      ) => {
        const { mcpAddJsonHandler } = await import('./cli/handlers/mcp.js')
        await mcpAddJsonHandler(name, json, options)
      },
    )

  mcp
    .command('add-from-claude-desktop')
    .description('Import MCP servers from Claude Desktop (Mac and WSL only)')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .action(async (options: { scope?: string }) => {
      const { mcpAddFromDesktopHandler } = await import('./cli/handlers/mcp.js')
      await mcpAddFromDesktopHandler(options)
    })

  mcp
    .command('reset-project-choices')
    .description(
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    )
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('./cli/handlers/mcp.js')
      await mcpResetChoicesHandler()
    })

  // claude server
  if (feature('DIRECT_CONNECT')) {
    program
      .command('server')
      .description('Start a Claude Code session server')
      .option('--port <number>', 'HTTP port', '0')
      .option('--host <string>', 'Bind address', '0.0.0.0')
      .option('--auth-token <token>', 'Bearer token for auth')
      .option('--unix <path>', 'Listen on a unix domain socket')
      .option(
        '--workspace <dir>',
        'Default working directory for sessions that do not specify cwd',
      )
      .option(
        '--idle-timeout <ms>',
        'Idle timeout for detached sessions in ms (0 = never expire)',
        '600000',
      )
      .option(
        '--max-sessions <n>',
        'Maximum concurrent sessions (0 = unlimited)',
        '32',
      )
      .action(
        async (opts: {
          port: string
          host: string
          authToken?: string
          unix?: string
          workspace?: string
          idleTimeout: string
          maxSessions: string
        }) => {
          const { randomBytes } = await import('crypto')
          const { startServer } = await import('./server/server.js')
          const { SessionManager } = await import('./server/sessionManager.js')
          const { DangerousBackend } = await import(
            './server/backends/dangerousBackend.js'
          )
          const { printBanner } = await import('./server/serverBanner.js')
          const { createServerLogger } = await import('./server/serverLog.js')
          const { writeServerLock, removeServerLock, probeRunningServer } =
            await import('./server/lockfile.js')

          const existing = await probeRunningServer()
          if (existing) {
            process.stderr.write(
              `A claude server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`,
            )
            process.exit(1)
          }

          const authToken =
            opts.authToken ??
            `sk-ant-cc-${randomBytes(16).toString('base64url')}`

          const config = {
            port: parseInt(opts.port, 10),
            host: opts.host,
            authToken,
            unix: opts.unix,
            workspace: opts.workspace,
            idleTimeoutMs: parseInt(opts.idleTimeout, 10),
            maxSessions: parseInt(opts.maxSessions, 10),
          }

          const backend = new DangerousBackend()
          const sessionManager = new SessionManager(backend, {
            idleTimeoutMs: config.idleTimeoutMs,
            maxSessions: config.maxSessions,
          })
          const logger = createServerLogger()

          const server = startServer(config, sessionManager, logger)
          const actualPort = server.port ?? config.port
          printBanner(config, authToken, actualPort)

          await writeServerLock({
            pid: process.pid,
            port: actualPort,
            host: config.host,
            httpUrl: config.unix
              ? `unix:${config.unix}`
              : `http://${config.host}:${actualPort}`,
            startedAt: Date.now(),
          })

          let shuttingDown = false
          const shutdown = async () => {
            if (shuttingDown) return
            shuttingDown = true
            // 在拆除会话之前停止接受新连接。
            server.stop(true)
            await sessionManager.destroyAll()
            await removeServerLock()
            process.exit(0)
          }
          process.once('SIGINT', () => void shutdown())
          process.once('SIGTERM', () => void shutdown())
        },
      )
  }

  // `claude ssh <host> [dir]` — 仅在此注册以便 --help 显示它。
  // 实际的交互流程由 main() 中的早期 argv 重写处理
  //（与上面的 DIRECT_CONNECT/cc:// 模式类似）。如果 commander 到达
  // 此操作意味着 argv 重写未触发（例如用户运行了
  // `claude ssh` 但没有主机）— 只打印用法。
  if (feature('SSH_REMOTE')) {
    program
      .command('ssh <host> [dir]')
      .description(
        'Run Claude Code on a remote host over SSH. Deploys the binary and ' +
          'tunnels API auth back through your local machine — no remote setup needed.',
      )
      .option(
        '--permission-mode <mode>',
        'Permission mode for the remote session',
      )
      .option(
        '--dangerously-skip-permissions',
        'Skip all permission prompts on the remote (dangerous)',
      )
      .option(
        '--local',
        'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' +
          'Exercises the auth proxy and unix-socket plumbing without a remote host.',
      )
      .action(async () => {
        // main() 中的 argv 重写应该在 commander 运行之前消费了 `ssh <host>`。
        // 到达这里意味着主机缺失或重写谓词不匹配。
        process.stderr.write(
          'Usage: claude ssh <user@host | ssh-config-alias> [dir]\n\n' +
            "Runs Claude Code on a remote Linux host. You don't need to install\n" +
            'anything on the remote or run `claude auth login` there — the binary is\n' +
            'deployed over SSH and API auth tunnels back through your local machine.\n',
        )
        process.exit(1)
      })
  }

  // claude connect — 子命令仅处理 -p（headless）模式。
  // 交互模式（不带 -p）由 main() 中的早期 argv 重写处理，
  // 它重定向到具有完整 TUI 支持的主命令。
  if (feature('DIRECT_CONNECT')) {
    program
      .command('open <cc-url>')
      .description(
        'Connect to a Claude Code server (internal — use cc:// URLs)',
      )
      .option('-p, --print [prompt]', 'Print mode (headless)')
      .option(
        '--output-format <format>',
        'Output format: text, json, stream-json',
        'text',
      )
      .action(
        async (
          ccUrl: string,
          opts: {
            print?: string | boolean
            outputFormat: string
          },
        ) => {
          const { parseConnectUrl } = await import(
            './server/parseConnectUrl.js'
          )
          const { serverUrl, authToken } = parseConnectUrl(ccUrl)

          let connectConfig
          try {
            const session = await createDirectConnectSession({
              serverUrl,
              authToken,
              cwd: getOriginalCwd(),
              dangerouslySkipPermissions:
                _pendingConnect?.dangerouslySkipPermissions,
            })
            if (session.workDir) {
              setOriginalCwd(session.workDir)
              setCwdState(session.workDir)
            }
            setDirectConnectServerUrl(serverUrl)
            connectConfig = session.config
          } catch (err) {
            // biome-ignore lint/suspicious/noConsole: intentional error output
            console.error(
              err instanceof DirectConnectError ? err.message : String(err),
            )
            process.exit(1)
          }

          const { runConnectHeadless } = await import(
            './server/connectHeadless.js'
          )

          const prompt = typeof opts.print === 'string' ? opts.print : ''
          const interactive = opts.print === true
          await runConnectHeadless(
            connectConfig,
            prompt,
            opts.outputFormat,
            interactive,
          )
        },
      )
  }

  // claude auth

  const auth = program
    .command('auth')
    .description('Manage authentication')
    .configureHelp(createSortedHelpConfig())

  auth
    .command('login')
    .description('Sign in to your Anthropic account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option(
      '--console',
      'Use Anthropic Console (API usage billing) instead of Claude subscription',
    )
    .option('--claudeai', 'Use Claude subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        claudeai,
      }: {
        email?: string
        sso?: boolean
        console?: boolean
        claudeai?: boolean
      }) => {
        const { authLogin } = await import('./cli/handlers/auth.js')
        await authLogin({ email, sso, console: useConsole, claudeai })
      },
    )

  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('./cli/handlers/auth.js')
      await authStatus(opts)
    })

  auth
    .command('logout')
    .description('Log out from your Anthropic account')
    .action(async () => {
      const { authLogout } = await import('./cli/handlers/auth.js')
      await authLogout()
    })

  /**
   * 辅助函数，用于一致地处理 marketplace 命令错误。
   * 记录错误并以状态 1 退出进程。
   * @param error 发生的错误
   * @param action 失败操作的描述
   */
  // 在所有 plugin/marketplace 子命令上的隐藏标志，以定位 cowork_plugins。
  const coworkOption = () =>
    new Option('--cowork', 'Use cowork_plugins directory').hideHelp()

  // 插件验证命令
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage Claude Code plugins')
    .configureHelp(createSortedHelpConfig())

  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(async (manifestPath: string, options: { cowork?: boolean }) => {
      const { pluginValidateHandler } = await import(
        './cli/handlers/plugins.js'
      )
      await pluginValidateHandler(manifestPath, options)
    })

  // 插件列表命令
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option(
      '--available',
      'Include available plugins from marketplaces (requires --json)',
    )
    .addOption(coworkOption())
    .action(
      async (options: {
        json?: boolean
        available?: boolean
        cowork?: boolean
      }) => {
        const { pluginListHandler } = await import('./cli/handlers/plugins.js')
        await pluginListHandler(options)
      },
    )

  // 市场口子命令
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage Claude Code marketplaces')
    .configureHelp(createSortedHelpConfig())

  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins',
    )
    .option(
      '--scope <scope>',
      'Where to declare the marketplace: user (default), project, or local',
    )
    .action(
      async (
        source: string,
        options: { cowork?: boolean; sparse?: string[]; scope?: string },
      ) => {
        const { marketplaceAddHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await marketplaceAddHandler(source, options)
      },
    )

  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import(
        './cli/handlers/plugins.js'
      )
      await marketplaceListHandler(options)
    })

  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(async (name: string, options: { cowork?: boolean }) => {
      const { marketplaceRemoveHandler } = await import(
        './cli/handlers/plugins.js'
      )
      await marketplaceRemoveHandler(name, options)
    })

  marketplaceCmd
    .command('update [name]')
    .description(
      'Update marketplace(s) from their source - updates all if no name specified',
    )
    .addOption(coworkOption())
    .action(async (name: string | undefined, options: { cowork?: boolean }) => {
      const { marketplaceUpdateHandler } = await import(
        './cli/handlers/plugins.js'
      )
      await marketplaceUpdateHandler(name, options)
    })

  // 插件安装命令
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description(
      'Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)',
    )
    .option(
      '-s, --scope <scope>',
      'Installation scope: user, project, or local',
      'user',
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginInstallHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await pluginInstallHandler(plugin, options)
      },
    )

  // 插件卸载命令
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option(
      '-s, --scope <scope>',
      'Uninstall from scope: user, project, or local',
      'user',
    )
    .option(
      '--keep-data',
      "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)",
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: { scope?: string; cowork?: boolean; keepData?: boolean },
      ) => {
        const { pluginUninstallHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await pluginUninstallHandler(plugin, options)
      },
    )

  // 插件启用命令
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginEnableHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await pluginEnableHandler(plugin, options)
      },
    )

  // 插件禁用命令
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string | undefined,
        options: { scope?: string; cowork?: boolean; all?: boolean },
      ) => {
        const { pluginDisableHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await pluginDisableHandler(plugin, options)
      },
    )

  // 插件更新命令
  pluginCmd
    .command('update <plugin>')
    .description(
      'Update a plugin to the latest version (restart required to apply)',
    )
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`,
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginUpdateHandler } = await import(
          './cli/handlers/plugins.js'
        )
        await pluginUpdateHandler(plugin, options)
      },
    )
  // END ANT-ONLY

  // 设置令牌命令
  program
    .command('setup-token')
    .description(
      'Set up a long-lived authentication token (requires Claude subscription)',
    )
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('@anthropic/ink'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await setupTokenHandler(root)
    })

  // Agents 命令 - 列出配置的代理
  program
    .command('agents')
    .description('List configured agents')
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    .action(async () => {
      const { agentsHandler } = await import('./cli/handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 当 tengu_auto_mode_config.enabled === 'disabled' 时跳过（断路器）。
    // 从磁盘缓存读取 — GrowthBook 在注册时未初始化。
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program
        .command('auto-mode')
        .description('Inspect auto mode classifier configuration')

      autoModeCmd
        .command('defaults')
        .description(
          'Print the default auto mode environment, allow, and deny rules as JSON',
        )
        .action(async () => {
          const { autoModeDefaultsHandler } = await import(
            './cli/handlers/autoMode.js'
          )
          autoModeDefaultsHandler()
          process.exit(0)
        })

      autoModeCmd
        .command('config')
        .description(
          'Print the effective auto mode config as JSON: your settings where set, defaults otherwise',
        )
        .action(async () => {
          const { autoModeConfigHandler } = await import(
            './cli/handlers/autoMode.js'
          )
          autoModeConfigHandler()
          process.exit(0)
        })

      autoModeCmd
        .command('critique')
        .description('Get AI feedback on your custom auto mode rules')
        .option('--model <model>', 'Override which model is used')
        .action(async options => {
          const { autoModeCritiqueHandler } = await import(
            './cli/handlers/autoMode.js'
          )
          await autoModeCritiqueHandler(options)
          process.exit()
        })
    }
  }

  // Remote Control 命令 — 将本地环境连接到 claude.ai/code。
  // 实际命令在 Commander.js 运行之前被 cli.tsx 中的快速路径拦截，
  // 因此此注册仅用于帮助输出。
  // 始终隐藏：此时（enableConfigs 之前）的 isBridgeEnabled()
  // 会在 isClaudeAISubscriber → getGlobalConfig 内部抛出并通过 try/catch 返回 false —
  // 但在此之前需要支付约 65ms 的副作用
  //（25ms 设置 Zod 解析 + 40ms 同步 `security` 钥匙串子进程）。
  // 动态可见性从未生效；该命令始终被隐藏。
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control', { hidden: true })
      .alias('rc')
      .description(
        'Connect your local environment for remote-control sessions via claude.ai/code',
      )
      .action(async () => {
        // 不可到达——cli.tsx 快速路径在 main.tsx 加载之前处理此命令。
        // 如果以某种方式到达，则委托给 bridgeMain。
        const { bridgeMain } = await import('./bridge/bridgeMain.js')
        await bridgeMain(process.argv.slice(3))
      })
  }

  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // 上面的 Argv 重写应该在 commander 运行之前消耗了 `assistant [id]`。
        // 到达这里意味着根标志首先出现（例如 `--debug assistant`），
        // 并且位置 0 谓词不匹配。像 ssh stub 一样打印用法。
        process.stderr.write(
          'Usage: claude assistant [sessionId]\n\n' +
            'Attach the REPL as a viewer client to a running bridge session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        )
        process.exit(1)
      })
  }

  // Doctor 命令 - 检查安装健康状态
  program
    .command('doctor')
    .description(
      'Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('@anthropic/ink'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await doctorHandler(root)
    })

  // claude update
  //
  // 对于带构建元数据的 SemVer 兼容版本控制（X.X.X+SHA）：
  // - 我们执行精确的字符串比较（包括 SHA）来检测任何更改
  // - 这确保用户总是获得最新的构建，即使只有 SHA 更改
  // - UI 显示两个版本，包括构建元数据以供清晰
  program
    .command('update')
    .alias('upgrade')
    .description('Check for updates and install if available')
    .action(async () => {
      const { update } = await import('src/cli/update.js')
      await update()
    })

  // claude up — run the project's CLAUDE.md "# claude up" setup instructions.
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('up')
      .description(
        '[ANT-ONLY] Initialize or upgrade the local dev environment using the "# claude up" section of the nearest CLAUDE.md',
      )
      .action(async () => {
        const { up } = await import('src/cli/up.js')
        await up()
      })
  }

  // claude rollback (ant-only)
  // 回滚到以前的版本
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('rollback [target]')
      .description(
        '[ANT-ONLY] Roll back to a previous release\n\nExamples:\n  claude rollback                                    Go 1 version back from current\n  claude rollback 3                                  Go 3 versions back from current\n  claude rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version',
      )
      .option('-l, --list', 'List recent published versions with ages')
      .option('--dry-run', 'Show what would be installed without installing')
      .option(
        '--safe',
        'Roll back to the server-pinned safe version (set by oncall during incidents)',
      )
      .action(
        async (
          target?: string,
          options?: { list?: boolean; dryRun?: boolean; safe?: boolean },
        ) => {
          const { rollback } = await import('src/cli/rollback.js')
          await rollback(target, options)
        },
      )
  }

  // claude install
  program
    .command('install [target]')
    .description(
      'Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)',
    )
    .option('--force', 'Force installation even if already installed')
    .action(
      async (target: string | undefined, options: { force?: boolean }) => {
        const { installHandler } = await import('./cli/handlers/util.js')
        await installHandler(target, options)
      },
    )

  // ant-only commands
  if (process.env.USER_TYPE === 'ant') {
    const validateLogId = (value: string) => {
      const maybeSessionId = validateUuid(value)
      if (maybeSessionId) return maybeSessionId
      return Number(value)
    }
    // claude log
    program
      .command('log')
      .description('[ANT-ONLY] Manage conversation logs.')
      .argument(
        '[number|sessionId]',
        'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log',
        validateLogId,
      )
      .action(async (logId: string | number | undefined) => {
        const { logHandler } = await import('./cli/handlers/ant.js')
        await logHandler(logId)
      })

    // claude error
    program
      .command('error')
      .description(
        '[ANT-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.',
      )
      .argument(
        '[number]',
        'A number (0, 1, 2, etc.) to display a specific log',
        parseInt,
      )
      .action(async (number: number | undefined) => {
        const { errorHandler } = await import('./cli/handlers/ant.js')
        await errorHandler(number)
      })

    // claude export
    program
      .command('export')
      .description('[ANT-ONLY] Export a conversation to a text file.')
      .usage('<source> <outputFile>')
      .argument(
        '<source>',
        'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file',
      )
      .argument('<outputFile>', 'Output file path for the exported text')
      .addHelpText(
        'after',
        `
Examples:
  $ claude export 0 conversation.txt                Export conversation at log index 0
  $ claude export <uuid> conversation.txt           Export conversation by session ID
  $ claude export input.json output.txt             Render JSON log file to text
  $ claude export <uuid>.jsonl output.txt           Render JSONL session file to text`,
      )
      .action(async (source: string, outputFile: string) => {
        const { exportHandler } = await import('./cli/handlers/ant.js')
        await exportHandler(source, outputFile)
      })

    if (process.env.USER_TYPE === 'ant') {
      const taskCmd = program
        .command('task')
        .description('[ANT-ONLY] Manage task list tasks')

      taskCmd
        .command('create <subject>')
        .description('Create a new task')
        .option('-d, --description <text>', 'Task description')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(
          async (
            subject: string,
            opts: { description?: string; list?: string },
          ) => {
            const { taskCreateHandler } = await import('./cli/handlers/ant.js')
            await taskCreateHandler(subject, opts)
          },
        )

      taskCmd
        .command('list')
        .description('List all tasks')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option('--pending', 'Show only pending tasks')
        .option('--json', 'Output as JSON')
        .action(
          async (opts: {
            list?: string
            pending?: boolean
            json?: boolean
          }) => {
            const { taskListHandler } = await import('./cli/handlers/ant.js')
            await taskListHandler(opts)
          },
        )

      taskCmd
        .command('get <id>')
        .description('Get details of a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (id: string, opts: { list?: string }) => {
          const { taskGetHandler } = await import('./cli/handlers/ant.js')
          await taskGetHandler(id, opts)
        })

      taskCmd
        .command('update <id>')
        .description('Update a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option(
          '-s, --status <status>',
          `Set status (${TASK_STATUSES.join(', ')})`,
        )
        .option('--subject <text>', 'Update subject')
        .option('-d, --description <text>', 'Update description')
        .option('--owner <agentId>', 'Set owner')
        .option('--clear-owner', 'Clear owner')
        .action(
          async (
            id: string,
            opts: {
              list?: string
              status?: string
              subject?: string
              description?: string
              owner?: string
              clearOwner?: boolean
            },
          ) => {
            const { taskUpdateHandler } = await import('./cli/handlers/ant.js')
            await taskUpdateHandler(id, opts)
          },
        )

      taskCmd
        .command('dir')
        .description('Show the tasks directory path')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (opts: { list?: string }) => {
          const { taskDirHandler } = await import('./cli/handlers/ant.js')
          await taskDirHandler(opts)
        })
    }

    // claude completion <shell>
    program
      .command('completion <shell>', { hidden: true })
      .description('Generate shell completion script (bash, zsh, or fish)')
      .option(
        '--output <file>',
        'Write completion script directly to a file instead of stdout',
      )
      .action(async (shell: string, opts: { output?: string }) => {
        const { completionHandler } = await import('./cli/handlers/ant.js')
        await completionHandler(shell, opts, program)
      })
  }

  profileCheckpoint('run_before_parse')
  await program.parseAsync(process.argv)
  profileCheckpoint('run_after_parse')

  // 记录最终检查点以计算 total_time
  profileCheckpoint('main_after_run')

  // 将启动性能记录到 Statsig（采样）并在启用时输出详细报告
  profileReport()

  return program
}

async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath,
}: {
  hasInitialPrompt: boolean
  hasStdin: boolean
  verbose: boolean
  debug: boolean
  debugToStderr: boolean
  print: boolean
  outputFormat: string
  inputFormat: string
  numAllowedTools: number
  numDisallowedTools: number
  mcpClientCount: number
  worktreeEnabled: boolean
  skipWebFetchPreflight: boolean | undefined
  githubActionInputs: string | undefined
  dangerouslySkipPermissionsPassed: boolean
  permissionMode: string
  modeIsBypass: boolean
  allowDangerouslySkipPermissionsPassed: boolean
  systemPromptFlag: 'file' | 'flag' | undefined
  appendSystemPromptFlag: 'file' | 'flag' | undefined
  thinkingConfig: ThinkingConfig
  assistantActivationPath: string | undefined
}): Promise<void> {
  try {
    logEvent('tengu_init', {
      entrypoint:
        'claude' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat:
        outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat:
        inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs:
          githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode:
        permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType:
        thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(systemPromptFlag && {
        systemPromptFlag:
          systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag:
          appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator:
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
          ? true
          : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath:
          assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ??
        'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(process.env.USER_TYPE === 'ant'
        ? (() => {
            const cwd = getCwd()
            const gitRoot = findGitRoot(cwd)
            const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined
            return rp
              ? {
                  relativeProjectPath:
                    rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                }
              : {}
          })()
        : {}),
    })
  } catch (error) {
    logError(error)
  }
}

function maybeActivateProactive(options: unknown): void {
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((options as { proactive?: boolean }).proactive ||
      isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js')
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command')
    }
  }
}

function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return
  const briefFlag = (options as { brief?: boolean }).brief
  const briefEnv = isEnvTruthy(process.env.CLAUDE_CODE_BRIEF)
  if (!briefFlag && !briefEnv) return
  // --brief / CLAUDE_CODE_BRIEF are explicit opt-ins: check entitlement,
  // then set userMsgOptIn to activate the tool + prompt section. The env
  // var also grants entitlement (isBriefEntitled() reads it), so setting
  // CLAUDE_CODE_BRIEF=1 单独强制启用 for dev/testing——无需 GB gate
  // needed. initialIsBriefOnly reads getUserMsgOptIn() directly.
  // 条件导入：静态导入会泄露工具名称字符串
  // into external builds via BriefTool.ts → prompt.ts.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { isBriefEntitled } =
    require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled()
  if (entitled) {
    setUserMsgOptIn(true)
  }
  // 一旦看到意图就无条件触发：enabled=false 捕获
  // "user tried but was gated" failure mode in Datadog.
  logEvent('tengu_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv
      ? 'env'
      : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function resetCursor() {
  const terminal = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : undefined
  terminal?.write(SHOW_CURSOR)
}

type TeammateOptions = {
  agentId?: string
  agentName?: string
  teamName?: string
  agentColor?: string
  planModeRequired?: boolean
  parentSessionId?: string
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  agentType?: string
}

function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const opts = options as Record<string, unknown>
  const teammateMode = opts.teammateMode
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor:
      typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired:
      typeof opts.planModeRequired === 'boolean'
        ? opts.planModeRequired
        : undefined,
    parentSessionId:
      typeof opts.parentSessionId === 'string'
        ? opts.parentSessionId
        : undefined,
    teammateMode:
      teammateMode === 'auto' ||
      teammateMode === 'tmux' ||
      teammateMode === 'in-process'
        ? teammateMode
        : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined,
  }
}
