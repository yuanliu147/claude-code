import * as React from 'react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { Ansi, Box, type DOMElement, measureElement, NoSelect, Text, useTheme } from '@anthropic/ink'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { countCharInString } from '../utils/stringUtils.js'
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js'
import { expectColorFile } from './StructuredDiff/colorDiff.js'

type Props = {
  code: string
  filePath: string
  width?: number
  dim?: boolean
}

const DEFAULT_WIDTH = 80

export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  width,
  dim = false,
}: Props): React.ReactElement {
	const ref = useRef<DOMElement>(null);
	const [measuredWidth, setMeasuredWidth] = useState(width || DEFAULT_WIDTH);
	const [theme] = useTheme();
	const settings = useSettings();
	const syntaxHighlightingDisabled =
		settings.syntaxHighlightingDisabled ?? false;

	const colorFile = useMemo(() => {
		if (syntaxHighlightingDisabled) {
			return null;
		}
		const ColorFile = expectColorFile();
		if (!ColorFile) {
			return null;
		}
		return new ColorFile(code, filePath);
	}, [code, filePath, syntaxHighlightingDisabled]);

	useEffect(() => {
		if (!width && ref.current) {
			const { width: elementWidth } = measureElement(ref.current);
			if (elementWidth > 0) {
				setMeasuredWidth(elementWidth - 2);
			}
		}
	}, [width]);

	const lines = useMemo(() => {
		if (colorFile === null) {
			return null;
		}
		return colorFile.render(theme, measuredWidth, dim);
	}, [colorFile, theme, measuredWidth, dim]);

	// gutter 宽度与 ColorFile 在 lib.rs 中的布局匹配：空格 + 右对齐
	// 行号（max_digits = lineCount.toString().length）+ 空格。没有像 diff 路径
	// 那样的标记列。用 <NoSelect> 包裹以便全屏选择产生干净的代码
	// 而不包含行号。仅在全屏模式下分割（~4× DOM 节点 + sliceAnsi 成本）；
	// 非全屏使用终端原生选择，其中 noSelect 无意义。
	const gutterWidth = useMemo(() => {
		if (!isFullscreenEnvEnabled()) return 0;
		const lineCount = countCharInString(code, "\n") + 1;
		return lineCount.toString().length + 2;
	}, [code]);

	return (
		<Box ref={ref}>
			{lines ? (
				<Box flexDirection="column">
					{lines.map((line, i) =>
						gutterWidth > 0 ? (
							<CodeLine
								key={i}
								line={line}
								gutterWidth={gutterWidth}
							/>
						) : (
							<Text key={i}>
								<Ansi>{line}</Ansi>
							</Text>
						),
					)}
				</Box>
			) : (
				<HighlightedCodeFallback
					code={code}
					filePath={filePath}
					dim={dim}
					skipColoring={syntaxHighlightingDisabled}
				/>
			)}
		</Box>
	);
})

function CodeLine({
  line,
  gutterWidth,
}: {
  line: string
  gutterWidth: number
}): React.ReactNode {
  const gutter = sliceAnsi(line, 0, gutterWidth)
  const content = sliceAnsi(line, gutterWidth)
  return (
    <Box flexDirection="row">
      <NoSelect fromLeftEdge>
        <Text>
          <Ansi>{gutter}</Ansi>
        </Text>
      </NoSelect>
      <Text>
        <Ansi>{content}</Ansi>
      </Text>
    </Box>
  )
}
