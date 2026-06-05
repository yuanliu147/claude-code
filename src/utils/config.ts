import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  BillingType,
  ReferralEligibilityResponse,
} from '../services/oauth/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// 防重入保护：防止配置文件损坏时出现 getConfig → logEvent → getGlobalConfig → getConfig
// 的无限递归。logEvent 的采样检查会从全局配置读取 GrowthBook 特性，
// 这会再次调用 getConfig。
let insideGetConfig = false

// 图像尺寸信息，用于坐标映射（仅在图像被调整大小时设置）
export type PastedContent = {
  id: number // 顺序数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 例如 'image/png', 'image/jpeg'
  filename?: string // 附件槽中图像的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string // 拖拽到终端的图像的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // 信任对话框设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP 服务器审批字段 - 已迁移到设置中，但为保持向后兼容而保留
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 已禁用的 MCP 服务器列表（所有作用域）- 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 内置 MCP 服务器的 opt-in 列表，默认为禁用状态
  enabledMcpServers?: string[]
  // Worktree 会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** `claude remote-control` 多会话的生成模式。首次运行对话框或 `w` 切换设置。 */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // added 4/23/2025, not populated for existing users
  organizationRole?: string | null
  workspaceRole?: string | null
  // Populated by /api/oauth/profile
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO: 'emacs' is kept for backward compatibility - remove after a few releases
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated 使用 settings.apiKeyHelper 代替。
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 区分基于保护禁用和用户偏好的标志
  autoUpdatesProtectedForNative?: boolean
  // 上次显示 Doctor 时的会话数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 跟踪上次重置 onboarding 的版本，用于与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 配合
  lastOnboardingVersion?: string
  // 跟踪上次看到发布说明的版本，用于管理发布说明
  lastReleaseNotesSeen?: string
  // 上次获取 changelog 的时间戳（内容存储在 ~/.claude/cache/changelog.md）
  changelogLastFetched?: number
  // @deprecated - 已迁移到 ~/.claude/cache/changelog.md。保留用于迁移支持。
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // claude.ai MCP 连接器，至少成功连接过一次。
  // 用于控制"连接器不可用"/"需要认证"启动通知：
  // 用户实际使用过的连接器在出现故障时值得标记，
  // 但组织配置的连接器从第一天起就需要认证，
  // 这是用户明显忽略的东西，不应该反复提醒。
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated. 使用通知钩子代替（docs/hooks.md）。
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 当未设置环境变量时用户的主要 API key，通过 oauth 设置（TODO：重命名）
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // ant only：是否已显示一次性自动潜伏解释器
  hasSeenUltraplanTerms?: boolean // ant only：是否已在 ultraplan 启动对话框中显示一次性 CCR 条款通知
  hasResetAutoModeOptInForDefaultOffer?: boolean // ant only：一次性的迁移保护，重新提示已流失的自动模式用户
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // 遗留字段 - 为保持向后兼容而保留
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 控制是否启用自动压缩
  showTurnDuration: boolean // 控制是否显示回合持续时间消息（例如 "Cooked for 1m 6s"）
  /**
   * @deprecated 使用 settings.env 代替。
   */
  env: { [key: string]: string } // 要为 CLI 设置的环境变量
  hasSeenTasksHint?: boolean // 用户是否已看过任务提示
  hasUsedStash?: boolean // 用户是否使用过 stash 功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否将任务置于后台（Ctrl+B）
  queuedCommandUpHintCount?: number // 用户看到排队命令提示的次数计数器
  diffTool?: DiffTool // 用于显示 diff 的工具（terminal 或 vscode）

  // 终端设置状态跟踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 首选项备份文件的路径
  appleTerminalBackupPath?: string // Terminal.app 首选项备份文件的路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 设置是否正在进行

  // 键绑定设置跟踪
  shiftEnterKeyBindingInstalled?: boolean // 是否已安装 Shift+Enter 键绑定（用于 iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // 是否已安装 Option 作为 Meta 键（用于 Terminal.app）

  // IDE 配置
  autoConnectIde?: boolean // 启动时是否自动连接到 IDE（当恰好有一个有效 IDE 时）
  autoInstallIdeExtension?: boolean // 从 IDE 内运行时是否自动安装 IDE 扩展

  // IDE 对话框
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 终端名称到 IDE 入门是否已显示的映射
  ideHintShownCount?: number // /ide 命令提示已显示的次数
  hasIdeAutoConnectDialogBeenShown?: boolean // 自动连接 IDE 对话框是否已显示

  tipsHistory: {
    [tipId: string]: number // key 是 tipId，value 是上次显示 tip 时的 numStartups
  }

  // /buddy 伙伴灵魂 — 读取时从 userId 重新生成骨骼。参见 src/buddy/。
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // 反馈调查跟踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 成绩单分享提示跟踪（"不再询问"）
  transcriptShareDismissed?: boolean

  // 内存使用跟踪
  memoryUsageCount: number // 用户添加内存的次数

  // Sonnet-1M 配置
  hasShownS1MWelcomeV2?: Record<string, boolean> // 每个组织是否已显示 Sonnet-1M v2 欢迎消息
  // 每个组织的 Sonnet-1M 订阅者访问缓存 - key 是组织 ID
  // hasAccess 表示"hasAccessAsDefault"，但旧名称为保持向后兼容而保留。
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // 每个组织的 Sonnet-1M PayG 访问缓存 - key 是组织 ID
  // hasAccess 表示"hasAccessAsDefault"，但旧名称为保持向后兼容而保留。
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // 每个组织的访客通行资格缓存 - key 是组织 ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // 每个账户的 Grove 配置缓存 - key 是账户 UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  // 访客通行升级销售跟踪
  passesUpsellSeenCount?: number // 访客通行升级销售已显示的次数
  hasVisitedPasses?: boolean // 用户是否访问过 /passes 命令
  passesLastSeenRemaining?: number // 上次看到的剩余通行数 — 当增加时重置升级销售

  // 超额积分授予升级销售跟踪（按组织 UUID 作为 key — 多组织用户）。
  // 内联形状（不是 import()），因为 config.ts 在 SDK 构建表面，
  // SDK bundler 无法解析 CLI 服务模块。
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number // 超额积分升级销售已显示的次数
  hasVisitedExtraUsage?: boolean // 用户是否访问过 /extra-usage — 隐藏积分升级销售

  // 语音模式通知跟踪
  voiceNoticeSeenCount?: number // 语音模式可用通知已显示的次数
  voiceLangHintShownCount?: number // /voice 听写语言提示已显示的次数
  voiceLangHintLastLanguage?: string // 上次显示提示时解析的 STT 语言代码 — 当更改时重置计数
  voiceFooterHintSeenCount?: number // "按住 X 说话" 页脚提示已显示的会话次数

  // Opus 1M 合并通知跟踪
  opus1mMergeNoticeSeenCount?: number // opus-1m-merge 通知已显示的次数

  // 实验注册通知跟踪（按实验 id 作为 key）
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan 实验配置
  hasShownOpusPlanWelcome?: Record<string, boolean> // 每个组织是否已显示 OpusPlan 欢迎消息

  // 提示队列使用跟踪
  promptQueueUseCount: number // 用户使用提示队列的次数

  // Btw 使用跟踪
  btwUseCount: number // 用户使用 /btw 的次数

  // 计划模式使用跟踪
  lastPlanModeUse?: number // 上次使用计划模式的时间戳

  // 订阅通知跟踪
  subscriptionNoticeCount?: number // 订阅通知已显示的次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅升级销售已显示的次数（已弃用）
  recommendedSubscription?: string // 来自 Statsig 的缓存配置值（已弃用）

  // Todo 功能配置
  todoFeatureEnabled: boolean // todo 功能是否启用
  showExpandedTodos?: boolean // 是否展开显示 todos，即使为空
  showSpinnerTree?: boolean // 是否显示队友旋转树而不是药丸

  // 首次启动时间跟踪
  firstStartTime?: string // Claude Code 首次在此机器上启动时的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户需要空闲多长时间才能收到 Claude 完成生成的通知

  githubActionSetupCount?: number // 用户设置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack 应用的次数

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端标签状态指示器（OSC 21337）。开启时，向标签侧边栏
  // 发送彩色圆点 + 状态文本，并从标题中删除旋转器前缀
  // （圆点使旋转器前缀变得冗余）。
  showStatusInTerminalTab?: boolean

  // 推送通知切换（通过 /config 设置）。默认关闭 — 需要明确选择加入。
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code 使用跟踪
  claudeCodeFirstTokenDate?: string // 用户首次 Claude Code OAuth 令牌的 ISO 时间戳

  // 模型切换提示跟踪（ant only）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择了"不再显示"
  modelSwitchCalloutLastShown?: number // 上次显示的时间戳（24 小时内不显示）
  modelSwitchCalloutVersion?: string

  // 努力程度提示跟踪 — 仅向 Opus 4.6 用户显示一次
  effortCalloutDismissed?: boolean // v1 - 遗留，读取以压制已看到的 Pro 用户的 v2
  effortCalloutV2Dismissed?: boolean

  // 远程提示跟踪 — 首次启用 bridge 前显示一次
  remoteDialogSeen?: boolean

  // initReplBridge 的 oauth_expired_unrefreshable 跳过的跨进程退避。
  // `expiresAt` 是去重 key — 内容寻址，当 /login
  // 替换令牌时自动清除。`failCount` 限制误报：临时刷新
  // 失败（auth server 5xx、锁错误）在退避启动前获得 3 次重试，
  // 与 useReplBridge 的 MAX_CONSECUTIVE_INIT_FAILURES 一致。死令牌
  // 账户限制在 3 次配置写入；健康 + 临时波动在约 210 秒内自愈。
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // 桌面升级销售启动对话框跟踪
  desktopUpsellSeenCount?: number // 总显示次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 是否选择"不再询问"

  // 空闲返回对话框跟踪
  idleReturnDismissed?: boolean // 是否选择"不再询问"

  // Opus 4.5 Pro 迁移跟踪
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m 迁移跟踪
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → 当前 Opus 迁移（显示一次性通知）
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 迁移（pro/max/team premium）
  sonnet45To46MigrationTimestamp?: number

  // 缓存的 statsig gate 值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook 特性值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖（ant only，通过 /config Gates 选项卡设置）。
  // 在环境变量覆盖之后但在真实解析值之前检查。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示跟踪 — 存储上次显示的提示以防止重新显示
  lastShownEmergencyTip?: string

  // 文件选择器 gitignore 行为
  respectGitignore: boolean // 文件选择器是否应遵守 .gitignore 文件（默认：true）。注意：.ignore 文件始终被遵守

  // Copy 命令行为
  copyFullResponse: boolean // /copy 是否始终复制完整响应而不是显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 鼠标松开时自动复制到剪贴板（undefined → true；使 cmd+c 通过无操作"工作"）

  // 用于远程目录切换的 GitHub 仓库路径映射
  // key: "owner/repo"（小写），value: 仓库克隆到的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // 用于 claude-cli:// 深度链接启动的终端模拟器。从
  // 交互会话期间的 TERM_PROGRAM 捕获，因为深度链接处理器
  // 无头运行（LaunchServices/xdg），没有设置 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 设置
  iterm2It2SetupComplete?: boolean // it2 设置是否已验证
  preferTmuxOverIterm2?: boolean // 用户偏好始终使用 tmux 而不是 iTerm2 拆分窗格

  // 用于自动完成排名的技能使用跟踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方市场自动安装跟踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否已尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（如果适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 上次尝试的时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 最早重试时间

  // Chrome 中的 Claude 设置
  hasCompletedClaudeInChromeOnboarding?: boolean // Chrome 中的 Claude 入门是否已显示
  claudeInChromeDefaultEnabled?: boolean // Chrome 中的 Claude 是否默认启用（undefined 表示平台默认值）
  cachedChromeExtensionInstalled?: boolean // Chrome 扩展是否安装的缓存结果

  // Chrome 扩展配对状态（跨会话持久化）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP 插件推荐偏好
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件推荐
  lspRecommendationNeverPlugins?: string[] // 从不推荐的插件 ID
  lspRecommendationIgnoredCount?: number // 跟踪忽略的推荐（5 次后停止）

  // Claude Code 提示协议状态（来自 CLI/SDK 的 <claude-code-hint /> 标签）。
  // 按提示类型嵌套，以便未来的类型（docs、mcp 等）无需新的
  // 顶级 key 即可接入。
  claudeCodeHints?: {
    // 用户已收到提示的插件 ID。一次显示语义：
    // 无论是否/否响应都会被记录，不会重新提示。限制在
    // 100 个条目以限制配置增长 — 超过此数量后，提示完全停止。
    plugin?: string[]
    // 用户在对话框中选择了"不再显示插件安装提示"。
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 启用 Haiku 生成的权限请求解释（默认：true）

  // 队友生成模式：'auto' | 'tmux' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'in-process' // 如何生成队友（默认：'auto'）
  // 工具调用未传递模型时新队友使用的模型。
  // undefined = 硬编码 Opus（向后兼容）；null = 领导者的模型；string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 进行特性标志）
  prStatusFooterEnabled?: boolean // 在页脚显示 PR 审核状态（默认：true）

  // Tmux 实时面板可见性（ant only，通过 tmux 药丸上的 Enter 切换）
  tungstenPanelVisible?: boolean

  // 缓存的来自 API 的组织级快速模式状态。
  // 用于检测跨会话更改并通知用户。
  penguinModeOrgEnabled?: boolean

  // 上次运行后台刷新的 epoch 毫秒（快速模式、配额、通行、客户端数据）。
  // 与 tengu_cicada_nap_ms 配合使用以限制 API 调用
  startupPrefetchedAt?: number

  // 启动时运行远程控制（需要 BRIDGE_MODE）
  // undefined = 使用默认值（参见 getRemoteControlAtStartup() 的优先级）
  remoteControlAtStartup?: boolean

  // 上次 API 响应中缓存的超额使用禁用原因
  // undefined = 无缓存，null = 超额使用已启用，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知跟踪（ant only）
  autoPermissionsNotificationCount?: number // 自动权限通知已显示的次数

  // 推测配置（ant only）
  speculationEnabled?: boolean // 推测是否启用（默认：true）


  // 用于服务端实验的客户端数据（引导期间获取）。
  clientDataCache?: Record<string, unknown> | null

  // 模型选择器的附加模型选项（引导期间获取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // 组织级设置很少更改；跨进程持久化避免
  // 每次 `claude -p` 调用时冰冷的 API 调用。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 上次应用的迁移集的版本。当等于
  // CURRENT_MIGRATION_VERSION 时，runMigrations() 跳过所有同步迁移
  // （避免每次启动时 11 次 saveGlobalConfig 锁 + 重读）。
  migrationVersion?: number
}

/**
 * 用于创建全新默认 GlobalConfig 的工厂函数。用于替代深度克隆
 * 共享常量 — 嵌套容器（数组、对象）都是空的，
 * 因此工厂函数可以零克隆成本提供新的引用。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查用户是否已接受当前工作目录的信任对话框。
 *
 * 此函数遍历父目录以检查父目录是否已有批准。
 * 接受一个目录的信任意味着对其子目录的信任。
 *
 * @returns 信任对话框是否已被接受（即"不应再显示"）
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // 信任在会话期间只能从 false→true（从不会反向），
  // 所以一旦为 true 我们就可以锁定它。false 不会被缓存 — 每次调用都会重新检查，
  // 以便在会话中途也能获取信任对话框的接受状态。
  // （lodash memoize 不适用于此，因为它也会缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // 检查会话级信任（用于主目录情况下信任未持久化）
  // 从主目录运行时，会显示信任对话框，但接受状态仅存储在内存中。
  // 这允许钩子和其他功能在会话期间工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 始终检查信任会被保存的位置（git 根目录或原始 cwd）
  // 这是信任通过 saveCurrentProjectConfig 持久化的主要位置
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 现在从当前工作目录及其父目录检查
  // 规范化路径以进行一致的 JSON key 查找
  let currentPath = normalizePathForConfigKey(getCwd())

  // 遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 当到达根目录时停止（当父路径与当前路径相同时）
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录的信任（不是会话 cwd）。
 * 从 `dir` 向上遍历，如果任何祖先目录有持久化的信任则返回 true。
 * 与 checkHasTrustDialogAccepted 不同，此函数不查询会话信任或
 * 记忆化的项目路径 — 用于目标目录与 cwd 不同的情况（例如
 * /assistant 安装到用户输入的路径）。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// 我们必须把测试代码放在这里，因为 Jest 不支持模拟 ES 模块 :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测写入 `fresh` 是否会丢失内存缓存仍有的 auth/onboarding 状态。
 * 当 `getConfig` 在写入过程中遇到损坏或截断的文件时（来自另一个进程或非原子回退）
 * 会发生这种情况，并返回 DEFAULT_GLOBAL_CONFIG。将其写回会永久
 * 清除 auth。参见 GH #3117。
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // 如果没有变化则跳过（返回相同引用）
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // 如果没有变化则跳过（返回相同引用）
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // 仅在我们实际写入时才写透。如果 auth-loss 保护
    // 触发（或 updater 没有做更改），文件保持不变，
    // 缓存仍然有效 — 触碰它会破坏保护。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // 错误时回退到非锁定版本。此回退是一个竞态
    // 窗口：如果另一个进程正在写入（或文件被截断），
    // getConfig 返回默认值。拒绝将这些值写入好的缓存
    // 配置以避免清除 auth。参见 GH #3117。
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // 如果没有变化则跳过（返回相同引用）
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置缓存
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// 配置文件操作跟踪（遥测）
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// 会话级全局配置文件实际磁盘写入计数。
// 为 ant only 开发者诊断（参见 inc-4552）公开，以便异常写入
// 速率在损坏 ~/.claude.json 之前在 UI 中显现。
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// 注册清理以在会话结束时报告缓存统计
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * 将旧的 autoUpdaterStatus 迁移到新的 installMethod 和 autoUpdates 字段
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // 已迁移
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus 已从类型中移除，但可能存在于旧配置中
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // 从旧字段确定安装方法和自动更新偏好
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // 默认为启用，除非明确禁用

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // 禁用时，我们不知道安装方法
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // 这些意味着全局安装
      installMethod = 'global'
      break
    case undefined:
      // 没有旧状态，保留默认值
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * 从项目中移除 history 字段（已迁移到 history.jsonl）
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history 已从类型中移除，但可能存在于旧配置中
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile 轮询间隔，用于检测来自其他实例的写入（毫秒）
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile 在 libuv 线程池上轮询 stat，仅在我们 mtime
// 改变时调用我们 — 停滞的 stat 永远不会阻塞主线程。
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // 我们自己的写入也会触发此回调 — 写透的 Date.now()
      // 过度使得 cache.mtime > 文件 mtime，所以我们跳过重新读取。
      // Bun/Node 在文件不存在时也会以 curr.mtimeMs=0 触发
      // （初始回调或删除）— <= 也能处理这种情况。
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // 写透可能在我们在读取时推进了缓存；
          // 不要退回到 watchFile stat 的过时快照。
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// 写透：我们刚刚写入的就是新配置。cache.mtime 过度
// 了文件的真实 mtime（Date.now() 在写入后记录），所以
// 刷新观察器在下次 tick 时跳过重新读取我们自己的写入。
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读取。启动后，这始终命中 — 我们自己的
  // 写入通过写透进行，其他实例的写入被后台
  // 刷新观察器捕获（从不阻塞此路径）。
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // 慢速路径：启动加载。此处的同步 I/O 是可接受的，因为它
  // 正好运行一次，在任何 UI 渲染之前。在读取前先 stat 以便任何竞态
  // 自我纠正（旧 mtime + 新内容 → 观察器在下个 tick 重新读取）。
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // 文件不存在
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 如果出现任何问题，回退到非缓存行为
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/**
 * 返回 remoteControlAtStartup 的有效值。优先级：
 *   1. 用户明确配置的值（始终优先 — 尊重选择退出）
 *   2. CCR 自动连接默认值（ant only 构建，GrowthBook 门控）
 *   3. false（必须明确选择加入远程控制）
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // 写入配置文件前确保目录存在
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync 在 FsOperations 实现中已经是递归的
  fs.mkdirSync(dir)

  // 过滤掉任何与默认值匹配的值
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 以安全权限写入配置文件 - mode 仅适用于新文件
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * 如果执行了写入则返回 true；如果跳过了写入则返回 false
 *（无变化，或 auth-loss 保护触发）。调用方使用此值来决定
 * 是否使缓存失效 — 在跳过写入后使缓存失效
 * 会破坏 auth-loss 保护所依赖的良好缓存状态。
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（mkdirSync 在 FsOperations 中已经是递归的）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // 默认 onCompromised 从 setTimeout 回调中抛出，这
        // 会变成未处理的异常。改为记录 — 锁被
        // 偷走（例如 10s 事件循环停滞后）是可恢复的。
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // 检查过时写入 - 文件在我们上次读取后改变了
    // 仅检查全局配置文件，因为 lastReadFileStats 跟踪该特定文件
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // 文件尚不存在，不需要过时检查
      }
    }

    // 重新读取当前配置以获取最新状态。如果文件
    // 暂时损坏（并发写入、写入中杀死），这会
    // 返回默认值 — 我们不能将这些写回到好的配置上。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.claude.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // 应用合并函数以获取更新的配置
    const mergedConfig = mergeFn(currentConfig)

    // 如果没有变化则跳过写入（返回相同引用）
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉任何与默认值匹配的值
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 写入前创建现有配置的带时间戳备份
    // 我们保留多个备份以防止重置/损坏的配置
    // 覆盖好的备份时丢失数据。备份存储在 ~/.claude/backups/
    // 以保持主目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 首先检查现有备份 — 如果已存在最近的
      // 备份则跳过创建新的。在启动期间，许多 saveGlobalConfig 调用
      // 在毫秒级之间触发；如果没有此检查，每次调用
      // 都会创建一个在磁盘上积累的新备份文件。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最新的在前（时间戳按字典顺序排序）

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // 清理旧备份，仅保留最近的 5 个
      const MAX_BACKUPS = 5
      // 如果我们刚创建了一个则重新读取；否则重用列表
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter(f => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // 忽略清理错误
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // 没有要备份的文件或备份失败，继续写入
    }

    // 以安全权限写入配置文件 - mode 仅适用于新文件
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 跟踪是否允许读取配置的标志
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 确保此函数是幂等的
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 在此标志设置之前对配置的任何读取都会显示控制台警告，
  // 以防止我们在模块初始化期间添加配置读取
  configReadingAllowed = true
  // 我们仅检查全局配置，因为目前所有配置共享一个文件
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * 返回存储配置备份文件的目录。
 * 使用 ~/.claude/backups/ 以保持主目录整洁。
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

/**
 * 查找给定配置文件的最新备份文件。
 * 首先检查 ~/.claude/backups/，然后回退到遗留位置
 *（配置文件旁边）以保持向后兼容。
 * 返回最新备份的完整路径，如果没有则返回 null。
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 首先检查新的备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典顺序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  // 回退到遗留位置（配置文件旁边）
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典顺序排序
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // 检查遗留备份文件（无时间戳）
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // 遗留备份不存在
    }
  } catch {
    // 忽略读取目录的错误
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // 如果在允许之前访问配置则抛出错误
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 解析前去除 BOM - PowerShell 5.x 会向 UTF-8 文件添加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 抛出带文件路径和默认配置的 ConfigParseError
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件未找到 - 检查备份并返回默认值
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nClaude configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // 如果 throwOnInvalid 为 true 则重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误以便用户知道发生了什么
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // 保护：logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // 当配置文件损坏时会导致无限递归，因为
      // 采样检查从全局配置读取 GrowthBook 特性。
      // 仅在最外层调用时记录分析数据。
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // 记录错误以供监控
          logError(error)

          // 记录配置损坏的分析事件
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // 没有备份
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // 尝试备份损坏的配置文件（仅在尚未备份时）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏的内容是否与任何现有备份匹配
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // 忽略备份读取错误
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // 忽略备份错误
        }
      }

      // 通知用户配置文件损坏和可用备份
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// 用于获取配置查找项目路径的记忆化函数
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 规范化以获得一致的 JSON key（所有平台使用正斜杠）
    // 这确保像 C:\Users\... 和 C:/Users/... 这样的路径映射到相同的 key
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // 不确定这怎么变成了字符串
  // TODO: 修复上游
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 如果没有变化则跳过（返回相同引用）
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // 如果没有变化则跳过（返回相同引用）
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // 与 saveGlobalConfig 的回退相同的竞态窗口 — 拒绝将
    // 默认值写入好的缓存配置。参见 GH #3117。
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 如果没有变化则跳过（返回相同引用）
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * 如果应跳过插件自动更新则返回 true。
 * 这会检查自动更新器是否被禁用且 FORCE_AUTOUPDATE_PLUGINS
 * 环境变量未设置为 'true'。该环境变量允许强制插件自动更新，
 * 即当自动更新器被禁用时。
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  // 本项目默认关闭自动更新；通过 ENABLE_AUTOUPDATER=1 显式开启
  if (!isEnvTruthy(process.env.ENABLE_AUTOUPDATER)) {
    return { type: 'config' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem 仅在 feature('TEAMMEM') 为 true 时才是有效的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 在 TeamMem 不属于 MemoryType 的外部构建中不可达
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// 仅用于测试导出
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
