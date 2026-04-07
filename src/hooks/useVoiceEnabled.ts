import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasVoiceAuth,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * 结合用户意图（settings.voiceEnabled）与 auth + GB kill-switch。
 * 只有 auth 部分在 authVersion 上 memoized — 它是昂贵的
 * （冷 `security` spawn 的 getClaudeAIOAuthTokens memoize，~60ms/调用，
 * 在 token 刷新清除缓存时会话期间约 ~180ms）。
 * GB 是一个廉价的缓存映射查找，放在 memo 外面，
 * 以便会话中的 kill-switch 翻转仍然在下一次渲染时生效。
 *
 * authVersion 仅在 /login 时增加。后台 token 刷新不触动它
 * （用户仍然已认证），所以 auth memo 保持正确而无需重新评估。
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authed = useMemo(hasVoiceAuth, [authVersion])
  return userIntent && authed && isVoiceGrowthBookEnabled()
}
