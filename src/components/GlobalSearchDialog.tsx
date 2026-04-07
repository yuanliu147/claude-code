import { resolve as resolvePath } from 'path'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Text } from '@anthropic/ink'
import { logEvent } from '../services/analytics/index.js'
import { getCwd } from '../utils/cwd.js'
import { openFileInExternalEditor } from '../utils/editor.js'
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js'
import { highlightMatch } from '../utils/highlightMatch.js'
import { relativePath } from '../utils/permissions/filesystem.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { ripGrepStream } from '../utils/ripgrep.js'
import { FuzzyPicker, LoadingState } from '@anthropic/ink'

type Props = {
  onDone: () => void
  onInsert: (text: string) => void
}

type Match = {
  file: string
  line: number
  text: string
}

const VISIBLE_RESULTS = 12
const DEBOUNCE_MS = 100
const PREVIEW_CONTEXT_LINES = 4
// rg -m 是按文件的；我们也限制解析后的数组大小以保持内存有界。
const MAX_MATCHES_PER_FILE = 10
const MAX_TOTAL_MATCHES = 500

/**
 * 全局搜索对话框（ctrl+shift+f / cmd+shift+f）。
 * 对工作区进行带防抖的 ripgrep 搜索。
 */
export function GlobalSearchDialog({
  onDone,
  onInsert,
}: Props): React.ReactNode {
	useRegisterOverlay("global-search");
	const { columns, rows } = useTerminalSize();
	const previewOnRight = columns >= 140;
	// Chrome（标题 + 搜索 + matchLabel + 提示 + 窗格边框 + 间隙）
	// 占用约 14 行。在短终端上缩小列表以避免对话框被裁剪。
	const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));

	const [matches, setMatches] = useState<Match[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [isSearching, setIsSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [focused, setFocused] = useState<Match | undefined>(undefined);
	const [preview, setPreview] = useState<{
		file: string;
		line: number;
		content: string;
	} | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			abortRef.current?.abort();
		};
	}, []);

	// 加载焦点匹配周围的上下文行。AbortController 防止
	// 按住 ↓ 堆积读取。
	useEffect(() => {
		if (!focused) {
			setPreview(null);
			return;
		}
		const controller = new AbortController();
		const absolute = resolvePath(getCwd(), focused.file);
		const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1);
		void readFileInRange(
			absolute,
			start,
			PREVIEW_CONTEXT_LINES * 2 + 1,
			undefined,
			controller.signal,
		)
			.then((r) => {
				if (controller.signal.aborted) return;
				setPreview({
					file: focused.file,
					line: focused.line,
					content: r.content,
				});
			})
			.catch(() => {
				if (controller.signal.aborted) return;
				setPreview({
					file: focused.file,
					line: focused.line,
					content: "(preview unavailable)",
				});
			});
		return () => controller.abort();
	}, [focused]);

	const handleQueryChange = (q: string) => {
		setQuery(q);
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		abortRef.current?.abort();

		if (!q.trim()) {
			setMatches((m) => (m.length ? [] : m));
			setIsSearching(false);
			setTruncated(false);
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		setIsSearching(true);
		setTruncated(false);
		// 客户端在 rg 遍历时过滤现有结果 — 保持屏幕上
		// 有内容而不是闪烁空白。rg 结果被合并（按 file:line 去重）
		// 而不是替换，所以计数在查询中是单调的：它只在 rg 流式传输时增长，
		// 永远不会降到第一个块的大小。缩窄（新查询扩展旧查询）：
		// 过滤是精确的 — 任何匹配旧 -F -i 字面量的行都包含新查询当且仅当其文本
		// 包含新查询的小写形式。非缩窄（扩大/不同）：
		// 过滤是尽力而为的 — 可能短暂显示一个子集直到 rg 填充
		// 其余部分。
		const queryLower = q.toLowerCase();
		setMatches((m) => {
			const filtered = m.filter((match) =>
				match.text.toLowerCase().includes(queryLower),
			);
			return filtered.length === m.length ? m : filtered;
		});

		timeoutRef.current = setTimeout(
			(query, controller, setMatches, setTruncated, setIsSearching) => {
				// ripgrep 在给定绝对目标时输出绝对路径，所以
				// 相对于 cwd 进行相对化以在截断显示中保留目录上下文
				//（否则 cwd 前缀会占用宽度预算）。
				// relativePath() 返回 POSIX 标准化的输出，所以 truncatePathMiddle
				//（使用 lastIndexOf('/')）在 Windows 上也能正常工作。
				const cwd = getCwd();
				let collected = 0;
				void ripGrepStream(
					// -e 在查询以 '-' 开头时将模式与选项区分开来
					//（例如搜索 "--verbose" 或 "-rf"）。参见 GrepTool.ts 的
					// 相同预防措施。
					[
						"-n",
						"--no-heading",
						"-i",
						"-m",
						String(MAX_MATCHES_PER_FILE),
						"-F",
						"-e",
						query,
					],
					cwd,
					controller.signal,
					(lines) => {
						if (controller.signal.aborted) return;
						const parsed: Match[] = [];
						for (const line of lines) {
							const m = parseRipgrepLine(line);
							if (!m) continue;
							const rel = relativePath(cwd, m.file);
							parsed.push({
								...m,
								file: rel.startsWith("..") ? m.file : rel,
							});
						}
						if (!parsed.length) return;
						collected += parsed.length;
						setMatches((prev) => {
							// 追加+去重而不是替换：prev 可能包含对
							// 此查询有效的客户端过滤结果。
							// 替换会将计数降到这个块的大小然后增长回来 — 表现为闪烁。
							const seen = new Set(prev.map(matchKey));
							const fresh = parsed.filter(
								(p) => !seen.has(matchKey(p)),
							);
							if (!fresh.length) return prev;
							const next = prev.concat(fresh);
							return next.length > MAX_TOTAL_MATCHES
								? next.slice(0, MAX_TOTAL_MATCHES)
								: next;
						});
						if (collected >= MAX_TOTAL_MATCHES) {
							controller.abort();
							setTruncated(true);
							setIsSearching(false);
						}
					},
				)
					.catch(() => {})
					// 流关闭且零块 — 清除过时结果以
					// 使 "No matches" 渲染而不是上一个查询的列表。
					.finally(() => {
						if (controller.signal.aborted) return;
						if (collected === 0)
							setMatches((m) => (m.length ? [] : m));
						setIsSearching(false);
					});
			},
			DEBOUNCE_MS,
			q,
			controller,
			setMatches,
			setTruncated,
			setIsSearching,
		);
	};

	const listWidth = previewOnRight
		? Math.floor((columns - 10) * 0.5)
		: columns - 8;
	const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4));
	const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4);
	const previewWidth = previewOnRight
		? Math.max(40, columns - listWidth - 14)
		: columns - 6;

	const handleOpen = (m: Match) => {
		const opened = openFileInExternalEditor(
			resolvePath(getCwd(), m.file),
			m.line,
		);
		logEvent("tengu_global_search_select", {
			result_count: matches.length,
			opened_editor: opened,
		});
		onDone();
	};

	const handleInsert = (m: Match, mention: boolean) => {
		onInsert(mention ? `@${m.file}#L${m.line} ` : `${m.file}:${m.line} `);
		logEvent("tengu_global_search_insert", {
			result_count: matches.length,
			mention,
		});
		onDone();
	};

	// 始终传递非空字符串以保留该行 — 防止
	// 计数出现/消失时搜索框跳动。
	const matchLabel =
		matches.length > 0
			? `${matches.length}${truncated ? "+" : ""} matches${isSearching ? "…" : ""}`
			: " ";

	return (
		<FuzzyPicker
			title="Global Search"
			placeholder="Type to search…"
			items={matches}
			getKey={matchKey}
			visibleCount={visibleResults}
			direction="up"
			previewPosition={previewOnRight ? "right" : "bottom"}
			onQueryChange={handleQueryChange}
			onFocus={setFocused}
			onSelect={handleOpen}
			onTab={{ action: "mention", handler: (m) => handleInsert(m, true) }}
			onShiftTab={{
				action: "insert path",
				handler: (m) => handleInsert(m, false),
			}}
			onCancel={onDone}
			emptyMessage={(q) =>
				isSearching
					? "Searching…"
					: q
						? "No matches"
						: "Type to search…"
			}
			matchLabel={matchLabel}
			selectAction="open in editor"
			renderItem={(m, isFocused) => (
				<Text color={isFocused ? "suggestion" : undefined}>
					<Text dimColor>
						{truncatePathMiddle(m.file, maxPathWidth)}:{m.line}
					</Text>{" "}
					{highlightMatch(
						truncateToWidth(m.text.trimStart(), maxTextWidth),
						query,
					)}
				</Text>
			)}
			renderPreview={(m) =>
				preview?.file === m.file && preview.line === m.line ? (
					<>
						<Text dimColor>
							{truncatePathMiddle(m.file, previewWidth)}:{m.line}
						</Text>
						{preview.content.split("\n").map((line, i) => (
							<Text key={i}>
								{highlightMatch(
									truncateToWidth(line, previewWidth),
									query,
								)}
							</Text>
						))}
					</>
				) : (
					<LoadingState message="Loading…" dimColor />
				)
			}
		/>
	);
}

function matchKey(m: Match): string {
  return `${m.file}:${m.line}`
}

/**
 * 解析 ripgrep -n --no-heading 输出行："path:line:text"。
 * Windows 路径可能包含驱动器号（"C:\..."），所以简单的
 * 第一次冒号分割会破坏路径 — 使用匹配到
 * 第一个 :<digits>: 的正则表达式。
 * @internal 导出用于测试
 */
export function parseRipgrepLine(line: string): Match | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  if (!m) return null
  const [, file, lineStr, text] = m
  const lineNum = Number(lineStr)
  if (!file || !Number.isFinite(lineNum)) return null
  return { file, line: lineNum, text: text ?? '' }
}
