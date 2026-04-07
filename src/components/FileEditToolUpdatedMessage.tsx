import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '@anthropic/ink'
import { count } from '../utils/array.js'
import { MessageResponse } from './MessageResponse.js'
import { StructuredDiffList } from './StructuredDiffList.js'

type Props = {
  filePath: string
  structuredPatch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
  style?: 'condensed'
  verbose: boolean
  previewHint?: string
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
  previewHint,
}: Props): React.ReactNode {
	const { columns } = useTerminalSize();
	const numAdditions = structuredPatch.reduce(
		(acc, hunk) => acc + count(hunk.lines, (_) => _.startsWith("+")),
		0,
	);
	const numRemovals = structuredPatch.reduce(
		(acc, hunk) => acc + count(hunk.lines, (_) => _.startsWith("-")),
		0,
	);

	const text = (
		<Text>
			{numAdditions > 0 ? (
				<>
					Added <Text bold>{numAdditions}</Text>{" "}
					{numAdditions > 1 ? "lines" : "line"}
				</>
			) : null}
			{numAdditions > 0 && numRemovals > 0 ? ", " : null}
			{numRemovals > 0 ? (
				<>
					{numAdditions === 0 ? "R" : "r"}emoved{" "}
					<Text bold>{numRemovals}</Text>{" "}
					{numRemovals > 1 ? "lines" : "line"}
				</>
			) : null}
		</Text>
	);

	// 计划文件：反转简洁行为
	// - 普通模式：仅显示提示（用户可以输入 /plan 查看完整内容）
	// - 简洁模式（子代理视图）：显示 diff
	if (previewHint) {
		if (style !== "condensed" && !verbose) {
			return (
				<MessageResponse>
					<Text dimColor>{previewHint}</Text>
				</MessageResponse>
			);
		}
	} else if (style === "condensed" && !verbose) {
		return text;
	}

	return (
		<MessageResponse>
			<Box flexDirection="column">
				<Text>{text}</Text>
				<StructuredDiffList
					hunks={structuredPatch}
					dim={false}
					width={columns - 12}
					filePath={filePath}
					firstLine={firstLine}
					fileContent={fileContent}
				/>
			</Box>
		</MessageResponse>
	);
}
