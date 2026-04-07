import * as React from 'react'
import { Box, Text } from '@anthropic/ink'
import { getAgentModelOptions } from '../../utils/model/agent.js'
import { Select } from '../CustomSelect/select.js'

interface ModelSelectorProps {
  initialModel?: string
  onComplete: (model?: string) => void
  onCancel?: () => void
}

export function ModelSelector({
  initialModel,
  onComplete,
  onCancel,
}: ModelSelectorProps): React.ReactNode {
  const modelOptions = React.useMemo(() => {
    const base = getAgentModelOptions()
    // 如果 agent 当前的模型是完整 ID（例如 'claude-opus-4-5'），而不在
    // 别名列表中，则将其注入为一个选项，以便在确认时能够原样保留，
    // 而不被覆盖。
    if (initialModel && !base.some(o => o.value === initialModel)) {
      return [
        {
          value: initialModel,
          label: initialModel,
          description: 'Current model (custom ID)',
        },
        ...base,
      ]
    }
    return base
  }, [initialModel])

  const defaultModel = initialModel ?? 'sonnet'

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          Model determines the agent&apos;s reasoning capabilities and speed.
        </Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={onComplete}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  )
}
