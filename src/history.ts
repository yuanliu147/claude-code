import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/**
 * 存储的粘贴内容 - 内联内容或粘贴存储的哈希引用。
 */
type StoredPastedContent = {
	id: number;
	type: "text" | "image";
	content?: string; // 内联内容（小粘贴）
	contentHash?: string; // 哈希引用（大粘贴存储在外部）
	mediaType?: string;
	filename?: string;
};

/**
 * Claude Code 解析历史记录中的粘贴内容引用以匹配回粘贴内容。引用格式如下：
 *   Text: [Pasted text #1 +10 lines]
 *   Image: [Image #2]
 * 编号在单个提示内应该是唯一的，但在不同提示之间不需要。
 * 我们选择数字自动递增 ID，因为它们比其他 ID 选项更友好。
 */

// 注意：原始文本粘贴实现会将 "line1\nline2\nline3" 这样的输入
// 视为 +2 行，而不是 3 行。我们在这里保留了这种行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`
  }
  return `[Pasted text #${id} +${numLines} lines]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0'),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/**
 * 将输入中的 [Pasted text #N] 占位符替换为实际内容。
 * 图片引用保持不变——它们变成内容块，而不是内联文本。
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
	const refs = parseReferences(input);
	let expanded = input;
	// 从原始匹配偏移量处拼接，这样粘贴内容内部的占位符类字符串
	// 永远不会被误认为真实引用。反向顺序确保
	// 后面的替换后前面的偏移量仍然有效。
	for (let i = refs.length - 1; i >= 0; i--) {
		const ref = refs[i]!;
		const content = pastedContents[ref.id];
		if (content?.type !== "text") continue;
		expanded =
			expanded.slice(0, ref.index) +
			content.content +
			expanded.slice(ref.index + ref.match.length);
	}
	return expanded;
}

function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
	const currentSession = getSessionId();

	// 从尚未刷新到磁盘的条目开始
	for (let i = pendingEntries.length - 1; i >= 0; i--) {
		yield pendingEntries[i]!;
	}

	// 从全局历史文件读取（跨项目共享）
	const historyPath = join(getClaudeConfigHomeDir(), "history.jsonl");

	try {
		for await (const line of readLinesReverse(historyPath)) {
			try {
				const entry = deserializeLogEntry(line);
				// removeLastFromHistory 慢路径：条目在移除前已刷新，
				// 所以在这里过滤，以便 getHistory（向上箭头）和 makeHistoryReader
				//（ctrl+r 搜索）都能一致地跳过它。
				if (
					entry.sessionId === currentSession &&
					skippedTimestamps.has(entry.timestamp)
				) {
					continue;
				}
				yield entry;
			} catch (error) {
				// 不是关键错误 - 只是跳过格式错误的行
				logForDebugging(`Failed to parse history line: ${error}`);
			}
		}
	} catch (e: unknown) {
		const code = getErrnoCode(e);
		if (code === "ENOENT") {
			return;
		}
		throw e;
	}
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntry>
}

/**
 * 当前项目历史记录，用于 ctrl+r 选择器：按显示文本去重，
 * 最新优先，带时间戳。粘贴内容通过 `resolve()` 延迟解析——
 * 选择器只为列表读取 display+timestamp。
 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/**
 * 获取当前项目的历史记录，当前会话的条目优先。
 *
 * 当前会话的条目在其他会话的条目之前产生，
 * 这样并发会话不会交错其向上箭头历史。在每个组内，
 * 顺序是最新的优先。扫描与之前相同的 MAX_HISTORY_ITEMS 窗口——
 * 条目在该窗口内重新排序，而不是超出它。
 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
		// 跳过格式错误的条目（文件损坏、旧格式或无效的 JSON 结构）
		if (!entry || typeof entry.project !== "string") continue;
		if (entry.project !== currentProject) continue;

		if (entry.sessionId === currentSession) {
			yield await logEntryToHistoryEntry(entry);
			yielded++;
		} else {
			otherSessionEntries.push(entry);
		}

		// Same MAX_HISTORY_ITEMS window as before — just reordered within it.
		if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break;
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/**
 * 通过在需要时从粘贴存储获取来解析存储的粘贴内容为完整 PastedContent。
 */
async function resolveStoredPastedContent(
	stored: StoredPastedContent,
): Promise<PastedContent | null> {
	// 如果有内联内容，直接使用
	if (stored.content) {
		return {
			id: stored.id,
			type: stored.type,
			content: stored.content,
			mediaType: stored.mediaType,
			filename: stored.filename,
		};
	}

	// 如果有哈希引用，从粘贴存储获取
	if (stored.contentHash) {
		const content = await retrievePastedText(stored.contentHash);
		if (content) {
			return {
				id: stored.id,
				type: stored.type,
				content,
				mediaType: stored.mediaType,
				filename: stored.filename,
			};
		}
	}

	// Content not available
	return null;
}

/**
 * 通过解析粘贴存储引用将 LogEntry 转换为 HistoryEntry。
 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 已刷新到磁盘但读取时应跳过的条目时间戳。
// 用于 removeLastFromHistory 当条目已与待处理缓冲区竞争时。
// 会话范围（模块状态在进程重启时重置）。
const skippedTimestamps = new Set<number>()

// 核心刷新逻辑 - 将待处理条目写入磁盘
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
		const historyPath = join(getClaudeConfigHomeDir(), "history.jsonl");

		// 确保在获取锁之前文件存在（追加模式会在不存在时创建）
		await writeFile(historyPath, "", {
			encoding: "utf8",
			mode: 0o600,
			flag: "a",
		});

		release = await lock(historyPath, {
			stale: 10000,
			retries: {
				retries: 3,
				minTimeout: 50,
			},
		});

		const jsonLines = pendingEntries.map(
			(entry) => jsonStringify(entry) + "\n",
		);
		pendingEntries = [];

		await appendFile(historyPath, jsonLines.join(""), { mode: 0o600 });
  } catch (error) {
    logForDebugging(`Failed to write prompt history: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

async function flushPromptHistory(retries: number): Promise<void> {
	if (isWriting || pendingEntries.length === 0) {
		return;
	}

	// 停止尝试刷新历史直到下一个用户提示
	if (retries > 5) {
		return;
	}

	isWriting = true;

	try {
		await immediateFlushHistory();
	} finally {
		isWriting = false;

		if (pendingEntries.length > 0) {
			// 避免在热循环中再次尝试
			await sleep(500);

			void flushPromptHistory(retries + 1);
		}
	}
}

async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
		// 过滤图片（它们单独存储在 image-cache 中）
		if (content.type === "image") {
			continue;
		}

		// 对于小型文本内容，内联存储
		if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
			storedPastedContents[Number(id)] = {
				id: content.id,
				type: content.type,
				content: content.content,
				mediaType: content.mediaType,
				filename: content.filename,
			};
		} else {
			// 对于大型文本内容，同步计算哈希并存储引用
			// 实际的磁盘写入是异步的（fire-and-forget）
			const hash = hashPastedText(content.content);
			storedPastedContents[Number(id)] = {
				id: content.id,
				type: content.type,
				contentHash: hash,
				mediaType: content.mediaType,
				filename: content.filename,
			};
			// Fire-and-forget 磁盘写入 - 不要阻塞历史条目创建
			void storePastedText(hash, content.content);
		}
	}
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

export function addToHistory(command: HistoryEntry | string): void {
	// 当在 Claude Code 的 Tungsten 工具生成的 tmux 会话中运行时，跳过历史记录。
	// 这可以防止验证/测试会话污染用户的真实命令历史。
	if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
		return;
	}

	// 首次使用时注册清理
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		registerCleanup(async () => {
			// 如果有正在进行的刷新，等待它
			if (currentFlushPromise) {
				await currentFlushPromise;
			}
			// 如果刷新完成后仍有待处理条目，进行一次最终刷新
			if (pendingEntries.length > 0) {
				await immediateFlushHistory();
			}
		});
	}

	void addToPromptHistory(command);
}

export function clearPendingHistoryEntries(): void {
  pendingEntries = []
  lastAddedEntry = null
  skippedTimestamps.clear()
}

/**
 * 撤销最近一次 addToHistory 调用。用于自动恢复中断：
 * 当 Esc 在任何响应到达之前回退对话时，提交在语义上被撤销——
 * 历史条目也应该如此，否则向上箭头会显示恢复的文本两次
 *（一次来自输入框，一次来自磁盘）。
 *
 * 快速路径从待处理缓冲区弹出。如果异步刷新已经赢得竞争
 *（TTFT 通常 >> 磁盘写入延迟），条目的时间戳会被添加到
 * getHistory 查阅的跳过集中。一次性操作：清除跟踪的条目，
 * 以便第二次调用是空操作。
 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
