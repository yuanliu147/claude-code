import { isInputModeCharacter } from 'src/components/PromptInput/inputModes.js'
import { useNotifications } from 'src/context/notifications.js'
import stripAnsi from 'strip-ansi'
import { markBackslashReturnUsed } from '../commands/terminalSetup/terminalSetup.js'
import { addToHistory } from '../history.js'
import type { Key } from '@anthropic/ink'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { isModifierPressed, prewarmModifiers } from '../utils/modifiers.js'
import { useDoublePress } from './useDoublePress.js'

type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
const NOOP_HANDLER: InputHandler = () => {}
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  const map = new Map(input_map)
  return function (input: string): MaybeCursor {
    return (map.get(input) ?? NOOP_HANDLER)(input)
  }
}

export type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  maxVisibleLines?: number
  externalOffset: number
  onOffsetChange: (offset: number) => void
  inputFilter?: (input: string, key: Key) => string
  inlineGhostText?: InlineGhostText
  dim?: (text: string) => string
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste: _onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  maxVisibleLines,
  externalOffset,
  onOffsetChange,
  inputFilter,
  inlineGhostText,
  dim,
}: UseTextInputProps): TextInputState {
	// 为 Apple Terminal 预热 modifiers 模块（有内部保护，可以安全地多次调用）
	if (env.terminal === "Apple_Terminal") {
		prewarmModifiers();
	}

	const offset = externalOffset;
	const setOffset = onOffsetChange;
	const cursor = Cursor.fromText(originalValue, columns, offset);
	const { addNotification, removeNotification } = useNotifications();

	const handleCtrlC = useDoublePress(
		(show) => {
			onExitMessage?.(show, "Ctrl-C");
		},
		() => onExit?.(),
		() => {
			if (originalValue) {
				onChange("");
				setOffset(0);
				onHistoryReset?.();
			}
		},
	);

	// 注意(keybindings): 此 escape 处理器故意不迁移到按键绑定系统。
	// 这是用于清除输入的文本级双按 escape，而非操作级按键绑定。
	// 双按 Esc 会清除输入并保存到历史记录——这是文本编辑行为，
	// 不是对话框关闭，需要双按安全机制。
	const handleEscape = useDoublePress(
		(show: boolean) => {
			if (!originalValue || !show) {
				return;
			}
			addNotification({
				key: "escape-again-to-clear",
				text: "Esc again to clear",
				priority: "immediate",
				timeoutMs: 1000,
			});
		},
		() => {
			// 立即移除 "Esc again to clear" 通知
			removeNotification("escape-again-to-clear");
			onClearInput?.();
			if (originalValue) {
				// 跟踪双按 escape 使用情况以便功能发现
				// 清除前保存到历史记录
				if (originalValue.trim() !== "") {
					addToHistory(originalValue);
				}
				onChange("");
				setOffset(0);
				onHistoryReset?.();
			}
		},
	);

	const handleEmptyCtrlD = useDoublePress(
		(show) => {
			if (originalValue !== "") {
				return;
			}
			onExitMessage?.(show, "Ctrl-D");
		},
		() => {
			if (originalValue !== "") {
				return;
			}
			onExit?.();
		},
	);

	function handleCtrlD(): MaybeCursor {
		if (cursor.text === "") {
			// 输入为空时，处理双按
			handleEmptyCtrlD();
			return cursor;
		}
		// 输入不为空时，向前删除（如 iPython）
		return cursor.del();
	}

	function killToLineEnd(): Cursor {
		const { cursor: newCursor, killed } = cursor.deleteToLineEnd();
		pushToKillRing(killed, "append");
		return newCursor;
	}

	function killToLineStart(): Cursor {
		const { cursor: newCursor, killed } = cursor.deleteToLineStart();
		pushToKillRing(killed, "prepend");
		return newCursor;
	}

	function killWordBefore(): Cursor {
		const { cursor: newCursor, killed } = cursor.deleteWordBefore();
		pushToKillRing(killed, "prepend");
		return newCursor;
	}

	function yank(): Cursor {
		const text = getLastKill();
		if (text.length > 0) {
			const startOffset = cursor.offset;
			const newCursor = cursor.insert(text);
			recordYank(startOffset, text.length);
			return newCursor;
		}
		return cursor;
	}

	function handleYankPop(): Cursor {
		const popResult = yankPop();
		if (!popResult) {
			return cursor;
		}
		const { text, start, length } = popResult;
		// 用新内容替换之前 yanked 的文本
		const before = cursor.text.slice(0, start);
		const after = cursor.text.slice(start + length);
		const newText = before + text + after;
		const newOffset = start + text.length;
		updateYankLength(text.length);
		return Cursor.fromText(newText, columns, newOffset);
	}

	const handleCtrl = mapInput([
		["a", () => cursor.startOfLine()],
		["b", () => cursor.left()],
		["c", handleCtrlC],
		["d", handleCtrlD],
		["e", () => cursor.endOfLine()],
		["f", () => cursor.right()],
		["h", () => cursor.deleteTokenBefore() ?? cursor.backspace()],
		["k", killToLineEnd],
		["n", () => downOrHistoryDown()],
		["p", () => upOrHistoryUp()],
		["u", killToLineStart],
		["w", killWordBefore],
		["y", yank],
	]);

	const handleMeta = mapInput([
		["b", () => cursor.prevWord()],
		["f", () => cursor.nextWord()],
		["d", () => cursor.deleteWordAfter()],
		["y", handleYankPop],
	]);

	function handleEnter(key: Key) {
		if (
			multiline &&
			cursor.offset > 0 &&
			cursor.text[cursor.offset - 1] === "\\"
		) {
			// 跟踪用户使用了反斜杠+回车
			markBackslashReturnUsed();
			return cursor.backspace().insert("\n");
		}
		// Meta+Enter 或 Shift+Enter 插入换行符
		if (key.meta || key.shift) {
			return cursor.insert("\n");
		}
		// Apple Terminal 不支持自定义 Shift+Enter 按键绑定，
		// 因此我们使用原生 macOS 修饰键检测来检查是否按下了 Shift
		if (env.terminal === "Apple_Terminal" && isModifierPressed("shift")) {
			return cursor.insert("\n");
		}
		onSubmit?.(originalValue);
	}

	function upOrHistoryUp() {
		if (disableCursorMovementForUpDownKeys) {
			onHistoryUp?.();
			return cursor;
		}
		// 先尝试按包裹行移动
		const cursorUp = cursor.up();
		if (!cursorUp.equals(cursor)) {
			return cursorUp;
		}

		// 如果无法按包裹行移动且是多行输入，
		// 尝试按逻辑行移动（以处理段落边界）
		if (multiline) {
			const cursorUpLogical = cursor.upLogicalLine();
			if (!cursorUpLogical.equals(cursor)) {
				return cursorUpLogical;
			}
		}

		// 完全无法上移——触发历史记录导航
		onHistoryUp?.();
		return cursor;
	}
	function downOrHistoryDown() {
		if (disableCursorMovementForUpDownKeys) {
			onHistoryDown?.();
			return cursor;
		}
		// 先尝试按包裹行移动
		const cursorDown = cursor.down();
		if (!cursorDown.equals(cursor)) {
			return cursorDown;
		}

		// 如果无法按包裹行移动且是多行输入，
		// 尝试按逻辑行移动（以处理段落边界）
		if (multiline) {
			const cursorDownLogical = cursor.downLogicalLine();
			if (!cursorDownLogical.equals(cursor)) {
				return cursorDownLogical;
			}
		}

		// 完全无法下移——触发历史记录导航
		onHistoryDown?.();
		return cursor;
	}

	function mapKey(key: Key): InputMapper {
		switch (true) {
			case key.escape:
				return () => {
					// 当按键绑定上下文（例如自动补全）拥有 escape 时跳过。
					// useKeybindings 无法通过 stopImmediatePropagation 保护我们——
					// BaseTextInput 的 useInput 先注册（子效果在父效果之前触发），
					// 所以当按键绑定的处理器停止传播时，此处理器已经运行过了。
					if (disableEscapeDoublePress) return cursor;
					handleEscape();
					// 返回当前光标不变——handleEscape 内部管理状态
					return cursor;
				};
			case key.leftArrow && (key.ctrl || key.meta || key.fn):
				return () => cursor.prevWord();
			case key.rightArrow && (key.ctrl || key.meta || key.fn):
				return () => cursor.nextWord();
			case key.backspace:
				return key.meta || key.ctrl
					? killWordBefore
					: () => cursor.deleteTokenBefore() ?? cursor.backspace();
			case key.delete:
				return key.meta ? killToLineEnd : () => cursor.del();
			case key.ctrl:
				return handleCtrl;
			case key.home:
				return () => cursor.startOfLine();
			case key.end:
				return () => cursor.endOfLine();
			case key.pageDown:
				// 在全屏模式下，PgUp/PgDn 滚动消息视口而非移动光标——此处为 no-op，
				// ScrollKeybindingHandler 处理它。
				if (isFullscreenEnvEnabled()) {
					return NOOP_HANDLER;
				}
				return () => cursor.endOfLine();
			case key.pageUp:
				if (isFullscreenEnvEnabled()) {
					return NOOP_HANDLER;
				}
				return () => cursor.startOfLine();
			case key.wheelUp:
			case key.wheelDown:
				// 鼠标滚轮事件仅在全屏鼠标跟踪开启时存在。
				// ScrollKeybindingHandler 处理它们；此处为 no-op 以避免将原始 SGR 序列插入为文本。
				return NOOP_HANDLER;
			case key.return:
				// 必须在 key.meta 之前，以便 Option+Return 插入换行符
				return () => handleEnter(key);
			case key.meta:
				return handleMeta;
			case key.tab:
				return () => cursor;
			case key.upArrow && !key.shift:
				return upOrHistoryUp;
			case key.downArrow && !key.shift:
				return downOrHistoryDown;
			case key.leftArrow:
				return () => cursor.left();
			case key.rightArrow:
				return () => cursor.right();
			default: {
				return function (input: string) {
					switch (true) {
						// Home 键
						case input === "\x1b[H" || input === "\x1b[1~":
							return cursor.startOfLine();
						// End 键
						case input === "\x1b[F" || input === "\x1b[4~":
							return cursor.endOfLine();
						default: {
							// 文本后的尾随 \r 是 SSH 合并的 Enter（"o\r"）——
							// 剥离它以使 Enter 不被插入为内容。这里的单个 \r
							// 是 Alt+Enter 泄露过来（META_KEY_CODE_RE 不匹配 \x1b\r）——
							// 保留它以供下面的 \r→\n 处理。嵌入的 \r
							// 是来自不支持括号粘贴模式的终端的多行粘贴——
							// 转换为 \n。反斜杠+\r 是过期的 VS Code
							// Shift+Enter 绑定（#8991 之前的 /terminal-setup 写入
							// keybindings.json 中的 args.text "\\\r\n"）；保留 \r 以便
							// 它在下面变成 \n（anthropics/claude-code#31316）。
							const text = stripAnsi(input)
								// eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, str) on 1-2 char keystrokes: no-match returns same string (Object.is), regex never runs
								.replace(/(?<=[^\\\r\n])\r$/, "")
								.replace(/\r/g, "\n");
							if (
								cursor.isAtStart() &&
								isInputModeCharacter(input)
							) {
								return cursor.insert(text).left();
							}
							return cursor.insert(text);
						}
					}
				};
			}
		}
	}

	// 检查这是否是 kill 命令（Ctrl+K、Ctrl+U、Ctrl+W 或 Meta+Backspace/Delete）
	function isKillKey(key: Key, input: string): boolean {
		if (key.ctrl && (input === "k" || input === "u" || input === "w")) {
			return true;
		}
		if (key.meta && (key.backspace || key.delete)) {
			return true;
		}
		return false;
	}

	// 检查这是否是 yank 命令（Ctrl+Y 或 Alt+Y）
	function isYankKey(key: Key, input: string): boolean {
		return (key.ctrl || key.meta) && input === "y";
	}

	function onInput(input: string, key: Key): void {
		// Note: Image paste shortcut (chat:imagePaste) is handled via useKeybindings in PromptInput

		// Apply filter if provided
		const filteredInput = inputFilter ? inputFilter(input, key) : input;

		// If the input was filtered out, do nothing
		if (filteredInput === "" && input !== "") {
			return;
		}

		// Fix Issue #1853: Filter DEL characters that interfere with backspace in SSH/tmux
		// In SSH/tmux environments, backspace generates both key events and raw DEL chars
		if (!key.backspace && !key.delete && input.includes("\x7f")) {
			const delCount = (input.match(/\x7f/g) || []).length;

			// Apply all DEL characters as backspace operations synchronously
			// Try to delete tokens first, fall back to character backspace
			let currentCursor = cursor;
			for (let i = 0; i < delCount; i++) {
				currentCursor =
					currentCursor.deleteTokenBefore() ??
					currentCursor.backspace();
			}

			// Update state once with the final result
			if (!cursor.equals(currentCursor)) {
				if (cursor.text !== currentCursor.text) {
					onChange(currentCursor.text);
				}
				setOffset(currentCursor.offset);
			}
			resetKillAccumulation();
			resetYankState();
			return;
		}

		// Reset kill accumulation for non-kill keys
		if (!isKillKey(key, filteredInput)) {
			resetKillAccumulation();
		}

		// Reset yank state for non-yank keys (breaks yank-pop chain)
		if (!isYankKey(key, filteredInput)) {
			resetYankState();
		}

		const nextCursor = mapKey(key)(filteredInput);
		if (nextCursor) {
			if (!cursor.equals(nextCursor)) {
				if (cursor.text !== nextCursor.text) {
					onChange(nextCursor.text);
				}
				setOffset(nextCursor.offset);
			}
			// SSH-coalesced Enter: on slow links, "o" + Enter can arrive as one
			// chunk "o\r". parseKeypress only matches s === '\r', so it hit the
			// default handler above (which stripped the trailing \r). Text with
			// exactly one trailing \r is coalesced Enter; lone \r is Alt+Enter
			// (newline); embedded \r is multi-line paste.
			if (
				filteredInput.length > 1 &&
				filteredInput.endsWith("\r") &&
				!filteredInput.slice(0, -1).includes("\r") &&
				// Backslash+CR is a stale VS Code Shift+Enter binding, not
				// coalesced Enter. See default handler above.
				filteredInput[filteredInput.length - 2] !== "\\"
			) {
				onSubmit?.(nextCursor.text);
			}
		}
	}

	// Prepare ghost text for rendering - validate insertPosition matches current
	// cursor offset to prevent stale ghost text from a previous keystroke causing
	// a one-frame jitter (ghost text state is updated via useEffect after render)
	const ghostTextForRender =
		inlineGhostText && dim && inlineGhostText.insertPosition === offset
			? { text: inlineGhostText.text, dim }
			: undefined;

	const cursorPos = cursor.getPosition();

	return {
		onInput,
		renderedValue: cursor.render(
			cursorChar,
			mask,
			invert,
			ghostTextForRender,
			maxVisibleLines,
		),
		offset,
		setOffset,
		cursorLine:
			cursorPos.line - cursor.getViewportStartLine(maxVisibleLines),
		cursorColumn: cursorPos.column,
		viewportCharOffset: cursor.getViewportCharOffset(maxVisibleLines),
		viewportCharEnd: cursor.getViewportCharEnd(maxVisibleLines),
	};
}
