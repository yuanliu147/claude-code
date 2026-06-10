import * as React from 'react'
import { handlePlanModeTransition } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Box, Text } from '@anthropic/ink'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getExternalEditor } from '../../utils/editor.js'
import { toIDEDisplayName } from '../../utils/ide.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from '../../utils/permissions/permissionSetup.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { renderToString } from '../../utils/staticRender.js'

function PlanDisplay({
  planContent,
  planPath,
  editorName,
}: {
  planContent: string
  planPath: string
  editorName: string | undefined
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Current Plan</Text>
      <Text dimColor>{planPath}</Text>
      <Box marginTop={1}>
        <Text>{planContent}</Text>
      </Box>
      {editorName && (
        <Box marginTop={1}>
          <Text dimColor>&quot;/plan open&quot;</Text>
          <Text dimColor> to edit this plan in </Text>
          <Text bold dimColor>
            {editorName}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const currentMode = appState.toolPermissionContext.mode

  // 如果当前不在 plan 模式，则启用 plan 模式
  if (currentMode !== 'plan') {
    handlePlanModeTransition(currentMode, 'plan')
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prepareContextForPlanMode(prev.toolPermissionContext),
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ),
    }))
    const description = args.trim()
    if (description && description !== 'open') {
      onDone('Enabled plan mode', { shouldQuery: true })
    } else {
      onDone('Enabled plan mode')
    }
    return null
  }

  // 已经在 plan 模式下 —— 展示当前的 plan
  const planContent = getPlan()
  const planPath = getPlanFilePath()

  if (!planContent) {
    onDone('Already in plan mode. No plan written yet.')
    return null
  }

  // 如果用户输入了 "/plan open"，则在编辑器中打开 plan 文件
  const argList = args.trim().split(/\s+/)
  if (argList[0] === 'open') {
    const result = await editFileInEditor(planPath)
    if (result.error) {
      onDone(`Failed to open plan in editor: ${result.error}`)
    } else {
      onDone(`Opened plan in editor: ${planPath}`)
    }
    return null
  }

  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : undefined

  const display = (
    <PlanDisplay
      planContent={planContent}
      planPath={planPath}
      editorName={editorName}
    />
  )

  // 渲染为字符串并传递给 onDone（与本地命令的处理方式一致）
  const output = await renderToString(display)
  onDone(output)
  return null
}
