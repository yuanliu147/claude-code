import { type DOMElement, useAnimationFrame, useTerminalFocus } from '@anthropic/ink'

const BLINK_INTERVAL_MS = 600

/**
 * 用于同步闪烁动画的 Hook，在屏幕外时暂停。
 *
 * 返回一个附加到动画元素的 ref 和当前的闪烁状态。
 * 所有实例一起闪烁，因为它们从同一个动画时钟派生状态。
 * 只有当至少有一个订阅者可见时，时钟才会运行。
 * 终端失焦时暂停。
 *
 * @param enabled - 闪烁是否激活
 * @returns [ref, isVisible] - 附加到元素的 ref，在闪烁周期中可见时为 true
 *
 * @example
 * function BlinkingDot({ shouldAnimate }) {
 *   const [ref, isVisible] = useBlink(shouldAnimate)
 *   return <Box ref={ref}>{isVisible ? '●' : ' '}</Box>
 * }
 */
export function useBlink(
  enabled: boolean,
  intervalMs: number = BLINK_INTERVAL_MS,
): [ref: (element: DOMElement | null) => void, isVisible: boolean] {
	const focused = useTerminalFocus();
	const [ref, time] = useAnimationFrame(
		enabled && focused ? intervalMs : null,
	);

	if (!enabled || !focused) return [ref, true];

	// 从时间派生闪烁状态 - 所有实例看到相同的时间因此同步
	const isVisible = Math.floor(time / intervalMs) % 2 === 0;
	return [ref, isVisible];
}
