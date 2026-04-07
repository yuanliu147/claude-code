import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { useInterval } from 'usehooks-ts'
import { useUpdateNotification } from '../hooks/useUpdateNotification.js'
import { Box, Text } from '@anthropic/ink'
import {
  type AutoUpdaterResult,
  getLatestVersion,
  getMaxVersion,
  type InstallStatus,
  installGlobalPackage,
  shouldSkipVersion,
} from '../utils/autoUpdater.js'
import { getGlobalConfig, isAutoUpdaterDisabled } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js'
import {
  installOrUpdateClaudePackage,
  localInstallationExists,
} from '../utils/localInstaller.js'
import { removeInstalledSymlink } from '../utils/nativeInstaller/index.js'
import { gt, gte } from '../utils/semver.js'
import { getInitialSettings } from '../utils/settings/settings.js'

type Props = {
  isUpdating: boolean
  onChangeIsUpdating: (isUpdating: boolean) => void
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void
  autoUpdaterResult: AutoUpdaterResult | null
  showSuccessMessage: boolean
  verbose: boolean
}

export function AutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose,
}: Props): React.ReactNode {
	const [versions, setVersions] = useState<{
		global?: string | null;
		latest?: string | null;
	}>({});
	const [hasLocalInstall, setHasLocalInstall] = useState(false);
	const updateSemver = useUpdateNotification(autoUpdaterResult?.version);

	useEffect(() => {
		void localInstallationExists().then(setHasLocalInstall);
	}, []);

	// 在 ref 中追踪最新的 isUpdating 值，以便 memoized checkForUpdates
	// 回调始终看到当前值。没有这个，30分钟的
	// interval 触发时会有一个过时的闭包，其中 isUpdating 为 false，允许
	// 并发的 installGlobalPackage() 在已有安装运行时运行。
	const isUpdatingRef = useRef(isUpdating);
	isUpdatingRef.current = isUpdating;

	const checkForUpdates = React.useCallback(async () => {
		if (isUpdatingRef.current) {
			return;
		}

		if ("production" === "test" || "production" === "development") {
			logForDebugging(
				"AutoUpdater: Skipping update check in test/dev environment",
			);
			return;
		}

		const currentVersion = MACRO.VERSION;
		const channel = getInitialSettings()?.autoUpdatesChannel ?? "latest";
		let latestVersion = await getLatestVersion(channel);
		const isDisabled = isAutoUpdaterDisabled();

		// 检查是否设置了最大版本（服务器端自动更新的终止开关）
		const maxVersion = await getMaxVersion();
		if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
			logForDebugging(
				`AutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latestVersion} to ${maxVersion}`,
			);
			if (gte(currentVersion, maxVersion)) {
				logForDebugging(
					`AutoUpdater: current version ${currentVersion} is already at or above maxVersion ${maxVersion}, skipping update`,
				);
				setVersions({ global: currentVersion, latest: latestVersion });
				return;
			}
			latestVersion = maxVersion;
		}

		setVersions({ global: currentVersion, latest: latestVersion });

		// 检查是否需要更新并执行更新
		if (
			!isDisabled &&
			currentVersion &&
			latestVersion &&
			!gte(currentVersion, latestVersion) &&
			!shouldSkipVersion(latestVersion)
		) {
			const startTime = Date.now();
			onChangeIsUpdating(true);

			// 由于使用基于 JS 的更新，移除本机安装程序符号链接
			// 但仅在用户尚未迁移到本机安装时才这样做
			const config = getGlobalConfig();
			if (config.installMethod !== "native") {
				await removeInstalledSymlink();
			}

			// 检测实际运行的安装类型
			const installationType = await getCurrentInstallationType();
			logForDebugging(
				`AutoUpdater: Detected installation type: ${installationType}`,
			);

			// 跳过开发版本的更新
			if (installationType === "development") {
				logForDebugging(
					"AutoUpdater: Cannot auto-update development build",
				);
				onChangeIsUpdating(false);
				return;
			}

			// 根据实际运行情况选择合适的更新方法
			let installStatus: InstallStatus;
			let updateMethod: "local" | "global";

			if (installationType === "npm-local") {
				// 对本地安装使用本地更新方法
				logForDebugging("AutoUpdater: Using local update method");
				updateMethod = "local";
				installStatus = await installOrUpdateClaudePackage(channel);
			} else if (installationType === "npm-global") {
				// 对全局安装使用全局更新方法
				logForDebugging("AutoUpdater: Using global update method");
				updateMethod = "global";
				installStatus = await installGlobalPackage();
			} else if (installationType === "native") {
				// 这不应该发生 - native 应该使用 NativeAutoUpdater
				logForDebugging(
					"AutoUpdater: Unexpected native installation in non-native updater",
				);
				onChangeIsUpdating(false);
				return;
			} else {
				// 对未知类型回退到基于配置检测
				logForDebugging(
					`AutoUpdater: Unknown installation type, falling back to config`,
				);
				const isMigrated = config.installMethod === "local";
				updateMethod = isMigrated ? "local" : "global";

				if (isMigrated) {
					installStatus = await installOrUpdateClaudePackage(channel);
				} else {
					installStatus = await installGlobalPackage();
				}
			}

			onChangeIsUpdating(false);

			if (installStatus === "success") {
				logEvent("tengu_auto_updater_success", {
					fromVersion:
						currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
					toVersion:
						latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
					durationMs: Date.now() - startTime,
					wasMigrated: updateMethod === "local",
					installationType:
						installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
				});
			} else {
				logEvent("tengu_auto_updater_fail", {
					fromVersion:
						currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
					attemptedVersion:
						latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
					status: installStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
					durationMs: Date.now() - startTime,
					wasMigrated: updateMethod === "local",
					installationType:
						installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
				});
			}

			onAutoUpdaterResult({
				version: latestVersion,
				status: installStatus,
			});
		}
		// isUpdating 故意从依赖中省略；我们通过 ref 读取 isUpdatingRef
		// 而不是改变回调标识（那会重新触发下面的初始检查 useEffect）。
		// eslint-disable-next-line react-hooks/exhaustive-deps
		// biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
	}, [onAutoUpdaterResult]);

	// 初始检查
	useEffect(() => {
		void checkForUpdates();
	}, [checkForUpdates]);

	// 每30分钟检查一次
	useInterval(checkForUpdates, 30 * 60 * 1000);

	if (!autoUpdaterResult?.version && (!versions.global || !versions.latest)) {
		return null;
	}

	if (!autoUpdaterResult?.version && !isUpdating) {
		return null;
	}

	return (
		<Box flexDirection="row" gap={1}>
			{verbose && (
				<Text dimColor wrap="truncate">
					globalVersion: {versions.global} &middot; latestVersion:{" "}
					{versions.latest}
				</Text>
			)}
			{isUpdating ? (
				<>
					<Box>
						<Text color="text" dimColor wrap="truncate">
							Auto-updating…
						</Text>
					</Box>
				</>
			) : (
				autoUpdaterResult?.status === "success" &&
				showSuccessMessage &&
				updateSemver && (
					<Text color="success" wrap="truncate">
						✓ Update installed · Restart to apply
					</Text>
				)
			)}
			{(autoUpdaterResult?.status === "install_failed" ||
				autoUpdaterResult?.status === "no_permissions") && (
				<Text color="error" wrap="truncate">
					✗ Auto-update failed &middot; Try{" "}
					<Text bold>claude doctor</Text> or{" "}
					<Text bold>
						{hasLocalInstall
							? `cd ~/.claude/local && npm update ${MACRO.PACKAGE_URL}`
							: `npm i -g ${MACRO.PACKAGE_URL}`}
					</Text>
				</Text>
			)}
		</Box>
	);
}
