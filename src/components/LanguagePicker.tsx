import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text } from '@anthropic/ink'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import TextInput from './TextInput.js'

type Props = {
  initialLanguage: string | undefined
  onComplete: (language: string | undefined) => void
  onCancel: () => void
}

export function LanguagePicker({
  initialLanguage,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [language, setLanguage] = useState(initialLanguage)
  const [cursorOffset, setCursorOffset] = useState(
    (initialLanguage ?? '').length,
  )

  // 使用可配置的键绑定来 ESC 取消
  // 使用设置上下文，这样 'n' 键不会触发取消（允许在输入中输入 'n'）
  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  function handleSubmit(): void {
    const trimmed = language?.trim()
    onComplete(trimmed || undefined)
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Enter your preferred response and voice language:</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <TextInput
          value={language ?? ''}
          onChange={setLanguage}
          onSubmit={handleSubmit}
          focus={true}
          showCursor={true}
          placeholder={`e.g., Japanese, 日本語, Español${figures.ellipsis}`}
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
        />
      </Box>
      <Text dimColor>Leave empty for default (English)</Text>
    </Box>
  )
}
