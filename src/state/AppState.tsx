import { feature } from 'bun:bundle'
import React, {
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from 'react'
import { MailboxProvider } from '../context/mailbox.js'
import { useSettingsChange } from '../hooks/useSettingsChange.js'
import { logForDebugging } from '../utils/debug.js'
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from '../utils/permissions/permissionSetup.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { createStore } from './store.js'

// DCE: 语音上下文是 ant 专有功能。外部构建版本使用透传实现。
/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceProvider: (props: { children: React.ReactNode }) => React.ReactNode =
  feature('VOICE_MODE')
    ? require('../context/voice.js').VoiceProvider
    : ({ children }) => children

/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AppState,
  type AppStateStore,
  getDefaultAppState,
} from './AppStateStore.js'

// TODO: 一旦所有调用者直接从 ./AppStateStore.js 导入，就移除这些重新导出。
// 在迁移过程中保留是为了向后兼容，使 .ts 调用者可以逐步从 .tsx 导入迁移过来，
// 从而避免引入 React 依赖。
export {
  type AppState,
  type AppStateStore,
  type CompletionBoundary,
  getDefaultAppState,
  IDLE_SPECULATION_STATE,
  type SpeculationResult,
  type SpeculationState,
} from './AppStateStore.js'

export const AppStoreContext = React.createContext<AppStateStore | null>(null)

type Props = {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}

const HasAppStateContext = React.createContext<boolean>(false)

export function AppStateProvider({
  children,
  initialState,
  onChangeAppState,
}: Props): React.ReactNode {
  // 不允许嵌套 AppStateProviders。
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error(
      'AppStateProvider 不能嵌套在另一个 AppStateProvider 内部',
    )
  }

  // Store is created once and never changes -- stable context value means
  // the provider never triggers re-renders. Consumers subscribe to slices
  // via useSyncExternalStore in useAppState(selector).
  const [store] = useState(() =>
    createStore<AppState>(
      initialState ?? getDefaultAppState(),
      onChangeAppState,
    ),
  )

  // 在挂载时检查是否应禁用 bypass 模式
  // 这处理了远程设置在组件挂载之前加载的竞态条件，
  // 意味着设置更改通知是在没有订阅者的情况下发送的。
  // 在后续会话中，cached remote-settings.json 会在初始设置期间读取，
  // 但在第一次会话中，远程获取可能在 React 挂载之前完成。
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (
      toolPermissionContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      logForDebugging(
        'Disabling bypass permissions mode on mount (remote settings loaded before mount)',
      )
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(
          prev.toolPermissionContext,
        ),
      }))
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  }, [])

  // Listen for external settings changes and sync to AppState.
  // This ensures file watcher changes propagate through the app --
  // shared with the headless/SDK path via applySettingsChange.
  const onSettingsChange = useEffectEvent((source: SettingSource) =>
    applySettingsChange(source, store.setState),
  )
  useSettingsChange(onSettingsChange)

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}

function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError(
      'useAppState/useSetAppState 不能在 <AppStateProvider /> 之外调用',
    )
  }
  return store
}

/**
 * Subscribe to a slice of AppState. Only re-renders when the selected value
 * changes (compared via Object.is).
 *
 * For multiple independent fields, call the hook multiple times:
 * ```
 * const verbose = useAppState(s => s.verbose)
 * const model = useAppState(s => s.mainLoopModel)
 * ```
 *
 * Do NOT return new objects from the selector -- Object.is will always see
 * them as changed. Instead, select an existing sub-object reference:
 * ```
 * const { text, promptId } = useAppState(s => s.promptSuggestion) // good
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()

  const get = () => {
    const state = store.getState()
    const selected = selector(state)

    if (process.env.USER_TYPE === 'ant' && state === selected) {
      throw new Error(
        `Your selector in \`useAppState(${selector.toString()})\` returned the original state, which is not allowed. You must instead return a property for optimised rendering.`,
      )
    }

    return selected
  }

  return useSyncExternalStore(store.subscribe, get, get)
}

/**
 * Get the setAppState updater without subscribing to any state.
 * Returns a stable reference that never changes -- components using only
 * this hook will never re-render from state changes.
 */
export function useSetAppState(): (
  updater: (prev: AppState) => AppState,
) => void {
  return useAppStore().setState
}

/**
 * Get the store directly (for passing getState/setState to non-React code).
 */
export function useAppStateStore(): AppStateStore {
  return useAppStore()
}

const NOOP_SUBSCRIBE = () => () => {}

/**
 * useAppState 的安全版本，如果在 AppStateProvider 之外调用则返回 undefined。
 * 对于可能在 AppStateProvider 不可用的上下文中渲染的组件很有用。
 */
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, () =>
    store ? selector(store.getState()) : undefined,
  )
}
