import { useEffect } from 'react'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { getGlobalConfig } from '../utils/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import type { DetectedIDEInfo } from '../utils/ide.js'
import {
  type IDEExtensionInstallationStatus,
  type IdeType,
  initializeIdeIntegration,
  isSupportedTerminal,
} from '../utils/ide.js'

type UseIDEIntegrationProps = {
  autoConnectIdeFlag?: boolean
  ideToInstallExtension: IdeType | null
  setDynamicMcpConfig: React.Dispatch<
    React.SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>
  >
  setShowIdeOnboarding: React.Dispatch<React.SetStateAction<boolean>>
  setIDEInstallationState: React.Dispatch<
    React.SetStateAction<IDEExtensionInstallationStatus | null>
  >
}

export function useIDEIntegration({
  autoConnectIdeFlag,
  ideToInstallExtension,
  setDynamicMcpConfig,
  setShowIdeOnboarding,
  setIDEInstallationState,
}: UseIDEIntegrationProps): void {
  useEffect(() => {
    function addIde(ide: DetectedIDEInfo | null) {
		if (!ide) {
			return;
		}

		// 检查是否启用了自动连接
		const globalConfig = getGlobalConfig();
		const autoConnectEnabled =
			(globalConfig.autoConnectIde ||
				autoConnectIdeFlag ||
				isSupportedTerminal() ||
				// tmux/screen 覆盖 TERM_PROGRAM，破坏终端检测，但
				// IDE 扩展的端口环境变量会被继承。如果设置了，仍然自动连接。
				process.env.CLAUDE_CODE_SSE_PORT ||
				ideToInstallExtension ||
				isEnvTruthy(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)) &&
			!isEnvDefinedFalsy(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE);

		if (!autoConnectEnabled) {
			return;
		}

		setDynamicMcpConfig((prev) => {
			// 只有在我们还没有 IDE 时才添加
			if (prev?.ide) {
				return prev;
			}
			return {
				...prev,
				ide: {
					type: ide.url.startsWith("ws:") ? "ws-ide" : "sse-ide",
					url: ide.url,
					ideName: ide.name,
					authToken: ide.authToken,
					ideRunningInWindows: ide.ideRunningInWindows,
					scope: "dynamic" as const,
				},
			};
		});
	}

    // Use the new utility function
    void initializeIdeIntegration(
      addIde,
      ideToInstallExtension,
      () => setShowIdeOnboarding(true),
      status => setIDEInstallationState(status),
    )
  }, [
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState,
  ])
}
