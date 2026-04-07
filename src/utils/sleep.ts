/**
 * 支持中止的睡眠。在 `ms` 毫秒后 resolve，或在 `signal` 中止时立即
 * resolve（这样退避循环就不会阻塞关闭）。
 *
 * 默认情况下，中止静默 resolve；调用方应在 await 后检查
 * `signal.aborted`。传递 `throwOnAbort: true` 以使
 * 中止 reject — 当睡眠在重试循环深处且你希望拒绝冒泡
 * 并取消整个操作时很有用。
 *
 * 传递 `abortError` 以自定义拒绝错误（隐含
 * `throwOnAbort: true`）。对于捕获特定错误类的重试循环很有用
 *（例如 `APIUserAbortError`）。
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  opts?: { throwOnAbort?: boolean; abortError?: () => Error; unref?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 在设置计时器之前检查中止状态。如果我们先定义
    // onAbort 并在这里同步调用它，它会在Temporal Dead Zone 中引用 `timer`。
    if (signal?.aborted) {
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
      return
    }
    const timer = setTimeout(
      (signal, onAbort, resolve) => {
        signal?.removeEventListener('abort', onAbort)
        void resolve()
      },
      ms,
      signal,
      onAbort,
      resolve,
    )
    function onAbort(): void {
      clearTimeout(timer)
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (opts?.unref) {
      timer.unref()
    }
  })
}

function rejectWithTimeout(reject: (e: Error) => void, message: string): void {
  reject(new Error(message))
}

/**
 * 将 promise 与超时竞争。如果 promise
 * 在 `ms` 毫秒内未解决，则用 `Error(message)` 拒绝。
 * 当 promise 解决时会清除超时计时器（没有挂起的计时器）
 * 并 unref，这样它就不会阻止进程退出。
 *
 * 注意：这不会取消底层工作 — 如果 promise
 * 由失控的异步操作支持，它会继续运行。这只是
 * 将控制权返回给调用方。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: REJECTS after ms (timeout guard)
    timer = setTimeout(rejectWithTimeout, ms, reject, message)
    if (typeof timer === 'object') timer.unref?.()
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
