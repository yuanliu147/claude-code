import React from 'react'
import { renderPlaceholder } from '../hooks/renderPlaceholder.js'
import { usePasteHandler } from '../hooks/usePasteHandler.js'
import { useDeclaredCursor } from '@anthropic/ink'
import { Ansi, Box, Text, useInput } from '@anthropic/ink'
import type {
  BaseInputState,
  BaseTextInputProps,
} from '../types/textInputTypes.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import { HighlightedInput } from './PromptInput/ShimmeredInput.js'

type BaseTextInputComponentProps = BaseTextInputProps & {
  inputState: BaseInputState
  children?: React.ReactNode
  terminalFocus: boolean
  highlights?: TextHighlight[]
  invert?: (text: string) => string
  hidePlaceholderText?: boolean
}

/**
 * 处理渲染和基本输入的文本输入基础组件
 */
export function BaseTextInput({
  inputState,
  children,
  terminalFocus,
  invert,
  hidePlaceholderText,
  ...props
}: BaseTextInputComponentProps): React.ReactNode {
	const { onInput, renderedValue, cursorLine, cursorColumn } = inputState;

	// 将原生终端光标停在输入插入符位置。终端模拟器
	// 会根据物理光标位置定位 IME 预输入文本，屏幕阅读器 /
	// 屏幕放大镜会追踪它——所以停在这里可以使 CJK 输入显示在
	// 行内，并让辅助工具跟随输入。下面的 Box ref 是 yoga 布局原点；
	// (cursorLine, cursorColumn) 是相对于它的。
	// 仅在输入聚焦、显示光标且终端本身有焦点时激活。
	const cursorRef = useDeclaredCursor({
		line: cursorLine,
		column: cursorColumn,
		active: Boolean(props.focus && props.showCursor && terminalFocus),
	});

	const { wrappedOnInput, isPasting } = usePasteHandler({
		onPaste: props.onPaste,
		onInput: (input, key) => {
			// Prevent Enter key from triggering submission during paste
			if (isPasting && key.return) {
				return;
			}
			onInput(input, key);
		},
		onImagePaste: props.onImagePaste,
	});

	// Notify parent when paste state changes
	const { onIsPastingChange } = props;
	React.useEffect(() => {
		if (onIsPastingChange) {
			onIsPastingChange(isPasting);
		}
	}, [isPasting, onIsPastingChange]);

	const { showPlaceholder, renderedPlaceholder } = renderPlaceholder({
		placeholder: props.placeholder,
		value: props.value,
		showCursor: props.showCursor,
		focus: props.focus,
		terminalFocus,
		invert,
		hidePlaceholderText,
	});

	useInput(wrappedOnInput, { isActive: props.focus });

	// Show argument hint only when we have a value and the hint is provided
	// Only show the argument hint when:
	// 1. We have a hint to show
	// 2. We have a command typed (value is not empty)
	// 3. The command doesn't have arguments yet (no text after the space)
	// 4. We're actually typing a command (the value starts with /)
	const commandWithoutArgs =
		(props.value && props.value.trim().indexOf(" ") === -1) ||
		(props.value && props.value.endsWith(" "));

	const showArgumentHint = Boolean(
		props.argumentHint &&
		props.value &&
		commandWithoutArgs &&
		props.value.startsWith("/"),
	);

	// Filter out highlights that contain the cursor position
	const cursorFiltered =
		props.showCursor && props.highlights
			? props.highlights.filter(
					(h) =>
						h.dimColor ||
						props.cursorOffset < h.start ||
						props.cursorOffset >= h.end,
				)
			: props.highlights;

	// Adjust highlights for viewport windowing: highlight positions reference the
	// full input text, but renderedValue only contains the windowed subset.
	const { viewportCharOffset, viewportCharEnd } = inputState;
	const filteredHighlights =
		cursorFiltered && viewportCharOffset > 0
			? cursorFiltered
					.filter(
						(h) =>
							h.end > viewportCharOffset &&
							h.start < viewportCharEnd,
					)
					.map((h) => ({
						...h,
						start: Math.max(0, h.start - viewportCharOffset),
						end: h.end - viewportCharOffset,
					}))
			: cursorFiltered;

	const hasHighlights = filteredHighlights && filteredHighlights.length > 0;

	if (hasHighlights) {
		return (
			<Box ref={cursorRef}>
				<HighlightedInput
					text={renderedValue}
					highlights={filteredHighlights}
				/>
				{showArgumentHint && (
					<Text dimColor>
						{props.value?.endsWith(" ") ? "" : " "}
						{props.argumentHint}
					</Text>
				)}
				{children}
			</Box>
		);
	}

	return (
		<Box ref={cursorRef}>
			<Text wrap="truncate-end" dimColor={props.dimColor}>
				{showPlaceholder && props.placeholderElement ? (
					props.placeholderElement
				) : showPlaceholder && renderedPlaceholder ? (
					<Ansi>{renderedPlaceholder}</Ansi>
				) : (
					<Ansi>{renderedValue}</Ansi>
				)}
				{showArgumentHint && (
					<Text dimColor>
						{props.value?.endsWith(" ") ? "" : " "}
						{props.argumentHint}
					</Text>
				)}
				{children}
			</Text>
		</Box>
	);
}
