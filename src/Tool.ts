import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// 从集中位置导入权限类型以打破导入循环
// 从集中位置导入 PermissionResult 以打破导入循环
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// 从集中位置导入工具进度类型以打破导入循环
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// 为向后兼容而重新导出进度类型
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
	args: {
		jsx: React.ReactNode | null;
		shouldHidePromptInput: boolean;
		shouldContinueAnimation?: true;
		showSpinner?: boolean;
		isLocalJSXCommand?: boolean;
		isImmediate?: boolean;
		/** 设置为 true 以清除本地 JSX 命令（例如从其 onDone 回调中） */
		clearLocalJSX?: boolean;
	} | null,
) => void;

// 从集中位置导入工具权限类型以打破导入循环
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// 为向后兼容而重新导出
export type { ToolPermissionRulesBySource }

// 对导入的类型应用 DeepImmutable
export type ToolPermissionContext = DeepImmutable<{
	mode: PermissionMode;
	additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>;
	alwaysAllowRules: ToolPermissionRulesBySource;
	alwaysDenyRules: ToolPermissionRulesBySource;
	alwaysAskRules: ToolPermissionRulesBySource;
	isBypassPermissionsModeAvailable: boolean;
	isAutoModeAvailable?: boolean;
	strippedDangerousRules?: ToolPermissionRulesBySource;
	/** 当为 true 时，权限提示自动被拒绝（例如无法显示 UI 的后台代理） */
	shouldAvoidPermissionPrompts?: boolean;
	/** 当为 true 时，在显示权限对话框前等待自动化检查（分类器、钩子）完成（协调者工作线程） */
	awaitAutomatedChecksBeforeDialog?: boolean;
	/** 存储模型启动计划模式前的权限模式，以便退出时恢复 */
	prePlanMode?: PermissionMode;
}>;

export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export type ToolUseContext = {
	options: {
		commands: Command[];
		debug: boolean;
		mainLoopModel: string;
		tools: Tools;
		verbose: boolean;
		thinkingConfig: ThinkingConfig;
		mcpClients: MCPServerConnection[];
		mcpResources: Record<string, ServerResource[]>;
		isNonInteractiveSession: boolean;
		agentDefinitions: AgentDefinitionsResult;
		maxBudgetUsd?: number;
		/** 自定义系统提示，替换默认系统提示 */
		customSystemPrompt?: string;
		/** 在主系统提示后追加的附加系统提示 */
		appendSystemPrompt?: string;
		/** 覆盖 querySource 用于分析跟踪 */
		querySource?: QuerySource;
		/** 可选回调以获取最新工具（例如 MCP 服务器在查询中途连接后） */
		refreshTools?: () => Tools;
	};
	abortController: AbortController;
	readFileState: FileStateCache;
	getAppState(): AppState;
	setAppState(f: (prev: AppState) => AppState): void;
	/**
	 * 始终共享的 setAppState，用于会话范围的基础设施（后台
	 * 任务、会话钩子）。与 setAppState 不同，setAppState 对异步代理是空操作
	 *（参见 createSubagentContext），而这个总是到达根 store，以便任何嵌套深度的代理
	 * 都能注册/清理超出单个轮次生命周期的基础设施。仅由 createSubagentContext 设置；
	 * 主线程上下文回退到 setAppState。
	 */
	setAppStateForTasks?: (f: (prev: AppState) => AppState) => void;
	/**
	 * 可选的 URL 引发处理器，由工具调用错误（-32042）触发。
	 * 在 print/SDK 模式下，委托给 structuredIO.handleElicitation。
	 * 在 REPL 模式下，此为 undefined，使用基于队列的 UI 路径。
	 */
	handleElicitation?: (
		serverName: string,
		params: ElicitRequestURLParams,
		signal: AbortSignal,
	) => Promise<ElicitResult>;
	setToolJSX?: SetToolJSXFn;
	addNotification?: (notif: Notification) => void;
	/** 向 REPL 消息列表追加仅 UI 的系统消息。在
	 *  normalizeMessagesForAPI 边界处会被剥离——Exclude<> 使其类型强制。 */
	appendSystemMessage?: (
		msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
	) => void;
	/** 发送操作系统级通知（iTerm2、Kitty、Ghostty、bell 等） */
	sendOSNotification?: (opts: {
		message: string;
		notificationType: string;
	}) => void;
	nestedMemoryAttachmentTriggers?: Set<string>;
	/**
	 * 本会话已作为嵌套 memory 附件注入的 CLAUDE.md 路径。用于 memoryFilesToAttachments 去重
	 * ——readFileState 是一个 LRU 缓存，在繁忙会话中会驱逐条目，因此单独的 .has() 检查可能会
	 * 多次注入同一个 CLAUDE.md。
	 */
	loadedNestedMemoryPaths?: Set<string>;
	dynamicSkillDirTriggers?: Set<string>;
	/** 通过 skill_discovery 本会话发现的 Skill 名称。仅用于遥测（ feeds was_discovered）。 */
	discoveredSkillNames?: Set<string>;
	userModified?: boolean;
	setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void;
	/** 仅在交互式（REPL）上下文中连接；SDK/QueryEngine 不设置此项。 */
	setHasInterruptibleToolInProgress?: (v: boolean) => void;
	setResponseLength: (f: (prev: number) => number) => void;
	/** Ant 专用：推送新的 API 指标条目用于 OTPS 跟踪。
	 *  当新的 API 请求启动时由子代理流式调用。 */
	pushApiMetricsEntry?: (ttftMs: number) => void;
	setStreamMode?: (mode: SpinnerMode) => void;
	onCompactProgress?: (event: CompactProgressEvent) => void;
	setSDKStatus?: (status: SDKStatus) => void;
	openMessageSelector?: () => void;
	updateFileHistoryState: (
		updater: (prev: FileHistoryState) => FileHistoryState,
	) => void;
	updateAttributionState: (
		updater: (prev: AttributionState) => AttributionState,
	) => void;
	setConversationId?: (id: UUID) => void;
	agentId?: AgentId; // 仅对子代理设置；使用 getSessionId() 获取会话 ID。钩子使用此字段区分子代理调用。
	agentType?: string; // 子代理类型名称。对于主线程的 --agent 类型，钩子回退到 getMainThreadAgentType()。
	/** 当为 true 时，即使钩子自动批准，也必须始终调用 canUseTool。
	 * 用于覆盖文件路径重写的 speculation。 */
	requireCanUseTool?: boolean;
	messages: Message[];
	fileReadingLimits?: {
		maxTokens?: number;
		maxSizeBytes?: number;
	};
	globLimits?: {
		maxResults?: number;
	};
	toolDecisions?: Map<
		string,
		{
			source: string;
			decision: "accept" | "reject";
			timestamp: number;
		}
	>;
	queryTracking?: QueryChainTracking;
	/** 回调工厂，用于向用户请求交互式提示。
	 * 返回绑定到给定源名称的提示回调。
	 * 仅在交互式（REPL）上下文中可用。 */
	requestPrompt?: (
		sourceName: string,
		toolInputSummary?: string | null,
	) => (request: PromptRequest) => Promise<PromptResponse>;
	toolUseId?: string;
	criticalSystemReminder_EXPERIMENTAL?: string;
	/** 当为 true 时，即使对子代理也保留 messages 上的 toolUseResult。
	 *  用于其转录可被用户查看的进程内队友。 */
	preserveToolUseResults?: boolean;
	/** 异步子代理的本地拒绝跟踪状态，其 setAppState 是空操作。
	 *  没有这个，拒绝计数器永远不会累加，
	 *  回退到提示的阈值永远达不到。可变——
	 *  权限代码原地更新它。 */
	localDenialTracking?: DenialTrackingState;
	/**
	 * 每个对话线程的内容替换状态，用于工具结果预算。
	 * 存在时，query.ts 应用聚合的工具结果预算。
	 * 主线程：REPL 提供一次（永不重置——过时的 UUID 键是惰性的）。
	 * 子代理：默认情况下 createSubagentContext 克隆父级的状态
	 *（缓存共享 fork 需要相同的决策），或者
	 * resumeAgentBackground 线程从 sidechain 记录重建一个。
	 */
	contentReplacementState?: ContentReplacementState;
	/**
	 * 父级渲染的系统提示字节数，在轮次开始时冻结。
	 * 供 fork 子代理共享父级的提示缓存使用——在 fork 生成时重新调用
	 * getSystemPrompt() 可能会产生分歧（GrowthBook cold→warm）
	 * 并破坏缓存。参见 forkSubagent.ts。
	 */
	renderedSystemPrompt?: SystemPrompt;
};

/** 从集中位置重新导出 ToolProgressData */
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      (msg.data as { type?: string })?.type !== 'hook_progress',
  )
}

export type ToolResult<T> = {
	data: T;
	newMessages?: (
		| UserMessage
		| AssistantMessage
		| AttachmentMessage
		| SystemMessage
	)[];
	/** 传递给 SDK 使用者的 MCP 协议元数据（structuredContent、_meta） */
	mcpMeta?: {
		_meta?: Record<string, unknown>;
		structuredContent?: Record<string, unknown>;
	};
};

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// 任何输出具有字符串键的对象的类型
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * 检查工具是否匹配给定名称（主名称或别名）。
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * 从工具列表中按名称或别名查找工具。
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
	Input extends AnyObject = AnyObject,
	Output = unknown,
	P extends ToolProgressData = ToolProgressData,
> = {
	/**
	 * 可选的别名，用于工具重命名时的向后兼容。
	 * 除了主名称外，还可以通过这些名称中的任何一个来查找该工具。
	 */
	aliases?: string[];
	/**
	 * ToolSearch 用于关键字匹配的一行能力短语。
	 * 帮助模型在延迟时通过关键字搜索找到此工具。
	 * 3-10 个词，尾部无句点。
	 * 优先使用工具名称中尚不存在的术语（例如 NotebookEdit 用 'jupyter'）。
	 */
	searchHint?: string;
	call(
		args: z.infer<Input>,
		context: ToolUseContext,
		canUseTool: CanUseToolFn,
		parentMessage: AssistantMessage,
		onProgress?: ToolCallProgress<P>,
	): Promise<ToolResult<Output>>;
	description(
		input: z.infer<Input>,
		options: {
			isNonInteractiveSession: boolean;
			toolPermissionContext: ToolPermissionContext;
			tools: Tools;
		},
	): Promise<string>;
	readonly inputSchema: Input;
	// MCP 工具的类型，可以直接以 JSON Schema 格式指定其输入 schema
	// 而不是从 Zod schema 转换
	readonly inputJSONSchema?: ToolInputJSONSchema;
	// 可选，因为 TungstenTool 没有定义这个。TODO：使其成为必需。
	// 当我们这样做时，也可以使这更加类型安全。
	outputSchema?: z.ZodType<unknown>;
	inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean;
	isConcurrencySafe(input: z.infer<Input>): boolean;
	isEnabled(): boolean;
	isReadOnly(input: z.infer<Input>): boolean;
	/** 默认为 false。仅在工具执行不可逆操作（删除、覆盖、发送）时设置。 */
	isDestructive?(input: z.infer<Input>): boolean;
	/**
	 * 当用户在此工具运行时提交新消息时会发生什么。
	 *
	 * - `'cancel'` — 停止工具并丢弃其结果
	 * - `'block'`  — 继续运行；新消息等待
	 *
	 * 未实现时默认为 `'block'`。
	 */
	interruptBehavior?(): "cancel" | "block";
	/**
	 * 返回有关此工具调用是否为应折叠到 UI 中精简显示的搜索或读取操作的信息。
	 * 示例包括文件搜索（Grep、Glob）、文件读取（Read）以及 find、
	 * grep、wc 等 bash 命令。
	 *
	 * 返回一个指示操作类型的对象：
	 * - `isSearch: true` 表示搜索操作（grep、find、glob 模式）
	 * - `isRead: true` 表示读取操作（cat、head、tail、文件读取）
	 * - `isList: true` 表示目录列表操作（ls、tree、du）
	 * - 如果操作不应折叠，全部可以为 false
	 */
	isSearchOrReadCommand?(input: z.infer<Input>): {
		isSearch: boolean;
		isRead: boolean;
		isList?: boolean;
	};
	isOpenWorld?(input: z.infer<Input>): boolean;
	requiresUserInteraction?(): boolean;
	isMcp?: boolean;
	isLsp?: boolean;
	/**
	 * 当为 true 时，此工具被延迟发送（带 defer_loading: true），
	 * 需要先使用 ToolSearch 才能调用。
	 */
	readonly shouldDefer?: boolean;
	/**
	 * 当为 true 时，此工具永远不会被延迟——即使启用了 ToolSearch，
	 * 其完整 schema 也会出现在初始提示中。对于 MCP 工具，通过
	 * `_meta['anthropic/alwaysLoad']` 设置。用于模型必须在
	 * 第 1 轮就能看到而无需 ToolSearch 往返的工具。
	 */
	readonly alwaysLoad?: boolean;
	/**
	 * 对于 MCP 工具：从 MCP 服务器接收的服务器和工具名称（未规范化）。
	 * 存在于所有 MCP 工具上，无论 `name` 是前缀形式（mcp__server__tool）
	 * 还是无前缀形式（CLAUDE_AGENT_SDK_MCP_NO_PREFIX 模式）。
	 */
	mcpInfo?: { serverName: string; toolName: string };
	readonly name: string;
	/**
	 * 工具结果在保存到磁盘前的最大字符大小。
	 * 超过时，结果保存到文件，Claude 收到包含文件路径的预览而非完整内容。
	 *
	 * 对于输出永远不应被持久化的工具设置为 Infinity（例如 Read，
	 * 持久化会创建 Read→file→Read 的循环，且该工具
	 * 已通过自己的限制进行了自我约束）。
	 */
	maxResultSizeChars: number;
	/** 当为 true 时，为此工具启用严格模式，导致 API 更严格地
	 * 遵守工具指令和参数 schema。
	 * 仅在启用 tengu_tool_pear 时应用。 */
	readonly strict?: boolean;

	/**
	 * 在观察者看到工具输入之前（SDK 流、
	 * 转录、canUseTool、PreToolUse/PostToolUse 钩子），对 tool_use 输入副本调用。
	 * 就地变更以添加遗留/派生字段。必须是幂等的。
	 * 原始 API 绑定的输入永远不会被变更（保留提示缓存）。
	 * 当钩子/权限返回新鲜的 updatedInput 时不会重新应用——那些有自己的形状。
	 */
	backfillObservableInput?(input: Record<string, unknown>): void;

	/**
	 * 确定在当前上下文中是否允许使用此工具及给定输入。
	 * 它告知模型工具使用失败的原因，并不直接显示任何 UI。
	 * @param input 工具输入
	 * @param context 工具使用上下文
	 */
	validateInput?(
		input: z.infer<Input>,
		context: ToolUseContext,
	): Promise<ValidationResult>;

	/**
	 * 确定是否询问用户权限。仅在 validateInput() 通过后调用。
	 * 通用权限逻辑在 permissions.ts 中。此方法包含工具特定的逻辑。
	 * @param input 工具输入
	 * @param context 工具使用上下文
	 */
	checkPermissions(
		input: z.infer<Input>,
		context: ToolUseContext,
	): Promise<PermissionResult>;

	/** 操作文件路径的工具的可选方法 */
	getPath?(input: z.infer<Input>): string;

	/**
	 * 为钩子 `if` 条件（权限规则模式，如
	 * "git *" 来自 "Bash(git *)"）准备匹配器。在此调用一次每对钩子输入；
	 * 任何昂贵的解析都在这里发生。返回一个闭包，每
	 * 个钩子模式调用一次。如果未实现，仅支持工具名称级别匹配。
	 */
	preparePermissionMatcher?(
		input: z.infer<Input>,
	): Promise<(pattern: string) => boolean>;

	prompt(options: {
		getToolPermissionContext: () => Promise<ToolPermissionContext>;
		tools: Tools;
		agents: AgentDefinition[];
		allowedAgentTypes?: string[];
	}): Promise<string>;
	userFacingName(input: Partial<z.infer<Input>> | undefined): string;
	userFacingNameBackgroundColor?(
		input: Partial<z.infer<Input>> | undefined,
	): keyof Theme | undefined;
	/**
	 * 透明包装器（例如 REPL）将所有渲染委托给其进度
	 * 处理器，进度处理器为每个内部工具调用发出原生外观的块。
	 * 包装器本身不显示任何内容。
	 */
	isTransparentWrapper?(): boolean;
	/**
	 * 返回此工具调用的简短字符串摘要，用于精简视图显示。
	 * @param input 工具输入
	 * @returns 简短字符串摘要，或 null 以不显示
	 */
	getToolUseSummary?(
		input: Partial<z.infer<Input>> | undefined,
	): string | null;
	/**
	 * 返回此工具的人类可读的现在时活动描述，用于旋转器显示。
	 * 示例："Reading src/foo.ts"、"Running bun test"、"Searching for pattern"
	 * @param input 工具输入
	 * @returns 活动描述字符串，或 null 以回退到工具名称
	 */
	getActivityDescription?(
		input: Partial<z.infer<Input>> | undefined,
	): string | null;
	/**
	 * 返回此工具调用的精简表示，用于自动模式
	 * 安全分类器。示例：`ls -la` 表示 Bash、`/tmp/x: new content`
	 * 表示 Edit。返回 '' 以在分类器转录中跳过此工具
	 *（例如与安全无关的工具）。可以返回对象以避免
	 * 调用者 JSON 包装值时的双重编码。
	 */
	toAutoClassifierInput(input: z.infer<Input>): unknown;
	mapToolResultToToolResultBlockParam(
		content: Output,
		toolUseID: string,
	): ToolResultBlockParam;
	/**
	 * 可选。省略时，工具结果不渲染任何内容（与返回
	 * null 相同）。为在转录（而非其他地方）显示结果的工具省略
	 *（例如 TodoWrite 更新 todo 面板，而非转录）。
	 */
	renderToolResultMessage?(
		content: Output,
		progressMessagesForMessage: ProgressMessage<P>[],
		options: {
			style?: "condensed";
			theme: ThemeName;
			tools: Tools;
			verbose: boolean;
			isTranscriptMode?: boolean;
			isBriefOnly?: boolean;
			/** 原始 tool_use 输入（如果有）。用于引用所请求内容的精简结果摘要
			 * （例如 "Sent to #foo"）。 */
			input?: unknown;
		},
	): React.ReactNode;
	/**
	 * renderToolResultMessage 在转录
	 * 模式下（verbose=true, isTranscriptMode=true）显示的扁平化文本。
	 * 用于转录搜索索引：索引计算此字符串中的出现次数，高亮
	 * 覆盖扫描实际屏幕缓冲区。为了计数≡高亮，
	 * 这里必须返回最终可见的文本——而不是 mapToolResultToToolResultBlockParam
	 * 的模型面序列化（它添加了 system-reminders、persisted-output 包装器）。
	 *
	 * Chrome 可以跳过（计数不足是可以的）。"Found 3 files in 12ms"
	 * 不值得索引。幻影是不行的——这里声称但未渲染的文本是计数≠高亮的 bug。
	 *
	 * 可选：省略 → transcriptSearch.ts 中的字段名启发式。
	 * 通过 test/utils/transcriptSearch.renderFidelity.test.tsx 检测漂移，
	 * 它渲染示例输出并标记已索引但未渲染（幻影）或
	 * 已渲染但未索引（计数不足警告）的文本。
	 */
	extractSearchText?(out: Output): string;
	/**
	 * 渲染工具调用消息。注意 `input` 是部分的，因为我们会尽快渲染
	 * 消息，可能在工具参数完全流入之前。
	 */
	renderToolUseMessage(
		input: Partial<z.infer<Input>>,
		options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
	): React.ReactNode;
	/**
	 * 当此输出的非verbose渲染被截断时返回 true
	 *（即单击展开会显示更多内容）。
	 * 在全屏中控制单击展开——只有 verbose 实际
	 * 显示更多的消息才能获得悬停/点击功能。未设置意味着永不截断。
	 */
	isResultTruncated?(output: Output): boolean;
	/**
	 * 渲染在工具调用消息后显示的可选标签。
	 * 用于显示超时、模型、恢复 ID 等额外元数据。
	 * 返回 null 以不显示任何内容。
	 */
	renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode;
	/**
	 * 可选。省略时不显示工具运行时的进度 UI。
	 */
	renderToolUseProgressMessage?(
		progressMessagesForMessage: ProgressMessage<P>[],
		options: {
			tools: Tools;
			verbose: boolean;
			terminalSize?: { columns: number; rows: number };
			inProgressToolCallCount?: number;
			isTranscriptMode?: boolean;
		},
	): React.ReactNode;
	renderToolUseQueuedMessage?(): React.ReactNode;
	/**
	 * 可选。省略时回退到 <FallbackToolUseRejectedMessage />。
	 * 仅为其需要自定义拒绝 UI 的工具定义（例如显示
	 * 被拒绝的差异的文件编辑）。
	 */
	renderToolUseRejectedMessage?(
		input: z.infer<Input>,
		options: {
			columns: number;
			messages: Message[];
			style?: "condensed";
			theme: ThemeName;
			tools: Tools;
			verbose: boolean;
			progressMessagesForMessage: ProgressMessage<P>[];
			isTranscriptMode?: boolean;
		},
	): React.ReactNode;
	/**
	 * 可选。省略时回退到 <FallbackToolUseErrorMessage />。
	 * 仅为其需要自定义错误 UI 的工具定义（例如搜索工具
	 * 显示"File not found"而非原始错误）。
	 */
	renderToolUseErrorMessage?(
		result: ToolResultBlockParam["content"],
		options: {
			progressMessagesForMessage: ProgressMessage<P>[];
			tools: Tools;
			verbose: boolean;
			isTranscriptMode?: boolean;
		},
	): React.ReactNode;

	/**
	 * 将此工具的多个并行实例渲染为一个组。
	 * @returns 要渲染的 React 节点，或 null 以回退到单独渲染
	 */
	/**
	 * 将多个工具调用渲染为一个组（仅非Verbose模式）。
	 * 在Verbose模式下，单独的工具调用在其原始位置渲染。
	 * @returns 要渲染的 React 节点，或 null 以回退到单独渲染
	 */
	renderGroupedToolUse?(
		toolUses: Array<{
			param: ToolUseBlockParam;
			isResolved: boolean;
			isError: boolean;
			isInProgress: boolean;
			progressMessages: ProgressMessage<P>[];
			result?: {
				param: ToolResultBlockParam;
				output: unknown;
			};
		}>,
		options: {
			shouldAnimate: boolean;
			tools: Tools;
		},
	): React.ReactNode | null;
};

/**
 * 工具集合。使用此类型而不是 `Tool[]`，以便更容易
 * 跟踪工具集在整个代码库中的组装、传递和过滤。
 */
export type Tools = readonly Tool[]

/**
 * `buildTool` 提供默认实现的方法。`ToolDef` 可以省略这些；
 * 生成的 `Tool` 始终具有这些方法。
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * `buildTool` 接受的工具定义。与 `Tool` 形状相同，但
 * 默认方法可选——`buildTool` 会填充它们，这样调用者始终
 * 看到完整的 `Tool`。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 类型级展开，镜像 `{ ...TOOL_DEFAULTS, ...def }`。对于每个
 * 可默认的键：如果 D 提供了它（必需），D 的类型胜出；如果 D 省略了
 * 它或它是可选的（从 Constraint 中的 Partial<> 继承），则填充默认值。
 * 所有其他键完全按照 `satisfies Tool` 的方式从 D 原样保留——保持arity、
 * 可选存在和字面量类型完全相同。
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从部分定义构建完整的 `Tool`，为常用存根方法填充安全默认值。
 * 所有工具导出都应通过此方法，以便默认值位于一个地方，
 * 调用者永远不需要 `?.() ?? default`。
 *
 * 默认值（在重要的地方失败关闭）：
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false`（假设不安全）
 * - `isReadOnly` → `false`（假设写入）
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }`（遵循通用权限系统）
 * - `toAutoClassifierInput` → `''`（跳过分类器——安全相关工具必须覆盖）
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// TOOL_DEFAULTS 的实际类型（可选参数使 0 参数和全参数调用站都类型检查——
// 存根在 arity 上有所不同，测试依赖于这一点），
// 而不是接口的严格签名。
type ToolDefaults = typeof TOOL_DEFAULTS

// D 从调用站点推断具体的对象字面量类型。
// 约束为方法参数提供上下文类型；约束中的 `any`
// 是结构性的，永远不会泄漏到返回类型。
// BuiltTool<D> 在类型级别镜像运行时 {...TOOL_DEFAULTS, ...def}。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
	// 运行时展开是直接的；`as` 桥接结构化 any 约束
	// 和精确的 BuiltTool<D> 返回类型之间的差距。
	// 类型语义通过所有 60+ 工具的 0 错误类型检查得到证明。
	return {
		...TOOL_DEFAULTS,
		userFacingName: () => def.name,
		...def,
	} as BuiltTool<D>;
}
