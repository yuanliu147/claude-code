/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

export async function setup(
	cwd: string,
	permissionMode: PermissionMode,
	allowDangerouslySkipPermissions: boolean,
	worktreeEnabled: boolean,
	worktreeName: string | undefined,
	tmuxEnabled: boolean,
	customSessionId?: string | null,
	worktreePRNumber?: number,
	messagingSocketPath?: string,
): Promise<void> {
	logForDiagnosticsNoPII("info", "setup_started");

	// 检查 Node.js 版本是否 < 18
	const nodeVersion = process.version.match(/^v(\d+)\./)?.[1];
	if (!nodeVersion || parseInt(nodeVersion) < 18) {
		// biome-ignore lint/suspicious/noConsole:: intentional console output
		console.error(
			chalk.bold.red(
				"Error: Claude Code requires Node.js version 18 or higher.",
			),
		);
		process.exit(1);
	}

	// 如果提供了自定义会话 ID，则设置它
	if (customSessionId) {
		switchSession(asSessionId(customSessionId));
	}

	// --bare / SIMPLE: 跳过 UDS 消息服务器和队友快照。
	// 脚本调用不接收注入消息，也不使用蜂群队友。
	// 显式 --messaging-socket-path 是逃生舱（按 #23222 门控模式）。
	if (!isBareMode() || messagingSocketPath !== undefined) {
		// 启动 UDS 消息服务器（仅 Mac/Linux）。
		// 默认启用——如果未传递 --messaging-socket-path，则在 tmpdir 中创建 socket。
		// 等待以便服务器绑定并在任何钩子（尤其是 SessionStart）
		// 可以生成并快照 process.env 之前导出 $CLAUDE_CODE_MESSAGING_SOCKET。
		if (feature("UDS_INBOX")) {
			const m = await import("./utils/udsMessaging.js");
			await m.startUdsMessaging(
				messagingSocketPath ?? m.getDefaultUdsSocketPath(),
				{ isExplicit: messagingSocketPath !== undefined },
			);
		}
	}

	// 队友快照 - 仅 SIMPLE 门控（没有逃生舱，蜂群在 bare 中不使用）
	if (!isBareMode() && isAgentSwarmsEnabled()) {
		const { captureTeammateModeSnapshot } =
			await import("./utils/swarm/backends/teammateModeSnapshot.js");
		captureTeammateModeSnapshot();
	}

	// Terminal backup restoration — interactive only. Print mode doesn't
	// interact with terminal settings; the next interactive session will
	// detect and restore any interrupted setup.
	if (!getIsNonInteractiveSession()) {
		// iTerm2 backup check only when swarms enabled
		if (isAgentSwarmsEnabled()) {
			const restoredIterm2Backup = await checkAndRestoreITerm2Backup();
			if (restoredIterm2Backup.status === "restored") {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.log(
					chalk.yellow(
						"Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.",
					),
				);
			} else if (restoredIterm2Backup.status === "failed") {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.error(
					chalk.red(
						`Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
					),
				);
			}
		}

		// 检查并恢复 Terminal.app 备份（如果设置被中断）
		try {
			const restoredTerminalBackup =
				await checkAndRestoreTerminalBackup();
			if (restoredTerminalBackup.status === "restored") {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.log(
					chalk.yellow(
						"Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.",
					),
				);
			} else if (restoredTerminalBackup.status === "failed") {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.error(
					chalk.red(
						`Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
					),
				);
			}
		} catch (error) {
			// 记录但如果 Terminal.app 备份恢复失败不要崩溃
			logError(error);
		}
	}

	// 重要：setCwd() 必须在任何依赖 cwd 的其他代码之前调用
	setCwd(cwd);

	// 捕获钩子配置快照以避免隐藏的钩子修改。
	// 重要：必须在 setCwd() 之后调用，以便从正确目录加载钩子
	const hooksStart = Date.now();
	captureHooksConfigSnapshot();
	logForDiagnosticsNoPII("info", "setup_hooks_captured", {
		duration_ms: Date.now() - hooksStart,
	});

	// Initialize FileChanged hook watcher — sync, reads hook config snapshot
	initializeFileChangedWatcher(cwd);

	// Handle worktree creation if requested
	// IMPORTANT: this must be called befiore getCommands(), otherwise /eject won't be available.
	if (worktreeEnabled) {
		// Mirrors bridgeMain.ts: hook-configured sessions can proceed without git
		// so createWorktreeForSession() can delegate to the hook (non-git VCS).
		const hasHook = hasWorktreeCreateHook();
		const inGit = await getIsGit();
		if (!hasHook && !inGit) {
			process.stderr.write(
				chalk.red(
					`Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
						`Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
				),
			);
			process.exit(1);
		}

		const slug = worktreePRNumber
			? `pr-${worktreePRNumber}`
			: (worktreeName ?? getPlanSlug());

		// Git preamble runs whenever we're in a git repo — even if a hook is
		// configured — so --tmux keeps working for git users who also have a
		// WorktreeCreate hook. Only hook-only (non-git) mode skips it.
		let tmuxSessionName: string | undefined;
		if (inGit) {
			// Resolve to main repo root (handles being invoked from within a worktree).
			// findCanonicalGitRoot is sync/filesystem-only/memoized; the underlying
			// findGitRoot cache was already warmed by getIsGit() above, so this is ~free.
			const mainRepoRoot = findCanonicalGitRoot(getCwd());
			if (!mainRepoRoot) {
				process.stderr.write(
					chalk.red(
						`Error: Could not determine the main git repository root.\n`,
					),
				);
				process.exit(1);
			}

			// If we're inside a worktree, switch to the main repo for worktree creation
			if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
				logForDiagnosticsNoPII(
					"info",
					"worktree_resolved_to_main_repo",
				);
				process.chdir(mainRepoRoot);
				setCwd(mainRepoRoot);
			}

			tmuxSessionName = tmuxEnabled
				? generateTmuxSessionName(
						mainRepoRoot,
						worktreeBranchName(slug),
					)
				: undefined;
		} else {
			// Non-git hook mode: no canonical root to resolve, so name the tmux
			// session from cwd — generateTmuxSessionName only basenames the path.
			tmuxSessionName = tmuxEnabled
				? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
				: undefined;
		}

		let worktreeSession: Awaited<
			ReturnType<typeof createWorktreeForSession>
		>;
		try {
			worktreeSession = await createWorktreeForSession(
				getSessionId(),
				slug,
				tmuxSessionName,
				worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
			);
		} catch (error) {
			process.stderr.write(
				chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
			);
			process.exit(1);
		}

		logEvent("tengu_worktree_created", { tmux_enabled: tmuxEnabled });

		// Create tmux session for the worktree if enabled
		if (tmuxEnabled && tmuxSessionName) {
			const tmuxResult = await createTmuxSessionForWorktree(
				tmuxSessionName,
				worktreeSession.worktreePath,
			);
			if (tmuxResult.created) {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.log(
					chalk.green(
						`Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
					),
				);
			} else {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.error(
					chalk.yellow(
						`Warning: Failed to create tmux session: ${tmuxResult.error}`,
					),
				);
			}
		}

		process.chdir(worktreeSession.worktreePath);
		setCwd(worktreeSession.worktreePath);
		setOriginalCwd(getCwd());
		// --worktree means the worktree IS the session's project, so skills/hooks/
		// cron/etc. should resolve here. (EnterWorktreeTool mid-session does NOT
		// touch projectRoot — that's a throwaway worktree, project stays stable.)
		setProjectRoot(getCwd());
		saveWorktreeState(worktreeSession);
		// 清除内存文件缓存（因为 originalCwd 已更改）
		clearMemoryFileCaches();
		// 设置缓存已在 init() 中填充（通过 applySafeConfigEnvironmentVariables）
		// 并在上面 captureHooksConfigSnapshot() 时再次填充，都从原始目录的
		// .claude/settings.json 读取。从 worktree 重新读取并重新捕获钩子。
		updateHooksConfigSnapshot();
	}

	// 后台作业 - 必须在第一次查询之前发生的关键注册
	logForDiagnosticsNoPII("info", "setup_background_jobs_starting");
	// 捆绑的 skills/plugins 在 main.tsx 中并行 kick getCommands() 之前注册——
	// 参见那里的注释。从 setup() 中移出，因为
	// 上面的 await 点（startUdsMessaging，~20ms）意味着 getCommands()
	// 竞争前移并记忆化了一个空的 bundledSkills 列表。
	if (!isBareMode()) {
		initSessionMemory(); // Synchronous - registers hook, gate check happens lazily
		if (feature("CONTEXT_COLLAPSE")) {
			/* eslint-disable @typescript-eslint/no-require-imports */
			(
				require("./services/contextCollapse/index.js") as typeof import("./services/contextCollapse/index.js")
			).initContextCollapse();
			/* eslint-enable @typescript-eslint/no-require-imports */
		}
	}
	void lockCurrentVersion(); // Lock current version to prevent deletion by other processes
	logForDiagnosticsNoPII("info", "setup_background_jobs_launched");

	profileCheckpoint("setup_before_prefetch");
	// Pre-fetch promises - only items needed before render
	logForDiagnosticsNoPII("info", "setup_prefetch_starting");
	// When CLAUDE_CODE_SYNC_PLUGIN_INSTALL is set, skip all plugin prefetch.
	// The sync install path in print.ts calls refreshPluginState() after
	// installing, which reloads commands, hooks, and agents. Prefetching here
	// races with the install (concurrent copyPluginToVersionedCache / cachePlugin
	// on the same directories), and the hot-reload handler fires clearPluginCache()
	// mid-install when policySettings arrives.
	const skipPluginPrefetch =
		(getIsNonInteractiveSession() &&
			isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
		// --bare: loadPluginHooks → loadAllPlugins 是文件系统工作，在
		// --bare 下 executeHooks early-return 时是浪费的。
		isBareMode();
	if (!skipPluginPrefetch) {
		void getCommands(getProjectRoot());
	}
	void import("./utils/plugins/loadPluginHooks.js").then((m) => {
		if (!skipPluginPrefetch) {
			void m.loadPluginHooks(); // Pre-load plugin hooks (consumed by processSessionStartHooks before render)
			m.setupPluginHookHotReload(); // Set up hot reload for plugin hooks when settings change
		}
	});
	// --bare: skip attribution hook install + repo classification +
	// session-file-access analytics + team memory watcher. These are background
	// bookkeeping for commit attribution + usage metrics — scripted calls don't
	// commit code, and the 49ms attribution hook stat check (measured) is pure
	// overhead. NOT an early-return: the --dangerously-skip-permissions safety
	// gate, tengu_started beacon, and apiKeyHelper prefetch below must still run.
	if (!isBareMode()) {
		if (process.env.USER_TYPE === "ant") {
			// Prime repo classification cache for auto-undercover mode. Default is
			// undercover ON until proven internal; if this resolves to internal, clear
			// the prompt cache so the next turn picks up the OFF state.
			void import("./utils/commitAttribution.js").then(async (m) => {
				if (await m.isInternalModelRepo()) {
					const { clearSystemPromptSections } =
						await import("./constants/systemPromptSections.js");
					clearSystemPromptSections();
				}
			});
		}
		if (feature("COMMIT_ATTRIBUTION")) {
			// Dynamic import to enable dead code elimination (module contains excluded strings).
			// Defer to next tick so the git subprocess spawn runs after first render
			// rather than during the setup() microtask window.
			setImmediate(() => {
				void import("./utils/attributionHooks.js").then(
					({ registerAttributionHooks }) => {
						registerAttributionHooks(); // 注册归属跟踪钩子（仅 ant 功能）
					},
				);
			});
		}
		void import("./utils/sessionFileAccessHooks.js").then((m) =>
			m.registerSessionFileAccessHooks(),
		); // 注册会话文件访问分析钩子
		if (feature("TEAMMEM")) {
			void import("./services/teamMemorySync/watcher.js").then((m) =>
				m.startTeamMemoryWatcher(),
			); // 启动团队记忆同步监视器
		}
	}
	initSinks(); // 附加错误日志 + 分析接收器并排空排队的事件

	// 会话成功率分母。在分析接收器附加后立即发出——
	// 在任何可能导致抛出的解析、获取或 I/O 之前。
	// inc-3694 (P0 CHANGELOG crash) 在下面的 checkForReleaseNotes 抛出；
	// 这之后的每个事件都是死事件。这个信标是发布健康监控的
	// 最早可靠的"进程启动"信号。
	logEvent("tengu_started", {});

	void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()); // 安全预取 - 仅在信任已确认时执行
	profileCheckpoint("setup_after_prefetch");

	// 预取 Logo v2 数据 - 等待以确保在 logo 渲染前准备就绪。
	// --bare / SIMPLE: 跳过——发布说明是交互式 UI 显示数据，
	// 且 getRecentActivity() 读取最多 10 个会话 JSONL 文件。
	if (!isBareMode()) {
		const { hasReleaseNotes } = await checkForReleaseNotes(
			getGlobalConfig().lastReleaseNotesSeen,
		);
		if (hasReleaseNotes) {
			await getRecentActivity();
		}
	}

	// 如果权限模式设置为绕过，验证我们在安全环境中
	if (
		permissionMode === "bypassPermissions" ||
		allowDangerouslySkipPermissions
	) {
		// 检查是否以 root/sudo 身份运行（在类 Unix 系统上）
		// 如果在沙箱中则允许 root（例如需要 root 的 TPU devspaces）
		if (
			process.platform !== "win32" &&
			typeof process.getuid === "function" &&
			process.getuid() === 0 &&
			process.env.IS_SANDBOX !== "1" &&
			!isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
		) {
			// biome-ignore lint/suspicious/noConsole:: intentional console output
			console.error(
				`--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
			);
			process.exit(1);
		}

		if (
			process.env.USER_TYPE === "ant" &&
			// 跳过 Desktop 的本地代理模式——与 CCR/BYOC 相同的信任模型
			//（受信任的 Anthropic 管理的启动器有意地预先批准一切）。
			// 先例：permissionSetup.ts:861, applySettingsChange.ts:55 (PR #19116)
			process.env.CLAUDE_CODE_ENTRYPOINT !== "local-agent" &&
			// CCD（桌面中的 Claude Code）也是如此——apps#29127 无条件传递标志
			// 以解锁会话中期绕过切换
			process.env.CLAUDE_CODE_ENTRYPOINT !== "claude-desktop"
		) {
			// 仅在权限模式设置为绕过时等待
			const [isDocker, hasInternet] = await Promise.all([
				envDynamic.getIsDocker(),
				env.hasInternetAccess(),
			]);
			const isBubblewrap = envDynamic.getIsBubblewrapSandbox();
			const isSandbox = process.env.IS_SANDBOX === "1";
			const isSandboxed = isDocker || isBubblewrap || isSandbox;
			if (!isSandboxed || hasInternet) {
				// biome-ignore lint/suspicious/noConsole:: intentional console output
				console.error(
					`--dangerously-skip-permissions can only be used in Docker/sandbox containers with no internet access but got Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
				);
				process.exit(1);
			}
		}
	}

	if (process.env.NODE_ENV === "test") {
		return;
	}

	// Log tengu_exit event from the last session?
	const projectConfig = getCurrentProjectConfig();
	if (
		projectConfig.lastCost !== undefined &&
		projectConfig.lastDuration !== undefined
	) {
		logEvent("tengu_exit", {
			last_session_cost: projectConfig.lastCost,
			last_session_api_duration: projectConfig.lastAPIDuration,
			last_session_tool_duration: projectConfig.lastToolDuration,
			last_session_duration: projectConfig.lastDuration,
			last_session_lines_added: projectConfig.lastLinesAdded,
			last_session_lines_removed: projectConfig.lastLinesRemoved,
			last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
			last_session_total_output_tokens:
				projectConfig.lastTotalOutputTokens,
			last_session_total_cache_creation_input_tokens:
				projectConfig.lastTotalCacheCreationInputTokens,
			last_session_total_cache_read_input_tokens:
				projectConfig.lastTotalCacheReadInputTokens,
			last_session_fps_average: projectConfig.lastFpsAverage,
			last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
			last_session_id:
				projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
			...projectConfig.lastSessionMetrics,
		});
		// 注意：我们有意在记录后不清除这些值。
		// 它们在恢复会话时需要用于成本恢复。
		// 当下一个会话退出时这些值会被覆盖。
	}
}
