import React from 'react'
import { Text, Dialog } from '@anthropic/ink'
import type { ValidationError } from '../utils/settings/validation.js'
import { Select } from './CustomSelect/index.js'
import { ValidationErrorsList } from './ValidationErrorsList.js'

type Props = {
  settingsErrors: ValidationError[]
  onContinue: () => void
  onExit: () => void
}

/**
 * 当设置文件有验证错误时显示的对话框。
 * 用户必须选择继续（跳过无效文件）或退出修复。
 */
export function InvalidSettingsDialog({
  settingsErrors,
  onContinue,
  onExit,
}: Props): React.ReactNode {
  function handleSelect(value: string): void {
    if (value === 'exit') {
      onExit()
    } else {
      onContinue()
    }
  }

  return (
    <Dialog title="Settings Error" onCancel={onExit} color="warning">
      <ValidationErrorsList errors={settingsErrors} />
      <Text dimColor>
        Files with errors are skipped entirely, not just the invalid settings.
      </Text>
      <Select
        options={[
          { label: 'Exit and fix manually', value: 'exit' },
          {
            label: 'Continue without these settings',
            value: 'continue',
          },
        ]}
        onChange={handleSelect}
      />
    </Dialog>
  )
}
