import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '../tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '../tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod 防止误触 GB 推送（与 pollConfig.ts / cronScheduler.ts 相同的模式）。
// 格式错误的配置完全回退到 DEFAULT_BRIEF_CONFIG，而不是部分信任。
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// No TTL — this gate controls slash-command *visibility*, not a kill switch.
// CACHED_MAY_BE_STALE still has one background-update flip (first call kicks
// off fetch; second call sees fresh value), but no additional flips after that.
// The tool-availability gate (tengu_kairos_brief in isBriefEnabled) keeps its
// 5-min TTL because that one IS a kill switch.
function getBriefConfig(): BriefConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: 'Toggle brief-only mode',
  isEnabled: () => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // 权限检查只门控转换状态 — 关闭始终允许，
        // 这样 GB 门控在会话中途翻转的用户不会被卡住。
        if (newState && !isBriefEntitled()) {
          logEvent('tengu_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('Brief tool is not enabled for your account', {
            display: 'system',
          })
          return null
        }

        // Two-way: userMsgOptIn tracks isBriefOnly so the tool is available
        // exactly when brief mode is on. This invalidates prompt cache on
        // each toggle (tool list changes), but a stale tool list is worse —
        // when /brief is enabled mid-session the model was previously left
        // without the tool, emitting plain text the filter hides.
        setUserMsgOptIn(newState)

        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        logEvent('tengu_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // 仅工具列表更改不足以成为会话中期的强信号
        // （模型可能继续因惯性发出纯文本，或继续调用刚消失的工具）。
        // 在下一个回合的上下文中注入明确的提醒，以便转换无歧义。
        // 当 Kairos 激活时跳过：isBriefEnabled() 在
        // getKairosActive() 上短路，所以工具实际上不会离开列表，
        // Kairos 系统提示已经强制要求 SendUserMessage。
        // 内联 <system-reminder> 包装 — 从
        // utils/messages.ts 导入 wrapInSystemReminder 会通过
        // 此模块的导入链将 constants/xml.ts 拉入 bridge SDK bundle，
        // 触发 excluded-strings 检查。
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>\n${
                newState
                  ? `Brief mode is now enabled. Use the ${BRIEF_TOOL_NAME} tool for all user-facing output — plain text outside it is hidden from the user's view.`
                  : `Brief mode is now disabled. The ${BRIEF_TOOL_NAME} tool is no longer available — reply with plain text.`
              }\n</system-reminder>`,
            ]

        onDone(
          newState ? 'Brief-only mode enabled' : 'Brief-only mode disabled',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
