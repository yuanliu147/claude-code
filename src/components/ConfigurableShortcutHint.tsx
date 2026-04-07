import * as React from 'react'
import type {
  KeybindingAction,
  KeybindingContextName,
} from '../keybindings/types.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { KeyboardShortcutHint } from '@anthropic/ink'

type Props = {
	/** 键绑定动作（例如 'app:toggleTranscript'） */
	action: KeybindingAction;
	/** 键绑定上下文（例如 'Global'） */
	context: KeybindingContextName;
	/** 如果键绑定未配置则使用默认快捷键 */
	fallback: string;
	/** 操作描述文本（例如 'expand'） */
	description: string;
	/** 是否用括号包裹 */
	parens?: boolean;
	/** 是否显示粗体 */
	bold?: boolean;
};

/**
 * KeyboardShortcutHint，显示用户配置的快捷键。
 * 如果键绑定上下文不可用，则回退到默认值。
 *
 * @example
 * <ConfigurableShortcutHint
 *   action="app:toggleTranscript"
 *   context="Global"
 *   fallback="ctrl+o"
 *   description="expand"
 * />
 */
export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens,
  bold,
}: Props): React.ReactNode {
  const shortcut = useShortcutDisplay(action, context, fallback)
  return (
    <KeyboardShortcutHint
      shortcut={shortcut}
      action={description}
      parens={parens}
      bold={bold}
    />
  )
}
