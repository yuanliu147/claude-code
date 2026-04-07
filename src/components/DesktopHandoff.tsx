import React, { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../commands.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 原始输入用于"任意键"关闭和 y/n 提示
import { Box, Text, useInput, LoadingState } from '@anthropic/ink'
import { getDesktopInstallStatus, openCurrentSessionInDesktop } from '../utils/desktopDeepLink.js'
import { openBrowser } from '../utils/browser.js'

import { errorMessage } from '../utils/errors.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { flushSessionStorage } from '../utils/sessionStorage.js'

const DESKTOP_DOCS_URL = 'https://clau.de/desktop'

export function getDownloadUrl(): string {
  switch (process.platform) {
    case 'win32':
      return 'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect'
    default:
      return 'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect'
  }
}

type DesktopHandoffState =
  | 'checking'
  | 'prompt-download'
  | 'flushing'
  | 'opening'
  | 'success'
  | 'error'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function DesktopHandoff({ onDone }: Props): React.ReactNode {
	const [state, setState] = useState<DesktopHandoffState>("checking");
	const [error, setError] = useState<string | null>(null);
	const [downloadMessage, setDownloadMessage] = useState<string>("");

	// 处理错误和 prompt-download 状态的键盘输入
	useInput((input) => {
		if (state === "error") {
			onDone(error ?? "Unknown error", { display: "system" });
			return;
		}
		if (state === "prompt-download") {
			if (input === "y" || input === "Y") {
				openBrowser(getDownloadUrl()).catch(() => {});
				onDone(
					`Starting download. Re-run /desktop once you\u2019ve installed the app.\nLearn more at ${DESKTOP_DOCS_URL}`,
					{ display: "system" },
				);
			} else if (input === "n" || input === "N") {
				onDone(
					`The desktop app is required for /desktop. Learn more at ${DESKTOP_DOCS_URL}`,
					{ display: "system" },
				);
			}
		}
	});

	useEffect(() => {
		async function performHandoff(): Promise<void> {
			// 检查 Desktop 安装状态
			setState("checking");
			const installStatus = await getDesktopInstallStatus();

			if (installStatus.status === "not-installed") {
				setDownloadMessage("Claude Desktop is not installed.");
				setState("prompt-download");
				return;
			}

			if (installStatus.status === "version-too-old") {
				setDownloadMessage(
					`Claude Desktop needs to be updated (found v${installStatus.version}, need v1.1.2396+).`,
				);
				setState("prompt-download");
				return;
			}

			// 刷新会话存储以确保会话记录完全写入
			setState("flushing");
			await flushSessionStorage();

			// 打开深度链接（开发模式下使用 claude-dev://）
			setState("opening");
			const result = await openCurrentSessionInDesktop();

			if (!result.success) {
				setError(result.error ?? "Failed to open Claude Desktop");
				setState("error");
				return;
			}

			// 成功 - 退出 CLI
			setState("success");

			// 给用户一点时间看到成功消息
			setTimeout(
				async (onDone: Props["onDone"]) => {
					onDone("Session transferred to Claude Desktop", {
						display: "system",
					});
					await gracefulShutdown(0, "other");
				},
				500,
				onDone,
			);
		}

		performHandoff().catch((err) => {
			setError(errorMessage(err));
			setState("error");
		});
	}, [onDone]);

	if (state === "error") {
		return (
			<Box flexDirection="column" paddingX={2}>
				<Text color="error">Error: {error}</Text>
				<Text dimColor>Press any key to continue…</Text>
			</Box>
		);
	}

	if (state === "prompt-download") {
		return (
			<Box flexDirection="column" paddingX={2}>
				<Text>{downloadMessage}</Text>
				<Text>Download now? (y/n)</Text>
			</Box>
		);
	}

	const messages: Record<
		Exclude<DesktopHandoffState, "error" | "prompt-download">,
		string
	> = {
		checking: "Checking for Claude Desktop…",
		flushing: "Saving session…",
		opening: "Opening Claude Desktop…",
		success: "Opening in Claude Desktop…",
	};

	return <LoadingState message={messages[state]} />;
}
