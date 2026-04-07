import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'
import * as React from 'react'
import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { extractTag } from 'src/utils/messages.js'
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js'
import { Box, Text } from '@anthropic/ink'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { countCharInString } from '../utils/stringUtils.js'
import { MessageResponse } from './MessageResponse.js'

const MAX_RENDERED_LINES = 10

type Props = {
  result: ToolResultBlockParam['content']
  verbose: boolean
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
}: Props): React.ReactNode {
  const transcriptShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  let error: string

  if (typeof result !== 'string') {
    error = 'Tool execution failed'
  } else {
		const extractedError = extractTag(result, "tool_use_error") ?? result;
		// 从错误显示中移除 sandbox_violations 标签（Claude 在工具结果中仍能看到它们）
		const withoutSandboxViolations =
			removeSandboxViolationTags(extractedError);
		// Strip <error> tags but keep their content (tags are for the model, not the UI)
		const withoutErrorTags = withoutSandboxViolations.replace(
			/<\/?error>/g,
			"",
		);
		const trimmed = withoutErrorTags.trim();
		if (!verbose && trimmed.includes("InputValidationError: ")) {
			error = "Invalid tool parameters";
		} else if (
			trimmed.startsWith("Error: ") ||
			trimmed.startsWith("Cancelled: ")
		) {
			error = trimmed;
		} else {
			error = `Error: ${trimmed}`;
		}
  }

  const plusLines = countCharInString(error, '\n') + 1 - MAX_RENDERED_LINES

  return (
		<MessageResponse>
			<Box flexDirection="column">
				<Text color="error">
					{stripUnderlineAnsi(
						verbose
							? error
							: error
									.split("\n")
									.slice(0, MAX_RENDERED_LINES)
									.join("\n"),
					)}
				</Text>
				{!verbose && plusLines > 0 && (
					// 仔细的 <Text> 布局是 dim-bold 渲染 bug 的变通方法
					<Box>
						<Text dimColor>
							… +{plusLines} {plusLines === 1 ? "line" : "lines"}{" "}
							(
						</Text>
						<Text dimColor bold>
							{transcriptShortcut}
						</Text>
						<Text> </Text>
						<Text dimColor>to see all)</Text>
					</Box>
				)}
			</Box>
		</MessageResponse>
  );
}
