import type { RefObject } from 'react'
import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ScrollBoxHandle, DOMElement } from '@anthropic/ink'

/**
 * 对尚未测量的项目估计的高度（行）。故意偏低：
 * 高估会导致空白空间（我们停止挂载太早，viewport 底部显示空 spacer），
 * 而低估只会将一些额外项目挂载到 overscan。不对称性意味着我们宁愿偏低。
 */
const DEFAULT_ESTIMATE = 3
/**
 * 在视口上下方额外渲染的行数。因为实际
 * 高度对于长工具结果可能是估计值的 10 倍，所以慷慨设置。
 */
const OVERSCAN_ROWS = 80
/** 在 ScrollBox 布局之前渲染的项目数（viewportHeight=0）。 */
const COLD_START_COUNT = 30
/**
 * 用于 useSyncExternalStore 快照的 scrollTop 量化。没有
 * 这个，每个滚轮刻度（每个凹口 3-5 个）触发完整的 React commit +
 * Yoga calculateLayout() + Ink diff 循环 — CPU 峰值。无论如何视觉滚动
 * 保持流畅：ScrollBox.forceRender 在每次 scrollBy 时触发，
 * Ink 从 DOM 节点读取真实的 scrollTop，独立于 React 认为的值。
 * React 仅在挂载范围必须移动时需要重新渲染；OVERSCAN_ROWS 的一半是最紧密的安全区间
 * （保证在新范围需要之前有 ≥40 行 overscan）。
 */
const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1
/**
 * 计算覆盖率时假设未测量项目的最坏情况高度。
 * MessageRow 可能小到 1 行（单行工具调用）。在这里使用 1
 * 保证挂载范围在物理上到达视口底部，
 * 无论项目实际有多小 — 代价是当项目较大时过度挂载
 * （没关系，overscan 会吸收它）。
 */
const PESSIMISTIC_HEIGHT = 1
/** 挂载项目的上限，即使在退化情况下也限制 fiber 分配。 */
const MAX_MOUNTED_ITEMS = 300
/**
 * 在单个 commit 中挂载的最大新项目数。使用 PESSIMISTIC_HEIGHT=1 滚动到新范围
 * 会一次挂载 194 个项目（OVERSCAN_ROWS*2+ viewportH = 194）；每个新的 MessageRow 渲染
 * 耗时约 1.5ms（marked lexer + formatToken + ~11 createInstance）= ~290ms 同步块。
 * 在多个 commit 中将范围滑动到目标，保持每次 commit 挂载成本有限。
 * 渲染时限制（scrollClampMin/Max）在挂载内容边缘保持视口，
 * 以便在追赶期间没有空白。
 */
const SLIDE_STEP = 25

const NOOP_UNSUB = () => {}

export type VirtualScrollResult = {
  /** [startIndex, endIndex) half-open slice of items to render. */
  range: readonly [number, number]
  /** Height (rows) of spacer before the first rendered item. */
  topSpacer: number
  /** Height (rows) of spacer after the last rendered item. */
  bottomSpacer: number
  /**
   * Callback ref factory. Attach `measureRef(itemKey)` to each rendered
   * item's root Box; after Yoga layout, the computed height is cached.
   */
  measureRef: (key: string) => (el: DOMElement | null) => void
  /**
   * Attach to the topSpacer Box. Its Yoga computedTop IS listOrigin
   * (first child of the virtualized region, so its top = cumulative
   * height of everything rendered before the list in the ScrollBox).
   * Drift-free: no subtraction of offsets, no dependence on item
   * heights that change between renders (tmux resize).
   */
  spacerRef: RefObject<DOMElement | null>
  /**
   * Cumulative y-offset of each item in list-wrapper coords (NOT scrollbox
   * coords — logo/siblings before this list shift the origin).
   * offsets[i] = rows above item i; offsets[n] = totalHeight.
   * Recomputed every render — don't memo on identity.
   */
  offsets: ArrayLike<number>
  /**
   * Read Yoga computedTop for item at index. Returns -1 if the item isn't
   * mounted or hasn't been laid out. Item Boxes are direct Yoga children
   * of the ScrollBox content wrapper (fragments collapse in the Ink DOM),
   * so this is content-wrapper-relative — same coordinate space as
   * scrollTop. Yoga layout is scroll-independent (translation happens
   * later in renderNodeToOutput), so positions stay valid across scrolls
   * without waiting for Ink to re-render. StickyTracker walks the mount
   * range with this to find the viewport boundary at per-scroll-tick
   * granularity (finer than the 40-row quantum this hook re-renders at).
   */
  getItemTop: (index: number) => number
  /**
   * Get the mounted DOMElement for item at index, or null. For
   * ScrollBox.scrollToElement — anchoring by element ref defers the
   * Yoga-position read to render time (deterministic; no throttle race).
   */
  getItemElement: (index: number) => DOMElement | null
  /** 已测量的 Yoga 高度。undefined = 尚未测量；0 = 渲染为空。 */
  getItemHeight: (index: number) => number | undefined
  /**
   * 滚动以使项目 `i` 在挂载范围内。设置 scrollTop =
   * offsets[i] + listOrigin。范围逻辑从 scrollTop 与 offsets[] 找到 start —
   * 两者使用相同的 offsets 值，所以无论 offsets[i] 是否是"真实"位置，
   * 它们按构造一致。项目 i 挂载；其屏幕位置可能偏差几十行
   * （overscan 估计漂移的价值），但它在 DOM 中。使用 getItemTop(i) 获取精确位置。
   */
  scrollToIndex: (i: number) => void
}

/**
 * ScrollBox 内部项目的 React 级虚拟化。
 *
 * ScrollBox 已经做了 Ink-output 级视口裁剪
 * （render-node-to-output.ts:617 跳过可见窗口外的子元素），
 * 但所有 React fibers + Yoga 节点仍然被分配。在每个 MessageRow ~250 KB RSS 时，
 * 1000 条消息的会话成本约 250 MB 增长内存
 * （Ink 屏幕缓冲区，WASM 线性内存，JSC 页面保留都是增长内存）。
 *
 * 此 hook 仅挂载视口 + overscan 中的项目。Spacer boxes 以 O(1) fiber 成本保持其余的滚动高度恒定。
 *
 * 高度估计：对未测量项目使用固定的 DEFAULT_ESTIMATE，
 * 在首次布局后被真实 Yoga 高度替换。无滚动锚定 — overscan
 * 吸收估计错误。如果实践中漂移明显，锚定
 * （当 topSpacer 改变时 scrollBy(delta)）是直接的跟进。
 *
 * stickyScroll 注意事项：render-node-to-output.ts:450 在 Ink 渲染阶段设置 scrollTop=maxScroll，
 * 这不会触发 ScrollBox.subscribe。下面的 at-bottom 检查处理这个 — 当固定到底部时，
 * 我们渲染最后 N 个项目，不管 scrollTop 声称什么。
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  /**
   * 终端列数。变化时，缓存的高度是陈旧的（文本
   * 重新换行） — 按 oldCols/newCols 缩放而不是清除。清除
   * 会使悲观覆盖率回退挂载约 190 个项目（每个
   * 未缓存项 → PESSIMISTIC_HEIGHT=1 → 回退 190 以到达
   * viewport+2×overscan）。每个新的挂载运行 marked.lexer + 语法
   * 高亮约 3ms；~600ms React 在有长会话的首次调整大小时协调。缩放保持 heightCache 填充 → 回退
   * 使用真实-ish 高度 → 挂载范围保持紧凑。缩放估计
   * 在下一次 useLayoutEffect 被真实 Yoga 高度覆盖。
   *
   * 缩放高度足够接近，以至于黑屏-宽化 bug
   * （膨胀的调整前偏移量超过调整后 scrollTop → 末尾
   * 循环停在尾部之前）不会触发：宽化时 ratio<1 按比例
   * 缩小高度，保持偏移量与调整后 Yoga 大致对齐。
   */
  columns: number,
): VirtualScrollResult {
  const heightCache = useRef(new Map<string, number>())
  // 每次 heightCache 变化时递增，以便在下次读取时重建 offsets。Ref
  //（不是 state）— 在渲染阶段检查，零额外 commits。
  const offsetVersionRef = useRef(0)
  // 上一次 commit 的 scrollTop，用于检测快速滚动模式（滑动上限门控）。
  const offsetsRef = useRef<{ arr: Float64Array; version: number; n: number }>({
    arr: new Float64Array(0),
    version: -1,
    n: -1,
  })
  const itemRefs = useRef(new Map<string, DOMElement>())
  const refCache = useRef(new Map<string, (el: DOMElement | null) => void>())
  // Inline ref-compare: must run before offsets is computed below. The
  // skip-flag guards useLayoutEffect from re-populating heightCache with
  // PRE-resize Yoga heights (useLayoutEffect reads Yoga from the frame
  // BEFORE this render's calculateLayout — the one that had the old width).
  // Next render's useLayoutEffect reads post-resize Yoga → correct.
  const prevColumns = useRef(columns)
  const skipMeasurementRef = useRef(false)
  // Freeze the mount range for the resize-settling cycle. Already-mounted
  // items have warm useMemo (marked.lexer, highlighting); recomputing range
  // from scaled/pessimistic estimates causes mount/unmount churn (~3ms per
  // fresh mount = ~150ms visible as a second flash). The pre-resize range is
  // as good as any — items visible at old width are what the user wants at
  // new width. Frozen for 2 renders: render #1 has skipMeasurement (Yoga
  // still pre-resize), render #2's useLayoutEffect reads post-resize Yoga
  // into heightCache. Render #3 has accurate heights → normal recompute.
  const prevRangeRef = useRef<readonly [number, number] | null>(null)
  const freezeRendersRef = useRef(0)
  if (prevColumns.current !== columns) {
    const ratio = prevColumns.current / columns
    prevColumns.current = columns
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)))
    }
    offsetVersionRef.current++
    skipMeasurementRef.current = true
    freezeRendersRef.current = 2
  }
  const frozenRange = freezeRendersRef.current > 0 ? prevRangeRef.current : null
  // List origin in content-wrapper coords. scrollTop is content-wrapper-
  // relative, but offsets[] are list-local (0 = first virtualized item).
  // Siblings that render BEFORE this list inside the ScrollBox — Logo,
  // StatusNotices, truncation divider in Messages.tsx — shift item Yoga
  // positions by their cumulative height. Without subtracting this, the
  // non-sticky branch's effLo/effHi are inflated and start advances past
  // 项实际在视口中（空白视口时点击/滚动
  // sticky 在 scrollTop 接近 max 时断开）。从 topSpacer 的
  // Yoga computedTop 读取 — 它是虚拟化区域的第一个子元素，所以
  // 它的 top 就是 listOrigin。不减去偏移量 → 当项
  // 高度在渲染之间变化时无漂移（tmux 调整大小：列变化 → 重新换行
  // → 高度缩小 → 旧的项采样减去变为负 →
  // effLo 膨胀 → 黑屏）。与 heightCache 一样的单帧滞后。
  const listOriginRef = useRef(0)
  const spacerRef = useRef<DOMElement | null>(null)

  // useSyncExternalStore 将重新渲染绑定到命令式滚动。快照是
  // 量化到 SCROLL_QUANTUM 区间的 scrollTop — Object.is 对于小滚动看不到变化
  // （大多数滚轮刻度），所以 React 完全跳过 commit + Yoga
  // + Ink 循环，直到累积增量穿过一个区间。
  // Sticky 被折叠到快照中（符号位），所以 sticky→broken 也
  // 触发：scrollToBottom 设置 sticky=true 而不移动 scrollTop
  // （Ink 稍后移动它），第一次 scrollBy 后可能落在同一区间。NaN 哨兵 = ref 未附加。
  const subscribe = useCallback(
    (listener: () => void) =>
      scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) return NaN
    // Snapshot uses the TARGET (scrollTop + pendingDelta), not committed
    // scrollTop. scrollBy only mutates pendingDelta (renderer drains it
    // across frames); committed scrollTop lags. Using target means
    // notify() on scrollBy actually changes the snapshot → React remounts
    // children for the destination before Ink's drain frames need them.
    const target = s.getScrollTop() + s.getPendingDelta()
    const bin = Math.floor(target / SCROLL_QUANTUM)
    return s.isSticky() ? ~bin : bin
  })
  // Read the REAL committed scrollTop (not quantized) for range math —
  // quantization is only the re-render gate, not the position.
  const scrollTop = scrollRef.current?.getScrollTop() ?? -1
  // Range must span BOTH committed scrollTop (where Ink is rendering NOW)
  // and target (where pending will drain to). During drain, intermediate
  // frames render at scrollTops between the two — if we only mount for
  // the target, those frames find no children (blank rows).
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0
  const viewportH = scrollRef.current?.getViewportHeight() ?? 0
  // True means the ScrollBox is pinned to the bottom. This is the ONLY
  // stable "at bottom" signal: scrollTop/scrollHeight both reflect the
  // PREVIOUS render's layout, which depends on what WE rendered (topSpacer +
  // items), creating a feedback loop (range → layout → atBottom → range).
  // stickyScroll is set by user action (scrollToBottom/scrollBy), the initial
  // attribute, AND by render-node-to-output when its positional follow fires
  // (scrollTop>=prevMax → pin to new max → set flag). The renderer write is
  // feedback-safe: it only flips false→true, only when already at the
  // positional bottom, and the flag being true here just means "tail-walk,
  // clear clamp" — the same behavior as if we'd read scrollTop==maxScroll
  // directly, minus the instability. Default true: before the ref attaches,
  // assume bottom (sticky will pin us there on first Ink render).
  const isSticky = scrollRef.current?.isSticky() ?? true

  // GC stale cache entries (compaction, /clear, screenToggleId bump). Only
  // runs when itemKeys identity changes — scrolling doesn't touch keys.
  // itemRefs self-cleans via ref(null) on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  useMemo(() => {
    const live = new Set(itemKeys)
    let dirty = false
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) {
        heightCache.current.delete(k)
        dirty = true
      }
    }
    for (const k of refCache.current.keys()) {
      if (!live.has(k)) refCache.current.delete(k)
    }
    if (dirty) offsetVersionRef.current++
  }, [itemKeys])

  // Offsets cached across renders, invalidated by offsetVersion ref bump.
  // The previous approach allocated new Array(n+1) + ran n Map.get per
  // render; for n≈27k at key-repeat scroll rate (~11 commits/sec) that's
  // ~300k lookups/sec on a freshly-allocated array → GC churn + ~2ms/render.
  // Version bumped by heightCache writers (measureRef, resize-scale, GC).
  // No setState — the rebuild is read-side-lazy via ref version check during
  // render (same commit, zero extra schedule). The flicker that forced
  // inline-recompute came from setState-driven invalidation.
  const n = itemKeys.length
  if (
    offsetsRef.current.version !== offsetVersionRef.current ||
    offsetsRef.current.n !== n
  ) {
    const arr =
      offsetsRef.current.arr.length >= n + 1
        ? offsetsRef.current.arr
        : new Float64Array(n + 1)
    arr[0] = 0
    for (let i = 0; i < n; i++) {
      arr[i + 1] =
        arr[i]! + (heightCache.current.get(itemKeys[i]!) ?? DEFAULT_ESTIMATE)
    }
    offsetsRef.current = { arr, version: offsetVersionRef.current, n }
  }
  const offsets = offsetsRef.current.arr
  const totalHeight = offsets[n]!

  let start: number
  let end: number

  if (frozenRange) {
    // 列刚改变。保持调整前范围以避免挂载扰动。
    // 如果消息被移除（/clear、压缩），夹紧到 n。
    ;[start, end] = frozenRange
    start = Math.min(start, n)
    end = Math.min(end, n)
  } else if (viewportH === 0 || scrollTop < 0) {
    // 冷启动：ScrollBox 尚未布局。渲染尾部 — sticky
    // 滚动在第一次 Ink 渲染时固定到底部，所以这些是用户实际看到的内容。
    // 之后的任何向上滚动通过
    // scrollBy → subscribe 触发 → 我们用真实值重新渲染。
    start = Math.max(0, n - COLD_START_COUNT)
    end = n
  } else {
    if (isSticky) {
      // Sticky-scroll 回退。render-node-to-output 可能已移动 scrollTop
      // 而未通知我们，所以信任陈旧快照上的"在底部"。
      // 从尾部回退直到我们覆盖视口 + overscan。
      const budget = viewportH + OVERSCAN_ROWS
      start = n
      while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
        start--
      }
      end = n
    } else {
      // 用户已向上滚动。从 offsets 计算 start（基于估计：
      // 可能低估，没关系 — 我们只是早点开始挂载）。
      // 然后按累积最佳已知高度扩展 end，不是估计的
      // offsets。不变量是：
      //   topSpacer + sum(real_heights[start..end]) >= scrollTop + viewportH + overscan
      // 由于 topSpacer = offsets[start] ≤ scrollTop - overscan，我们需要：
      //   sum(real_heights) >= viewportH + 2*overscan
      // 对于未测量项，假设 PESSIMISTIC_HEIGHT=1 — MessageRow
      // 能达到的最小值。当项较大时这会过度挂载，但从不
      // 在快速滚动未测量区域时留下显示空 spacer 的视口。一旦高度被缓存（下一次渲染），
      // 用真实值计算覆盖率，范围收紧。
      // 仅在安全的情况下才将 start 提前越过项目 K。有两种安全情况：
      //   (a) K 当前未挂载（itemRefs 没有条目）。其
      //       对 offsets 的贡献始终是估计值 — spacer
      //       已经匹配那里的内容。无布局变化。
      //   (b) K 已挂载且其高度已缓存。offsets[start+1] 使用
      //       真实高度，所以 topSpacer = offsets[start+1] 正好
      //       等于 K 占用的 Yoga 跨度。无缝卸载。
      // 不安全情况 — K 已挂载但未缓存 — 是挂载
      // 和 useLayoutEffect 测量之间的一渲染窗口。保持 K
      // 多挂载一渲染让测量落地。
      // 挂载范围跨越 [committed, target]，所以每个排出帧
      // 都被覆盖。在 0 处夹紧：积极的向上滚可能推送 pendingDelta
      // 远超过零（MX Master 自由旋转），但 scrollTop 从不
      // 变负。没有夹紧，effLo 将 start 拖到 0 而 effHi
      // 保持在当前（高）scrollTop — 跨度超过
      // MAX_MOUNTED_ITEMS 能覆盖的范围，早期排出帧看到空白。
      // listOrigin 在与 offsets[] 比较之前将 scrollTop（内容包装坐标）转换到
      // 列表局部坐标。没有这个，列表前的同级（Messages.tsx 中的 Logo+通知）
      // 通过其高度膨胀 scrollTop，start 过度前进 — 先消耗 overscan，
      // 然后一旦膨胀超过 OVERSCAN_ROWS 就消耗可见行。
      const listOrigin = listOriginRef.current
      // 限制 [committed..target] 跨度。当输入超过渲染时，
      // pendingDelta 无界增长 → effLo..effHi 覆盖数百个
      // 未挂载行 → 一次 commit 挂载 194 个新 MessageRows → 3s+
      // 同步块 → 更多输入队列 → 下次更大增量。死亡
      // 螺旋。限制跨度限制每次 commit 的新挂载数；限制
      //（setClampBounds）在追赶期间显示挂载内容的边缘，所以
      // 没有黑屏 — 滚动在几帧而不是冻结数秒后达到目标。
      const MAX_SPAN_ROWS = viewportH * 3
      const rawLo = Math.min(scrollTop, scrollTop + pendingDelta)
      const rawHi = Math.max(scrollTop, scrollTop + pendingDelta)
      const span = rawHi - rawLo
      const clampedLo =
        span > MAX_SPAN_ROWS
          ? pendingDelta < 0
            ? rawHi - MAX_SPAN_ROWS // 向上滚动：保持在目标附近（低端）
            : rawLo // 向下滚动：保持在已提交附近
          : rawLo
      const clampedHi = clampedLo + Math.min(span, MAX_SPAN_ROWS)
      const effLo = Math.max(0, clampedLo - listOrigin)
      const effHi = clampedHi - listOrigin
      const lo = effLo - OVERSCAN_ROWS
      // 二分搜索 start — offsets 是单调递增的。之前
      // 的线性 while(start++) 扫描对于 27k-msg 会话
      // 每次渲染迭代约 27k 次（从底部滚动，start≈27200）。O(log n)。
      {
        let l = 0
        let r = n
        while (l < r) {
          const m = (l + r) >> 1
          if (offsets[m + 1]! <= lo) l = m + 1
          else r = m
        }
        start = l
      }
      // 守卫：不要将已挂载但未测量的项向前推进。在
      // 挂载和 useLayoutEffect 测量之间的一渲染窗口期间，
      // 卸载这些项会在 topSpacer 中使用 DEFAULT_ESTIMATE，
      // 这与它们（未知）真实跨度不匹配 → 闪烁。已挂载
      // 项在 [prevStart, prevEnd) 中；扫描那个，不是全部 n。
      {
        const p = prevRangeRef.current
        if (p && p[0] < start) {
          for (let i = p[0]; i < Math.min(start, p[1]); i++) {
            const k = itemKeys[i]!
            if (itemRefs.current.has(k) && !heightCache.current.has(k)) {
              start = i
              break
            }
          }
        }
      }

      const needed = viewportH + 2 * OVERSCAN_ROWS
      const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS)
      let coverage = 0
      end = start
      while (
        end < maxEnd &&
        (coverage < needed || offsets[end]! < effHi + viewportH + OVERSCAN_ROWS)
      ) {
        coverage +=
          heightCache.current.get(itemKeys[end]!) ?? PESSIMISTIC_HEIGHT
        end++
      }
    }
    // atBottom 路径相同的覆盖率保证（它通过估计的
    // offsets 回退 start，如果项较小则可能低估）。
    const needed = viewportH + 2 * OVERSCAN_ROWS
    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS)
    let coverage = 0
    for (let i = start; i < end; i++) {
      coverage += heightCache.current.get(itemKeys[i]!) ?? PESSIMISTIC_HEIGHT
    }
    while (start > minStart && coverage < needed) {
      start--
      coverage +=
        heightCache.current.get(itemKeys[start]!) ?? PESSIMISTIC_HEIGHT
    // both scrollBy (pendingDelta) and scrollTo (direct write)。常规
    // 单 PageUp 或 sticky-break 跳跃跳过这个。限制
    //（setClampBounds）在追赶期间保持视口在挂载边缘。仅限制范围 GROWTH；缩小是无界的。
    const prev = prevRangeRef.current
    const scrollVelocity =
      Math.abs(scrollTop - lastScrollTopRef.current) + Math.abs(pendingDelta)
    if (prev && scrollVelocity > viewportH * 2) {
      const [pS, pE] = prev
      if (start < pS - SLIDE_STEP) start = pS - SLIDE_STEP
      if (end > pE + SLIDE_STEP) end = pE + SLIDE_STEP
      // 大的前进跳跃可以将 start 推到受限的 end 之外（start
      // 通过二分搜索前进而 end 受限于 pE + SLIDE_STEP）。
      // 从新 start 挂载 SLIDE_STEP 个项，这样在追赶期间视口不是空白的。
      if (start > end) end = Math.min(start + SLIDE_STEP, n)
    }
    lastScrollTopRef.current = scrollTop
  }

  // 在范围计算后递减冻结。不要在冻结期间更新 prevRangeRef
  // 以便两个冻结渲染重用原始调整前范围（不是消息在冻结中改变时的 clamp-to-n 版本）。
  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--
  } else {
    prevRangeRef.current = [start, end]
  }
  // useDeferredValue 让 React 先用旧范围渲染（便宜 —
  // 所有 memo 命中）然后转换到新范围（昂贵 — 带 marked.lexer + formatToken 的新挂载）。紧急渲染让 Ink 以输入速率继续绘制；新挂载在非阻塞后台渲染中发生。这是 React 原生时间切片：62ms 新挂载块变得可中断。限制（setClampBounds）已经处理视口固定，所以没有来自延迟范围短暂落后于 scrollTop 的视觉伪影。
  //
  // 仅延迟范围 GROWTH（start 向前移动 / end 向后移动添加新挂载）。缩小是便宜的（卸载 = 移除 fiber，无解析），延迟值落后缩小会导致陈旧 overscan 多挂载一个 tick — 无害但会导致测试失败精确检查测量驱动收紧后的范围。
  const dStart = useDeferredValue(start)
  const dEnd = useDeferredValue(end)
  let effStart = start < dStart ? dStart : start
  let effEnd = end > dEnd ? dEnd : end
  // 大的跳跃可以使 effStart > effEnd（start 向前跳跃而 dEnd
  // 仍持有旧范围 end）。跳过延迟以避免倒置范围。sticky 时也跳过 — scrollToBottom 需要现在挂载尾部以便 scrollTop=maxScroll 落在内容上，而不是 bottomSpacer。延迟的 dEnd（仍在旧范围）会渲染不完整的尾部，maxScroll 保持在旧内容高度，"跳到底部"停止太短。Sticky  snap 是单帧，不是连续滚动 — 时间切片好处不适用。
  if (effStart > effEnd || isSticky) {
    effStart = start
    effEnd = end
  }
  // 向下滚动（pendingDelta > 0）：绕过 effEnd 延迟以便尾部立即挂载。没有这个，基于 effEnd 的限制将 scrollTop 保持在真实底部以下 — 用户向下滚动，碰到 clampMax，停止，React 追赶 effEnd，clampMax 扩大，但用户已释放。感觉停在底部之前。effStart 保持延迟以便向上滚动继续时间切片（旧消息在挂载时解析 — 昂贵方向）。
  if (pendingDelta > 0) {
    effEnd = end
  }
  // 最终 O(视口)强制执行。中间限制（maxEnd=start+ MAX_MOUNTED_ITEMS、滑动限制、延迟交叉）约束 [start,end]，但上面的延迟+绕过组合可能让 [effStart,effEnd] 滑出：例如在持续 PageUp 期间，当并发模式交叉 dStart 更新与跨 commit 的 effEnd=end 绕过时，有效窗口可能比单独立即或延迟都漂移更宽。在 10K 行恢复会话中，这表现为 PageUp 期间 +270MB RSS（yoga Node 构造函数 + createWorkInProgress fiber 分配与滚动距离成正比）。按视口位置修剪远端 — 无论延迟值调度如何保持 fiber 计数 O(视口)。
  if (effEnd - effStart > MAX_MOUNTED_ITEMS) {
    // 修剪端由视口位置决定，不是 pendingDelta 方向。pendingDelta 在帧之间排出到 0，而 dStart/dEnd 在并发调度下落后；基于方向的修剪然后在settle 中途从"修尾巴"翻转到"修头"，bump effStart → effTopSpacer → clampMin → setClampBounds 将 scrollTop 向下拉 → 滚动条消失。基于位置：保持视口更近的任一端。
    const mid = (offsets[effStart]! + offsets[effEnd]!) / 2
    if (scrollTop - listOriginRef.current < mid) {
      effEnd = effStart + MAX_MOUNTED_ITEMS
    } else {
      effStart = effEnd - MAX_MOUNTED_ITEMS
    }
  }

  // 在布局效果中写入渲染时限制边界（不是在渲染期间 — React 渲染期间修改 DOM 违反纯度）。render-node-to-output
  // 将 scrollTop 夹到此范围，以便与 React 异步重新渲染竞争的突发 scrollTo 调用显示挂载内容的边缘（最后/第一个可见消息）而不是空 spacer。
  //
  // 限制必须使用有效（延迟）范围，不是立即范围。快速滚动期间，立即 [start,end] 可能已覆盖新 scrollTop 位置，但子项仍在延迟（较旧）范围渲染。如果限制使用立即边界，render-node-to-output 中的排出门控看到 scrollTop 在限制内 → 排出超过延迟子项跨度 → 视口落在 spacer → 白闪烁。使用 effStart/effEnd 保持限制与实际挂载的内容同步。
  //
  // sticky 时跳过限制 — render-node-to-output 权威地将 scrollTop=maxScroll 固定。在冷启动/加载期间限制导致闪烁：第一渲染使用基于估计的偏移量，设置限制，sticky-follow 移动 scrollTop，测量触发，偏移量用真实高度重建，第二渲染的限制不同 → scrollTop 限制调整 → 内容移动。
  const listOrigin = listOriginRef.current
  const effTopSpacer = offsets[effStart]!
  // 在 effStart=0 时，上面没有未挂载内容 — 限制必须允许滚动超过 listOrigin 以查看在 ScrollBox 中但 VirtualMessageList 外部的前列表内容（logo、header）。仅在 topSpacer 非零时限制（有未挂载项在上方）。
  const clampMin = effStart === 0 ? 0 : effTopSpacer + listOrigin
  // 在 effEnd=n 时，没有 bottomSpacer — 没有要避免竞争超过的内容。在这里使用 offsets[n] 会使 heightCache 固化（比 Yoga 晚一渲染），当尾部项正在流式传输时，其缓存高度比上次测量以来的到达量落后。Sticky-break 然后将 scrollTop 限制在真实最大值以下，将流式文本推出视口（"向上滚动，响应消失"bug）。Infinity = 无界：render-node-to-output 自己的 Math.min(cur, maxScroll) 改为管理。
  const clampMax =
    effEnd === n
      ? Infinity
      : Math.max(effTopSpacer, offsets[effEnd]! - viewportH) + listOrigin
  useLayoutEffect(() => {
    if (isSticky) {
      scrollRef.current?.setClampBounds(undefined, undefined)
    } else {
      scrollRef.current?.setClampBounds(clampMin, clampMax)
    }
  })

  // 从上一次 Ink 渲染测量高度。每 commit 运行（无 deps）因为 Yoga 重新计算布局而 React 不知道。已挂载 ≥1 帧的项的 yogaNode 高度有效；全新项尚未布局（发生在 resetAfterCommit → onRender，此效果之后）。
  //
  // 区分 "h=0: Yoga 未运行"（瞬态，跳过）和 "h=0: MessageRow 渲染为空"（永久，缓存它）：getComputedWidth() > 0 证明 Yoga 已布局此节点（宽度来自容器，对于列中的 Box 始终非零）。如果宽度已设置且高度为 0，该项确实是空的 — 缓存 0 以便起始前进门控不会永远阻塞它。没有这个，开始边界处的空渲染消息会在向上滚动后向下滚动时冻结范围（视口空白）。
  //
  // 无 setState。这里的 setState 会安排具有偏移量变化的第二次 commit，而 Ink 在每次 commit 时写入 stdout（reconciler.resetAfterCommit → onRender），两次写入具有不同的 spacer 高度 → 可见闪烁。高度在下次自然渲染时传播到 offsets。单帧延迟，被 overscan 吸收。
  useLayoutEffect(() => {
    const spacerYoga = spacerRef.current?.yogaNode
    if (spacerYoga && spacerYoga.getComputedWidth() > 0) {
      listOriginRef.current = spacerYoga.getComputedTop()
    }
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false
      return
    }
    let anyChanged = false
    for (const [key, el] of itemRefs.current) {
      const yoga = el.yogaNode
      if (!yoga) continue
      const h = yoga.getComputedHeight()
      const prev = heightCache.current.get(key)
      if (h > 0) {
        if (prev !== h) {
          heightCache.current.set(key, h)
          anyChanged = true
        }
      } else if (yoga.getComputedWidth() > 0 && prev !== 0) {
        heightCache.current.set(key, 0)
        anyChanged = true
      }
    }
    if (anyChanged) offsetVersionRef.current++
  })

  // 稳定的每键回调 refs。React 的 ref 交换舞蹈（old(null) 然后
  // new(el)) 当回调是身份稳定时是空操作，避免
  // 每次渲染时 itemRefs 扰动。与上面 heightCache 一起 GC'd。
  // ref(null) 路径也在卸载时捕获高度 — yogaNode
  // 那时仍然有效（reconciler 在 removeChild 之前调用 ref(null) →
  // freeRecursive），所以我们在 WASM 释放前获得最终测量。
  const measureRef = useCallback((key: string) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) {
          itemRefs.current.set(key, el)
        } else {
          const yoga = itemRefs.current.get(key)?.yogaNode
          if (yoga && !skipMeasurementRef.current) {
            const h = yoga.getComputedHeight()
            if (
              (h > 0 || yoga.getComputedWidth() > 0) &&
              heightCache.current.get(key) !== h
            ) {
              heightCache.current.set(key, h)
              offsetVersionRef.current++
            }
          }
          itemRefs.current.delete(key)
        }
      }
      refCache.current.set(key, fn)
    }
    return fn
  }, [])

  const getItemTop = useCallback(
    (index: number) => {
      const yoga = itemRefs.current.get(itemKeys[index]!)?.yogaNode
      if (!yoga || yoga.getComputedWidth() === 0) return -1
      return yoga.getComputedTop()
    },
    [itemKeys],
  )

  const getItemElement = useCallback(
    (index: number) => itemRefs.current.get(itemKeys[index]!) ?? null,
    [itemKeys],
  )
  const getItemHeight = useCallback(
    (index: number) => heightCache.current.get(itemKeys[index]!),
    [itemKeys],
  )
  const scrollToIndex = useCallback(
    (i: number) => {
      // offsetsRef.current holds latest cached offsets (event handlers run
      // between renders; a render-time closure would be stale).
      const o = offsetsRef.current
      if (i < 0 || i >= o.n) return
      scrollRef.current?.scrollTo(o.arr[i]! + listOriginRef.current)
    },
    [scrollRef],
  )

  const effBottomSpacer = totalHeight - offsets[effEnd]!

  return {
    range: [effStart, effEnd],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  }
}
