/**
 * main.tsx 中一次性对话框 JSX 站点的精简启动器。
 * 每个启动器动态导入其组件，并以与原始内联调用站点相同的方式连接 `done` 回调。
 * 零行为更改。
 *
 * main.tsx React/JSX 提取工作的一部分。参见同级 PR
 * perf/extract-interactive-helpers 和 perf/launch-repl。
 */
import React from 'react'
import type { AssistantSession } from './assistant/sessionDiscovery.js'
import type { StatsStore } from './context/stats.js'
import type { Root } from '@anthropic/ink'
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js'
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js'
import type { AppState } from './state/AppStateStore.js'
import type { AgentMemoryScope } from './tools/AgentTool/agentMemory.js'
import type { TeleportRemoteResponse } from './utils/conversationRecovery.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import type { ValidationError } from './utils/settings/validation.js'

// Type-only access to ResumeConversation's Props via the module type.
// No runtime cost - erased at compile time.
type ResumeConversationProps = React.ComponentProps<
  typeof import('./screens/ResumeConversation.js').ResumeConversation
>

/**
 * 站点 ~3173: SnapshotUpdateDialog（代理内存快照更新提示）。
 * 原始回调连接：onComplete={done}, onCancel={() => done('keep')}。
 */
export async function launchSnapshotUpdateDialog(
  root: Root,
  props: {
    agentType: string
    scope: AgentMemoryScope
    snapshotTimestamp: string
  },
): Promise<'merge' | 'keep' | 'replace'> {
  const { SnapshotUpdateDialog } = await import(
    './components/agents/SnapshotUpdateDialog.js'
  )
  return showSetupDialog<'merge' | 'keep' | 'replace'>(root, done => (
    <SnapshotUpdateDialog
      agentType={props.agentType}
      scope={props.scope}
      snapshotTimestamp={props.snapshotTimestamp}
      onComplete={done}
      onCancel={() => done('keep')}
    />
  ))
}

/**
 * Site ~3250: InvalidSettingsDialog (settings validation errors).
 * Original callback wiring: onContinue={done}, onExit passed through from caller.
 */
export async function launchInvalidSettingsDialog(
  root: Root,
  props: {
    settingsErrors: ValidationError[]
    onExit: () => void
  },
): Promise<void> {
  const { InvalidSettingsDialog } = await import(
    './components/InvalidSettingsDialog.js'
  )
  return showSetupDialog(root, done => (
    <InvalidSettingsDialog
      settingsErrors={props.settingsErrors}
      onContinue={done}
      onExit={props.onExit}
    />
  ))
}

/**
 * 站点 ~4229: AssistantSessionChooser（选择要附加的桥接会话）。
 * 原始回调连接：onSelect={id => done(id)}, onCancel={() => done(null)}。
 */
export async function launchAssistantSessionChooser(
  root: Root,
  props: { sessions: AssistantSession[] },
): Promise<string | null> {
  const { AssistantSessionChooser } = await import(
    './assistant/AssistantSessionChooser.js'
  )
  return showSetupDialog<string | null>(root, done => (
    <AssistantSessionChooser
      sessions={props.sessions}
      onSelect={id => done(id)}
      onCancel={() => done(null)}
    />
  ))
}

/**
 * `claude assistant` found zero sessions — show the same install wizard
 * as `/assistant` when daemon.json is empty. Resolves to the installed dir on
 * success, null on cancel. Rejects on install failure so the caller can
 * distinguish errors from user cancellation.
 */
export async function launchAssistantInstallWizard(
  root: Root,
): Promise<string | null> {
  const { NewInstallWizard, computeDefaultInstallDir } = await import(
    './commands/assistant/assistant.js'
  )
  const defaultDir = await computeDefaultInstallDir()
  let rejectWithError: (reason: Error) => void
  const errorPromise = new Promise<never>((_, reject) => {
    rejectWithError = reject
  })
  const resultPromise = showSetupDialog<string | null>(root, done => (
    <NewInstallWizard
      defaultDir={defaultDir}
      onInstalled={dir => done(dir)}
      onCancel={() => done(null)}
      onError={message =>
        rejectWithError(new Error(`Installation failed: ${message}`))
      }
    />
  ))
  return Promise.race([resultPromise, errorPromise])
}

/**
 * 站点 ~4549: TeleportResumeWrapper（交互式传送会话选择器）。
 * 原始回调连接：onComplete={done}, onCancel={() => done(null)}, source="cliArg"。
 */
export async function launchTeleportResumeWrapper(
  root: Root,
): Promise<TeleportRemoteResponse | null> {
  const { TeleportResumeWrapper } = await import(
    './components/TeleportResumeWrapper.js'
  )
  return showSetupDialog<TeleportRemoteResponse | null>(root, done => (
    <TeleportResumeWrapper
      onComplete={done}
      onCancel={() => done(null)}
      source="cliArg"
    />
  ))
}

/**
 * Site ~4597: TeleportRepoMismatchDialog (pick a local checkout of the target repo).
 * Original callback wiring: onSelectPath={done}, onCancel={() => done(null)}.
 */
export async function launchTeleportRepoMismatchDialog(
  root: Root,
  props: {
    targetRepo: string
    initialPaths: string[]
  },
): Promise<string | null> {
  const { TeleportRepoMismatchDialog } = await import(
    './components/TeleportRepoMismatchDialog.js'
  )
  return showSetupDialog<string | null>(root, done => (
    <TeleportRepoMismatchDialog
      targetRepo={props.targetRepo}
      initialPaths={props.initialPaths}
      onSelectPath={done}
      onCancel={() => done(null)}
    />
  ))
}

/**
 * 站点 ~4903: ResumeConversation 挂载（交互式会话选择器）。
 * 使用 renderAndRun，不是 showSetupDialog。包装在 <App><KeybindingSetup> 中。
 * 保留 getWorktreePaths 和导入之间的原始 Promise.all 并行性。
 */
export async function launchResumeChooser(
  root: Root,
  appProps: {
    getFpsMetrics: () => FpsMetrics | undefined
    stats: StatsStore
    initialState: AppState
  },
  worktreePathsPromise: Promise<string[]>,
  resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>,
): Promise<void> {
  const [worktreePaths, { ResumeConversation }, { App }] = await Promise.all([
    worktreePathsPromise,
    import('./screens/ResumeConversation.js'),
    import('./components/App.js'),
  ])
  await renderAndRun(
    root,
    <App
      getFpsMetrics={appProps.getFpsMetrics}
      stats={appProps.stats}
      initialState={appProps.initialState}
    >
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>,
  )
}
