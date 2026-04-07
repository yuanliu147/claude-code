import { setMaxListeners } from 'events'

/**
 * 标准操作的最大监听器数量默认值
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * 创建具有适当事件监听器限制的 AbortController。
 * 当多个监听器附加到中止信号时，这可以防止 MaxListenersExceededWarning。
 *
 * @param maxListeners - 最大监听器数量（默认：50）
 * @returns 配置了监听器限制的 AbortController
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * 将中止从父级传播到弱引用的子控制器。
 * 父级和子级都是弱持有的 — 任何方向都不会创建可能阻止 GC 的强引用。
 * 模块作用域函数避免每次调用分配闭包。
 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * 从弱引用的父信号中移除中止处理程序。
 * 父级和处理程序都是弱持有的 — 如果任一已被 GC'd 或父级已中止（{once: true}），
 * 这是个空操作。
 * 模块作用域函数避免每次调用分配闭包。
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * 创建在父级中止时也会中止的子 AbortController。
 * 中止子级不会影响父级。
 *
 * 内存安全：使用 WeakRef，这样父级不会保留被放弃的子级。
 * 如果子级在未被中止的情况下被丢弃，它仍然可以被 GC。
 * 当子级确实被中止时，父级监听器会被移除以防止死处理程序的积累。
 *
 * @param parent - 父级 AbortController
 * @param maxListeners - 最大监听器数量（默认：50）
 * @returns 子级 AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // 快速路径：父级已中止，无需设置监听器
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef 防止父级保留被放弃的子级。
  // 如果对子级的所有强引用都被丢弃而没有中止它，
  // 子级仍然可以被 GC — 父级只持有死掉的 WeakRef。
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // 自动清理：当子级被中止时（来自任何源）移除父级监听器。
  // 父级和处理程序都是弱持有的 — 如果任一已被 GC'd 或
  // 父级已中止（{once: true}），清理是一个无害的空操作。
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}
