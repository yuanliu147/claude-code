/**
 * 查询生命周期的同步状态机，与
 * React 的 `useSyncExternalStore` 兼容。
 *
 * 三种状态：
 *   idle        → 无查询，可以安全地出队和处理
 *   dispatching → 一个项已出队，异步链尚未到达 onQuery
 *   running     → 已调用 tryStart()，查询正在执行
 *
 * 转换：
 *   idle → dispatching  (reserve)
 *   dispatching → running  (tryStart)
 *   idle → running  (tryStart，用于直接用户提交)
 *   running → idle  (end / forceEnd)
 *   dispatching → idle  (cancelReservation，当 processQueueIfReady 失败时)
 *
 * `isActive` 对 dispatching 和 running 都返回 true，防止
 * 异步间隙期间的队列处理器重新进入。
 *
 * 与 React 一起使用：
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()

  /**
   * 为队列处理保留门控。转换 idle → dispatching。
   * 如果不是 idle 状态（另一个查询或调度正在进行）则返回 false。
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * 当 processQueueIfReady 没有可处理项时取消保留。
   * 转换 dispatching → idle。
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * 启动查询。成功时返回代数号，
   * 如果查询已在运行则返回 null（并发守卫）。
   * 接受来自 idle（直接用户提交）
   * 和 dispatching（队列处理器路径）的转换。
   */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._notify()
    return this._generation
  }

  /**
   * 结束查询。如果此代数仍然是当前的则返回 true
   *（意味着调用方应该执行清理）。如果
   * 较新的查询已启动（已取消查询的陈旧 finally 块）则返回 false。
   */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    this._notify()
    return true
  }

  /**
   * 强制结束当前查询，无论代数如何。
   * 由 onCancel 使用，任何正在运行的查询都应被终止。
   * 增加代数，以便被取消查询的 promise 拒绝的陈旧 finally 块
   * 将看到不匹配并跳过清理。
   */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
    this._notify()
  }

  /**
   * 门控是否活跃（dispatching 或 running）？
   * 始终是同步的 — 不受 React 状态批处理延迟影响。
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  // --
  // useSyncExternalStore 接口

  /** 订阅状态变更。稳定引用 — 可安全用作 useEffect 依赖。 */
  subscribe = this._changed.subscribe

  /** useSyncExternalStore 的快照。返回 `isActive`。 */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  private _notify(): void {
    this._changed.emit()
  }
}
