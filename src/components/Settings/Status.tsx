import figures from 'figures'
import * as React from 'react'
import { Suspense, use } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { Box, Text, useTheme } from '@anthropic/ink'
import { type AppState, useAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
  buildIDEProperties,
  buildInstallationDiagnostics,
  buildInstallationHealthDiagnostics,
  buildMcpProperties,
  buildMemoryDiagnostics,
  buildSandboxProperties,
  buildSettingSourcesProperties,
  type Diagnostic,
  getModelDisplayLabel,
  type Property,
} from '../../utils/status.js'
import type { ThemeName } from '../../utils/theme.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'

type Props = {
  context: LocalJSXCommandContext
  diagnosticsPromise: Promise<Diagnostic[]>
}

function buildPrimarySection(): Property[] {
  const sessionId = getSessionId()
  const customTitle = getCurrentSessionTitle(sessionId)
  const nameValue = customTitle ?? <Text dimColor>/rename to add a name</Text>

  return [
    { label: 'Version', value: MACRO.VERSION },
    { label: 'Session name', value: nameValue },
    { label: 'Session ID', value: sessionId },
    { label: 'cwd', value: getCwd() },
    ...buildAccountProperties(),
    ...buildAPIProviderProperties(),
  ]
}

function buildSecondarySection({
  mainLoopModel,
  mcp,
  theme,
  context,
}: {
  mainLoopModel: AppState['mainLoopModel']
  mcp: AppState['mcp']
  theme: ThemeName
  context: LocalJSXCommandContext
}): Property[] {
  const modelLabel = getModelDisplayLabel(mainLoopModel)

  return [
    { label: 'Model', value: modelLabel },
    ...buildIDEProperties(
      mcp.clients,
      context.options.ideInstallationStatus,
      theme,
    ),
    ...buildMcpProperties(mcp.clients, theme),
    ...buildSandboxProperties(),
    ...buildSettingSourcesProperties(),
  ]
}

export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [
    ...(await buildInstallationDiagnostics()),
    ...(await buildInstallationHealthDiagnostics()),
    ...(await buildMemoryDiagnostics()),
  ]
}

function PropertyValue({
  value,
}: {
  value: Property['value']
}): React.ReactNode {
  if (Array.isArray(value)) {
    return (
      <Box flexWrap="wrap" columnGap={1} flexShrink={99}>
        {value.map((item, i) => {
          return (
            <Text key={i}>
              {item}
              {i < value.length - 1 ? ',' : ''}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (typeof value === 'string') {
    return <Text>{value}</Text>
  }

  return value
}

export function Status({
  context,
  diagnosticsPromise,
}: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mcp = useAppState(s => s.mcp)
  const [theme] = useTheme()

  // 部分是同步的 — 在渲染中计算，这样它们永远不会为空。
  // diagnosticsPromise 在 Settings.tsx 中创建一次，所以它每个窗格调用解析一次
  // 而不是每次标签切换时重新获取（Tab
  // 在未选中时卸载子组件，这导致了闪烁）。
  const sections = React.useMemo(
    () => [
      buildPrimarySection(),
      buildSecondarySection({ mainLoopModel, mcp, theme, context }),
    ],
    [mainLoopModel, mcp, theme, context],
  )

  // flexGrow 以便当内容短时 "Esc to cancel" 页脚固定在
  // Modal 的内部 ScrollBox 底部。ScrollBox 的内容
  // 包装器有 flexGrow:1（至少填充视口），所以这会
  // 拉伸它。没有它，短 Status 内容浮动在顶部，
  // 页脚位于 Modal 中间，下面有 2-3 个空白行。在
  // Modal 外部（非全屏），不改变布局 — 没有 ScrollBox 需要填充。
  const grow = useIsInsideModal() ? 1 : undefined

  return (
    <Box flexDirection="column" flexGrow={grow}>
      <Box flexDirection="column" gap={1} flexGrow={grow}>
        {sections.map(
          (properties, i) =>
            properties.length > 0 && (
              <Box key={i} flexDirection="column">
                {properties.map(({ label, value }, j) => (
                  <Box key={j} flexDirection="row" gap={1} flexShrink={0}>
                    {label !== undefined && <Text bold>{label}:</Text>}
                    <PropertyValue value={value} />
                  </Box>
                ))}
              </Box>
            ),
        )}

        <Suspense fallback={null}>
          <Diagnostics promise={diagnosticsPromise} />
        </Suspense>
      </Box>
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}

function Diagnostics({
  promise,
}: {
  promise: Promise<Diagnostic[]>
}): React.ReactNode {
  const diagnostics = use(promise)
  if (diagnostics.length === 0) return null
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Text bold>System Diagnostics</Text>
      {diagnostics.map((diagnostic, i) => (
        <Box key={i} flexDirection="row" gap={1} paddingX={1}>
          <Text color="error">{figures.warning}</Text>
          {typeof diagnostic === 'string' ? (
            <Text wrap="wrap">{diagnostic}</Text>
          ) : (
            diagnostic
          )}
        </Box>
      ))}
    </Box>
  )
}
