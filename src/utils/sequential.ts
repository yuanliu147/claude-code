type QueueItem<T extends unknown[], R> = {
  args: T
  resolve: (value: R) => void
  reject: (reason?: unknown) => void
  context: unknown
}

/**
 * 为异步函数创建顺序执行包装器以防止竞态条件。
 * 确保对包装函数的并发调用按接收顺序一次执行一个，
 * 同时保留正确的返回值。
 *
 * 这对于必须顺序执行的操作很有用，例如
 * 文件写入或数据库更新，如果并发执行可能会导致冲突。
 *
 * @param fn - 要包装为顺序执行的异步函数
 * @returns 包装后的函数版本，按顺序执行调用
 */
export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  const queue: QueueItem<T, R>[] = []
  let processing = false

  async function processQueue(): Promise<void> {
    if (processing) return
    if (queue.length === 0) return

    processing = true

    while (queue.length > 0) {
      const { args, resolve, reject, context } = queue.shift()!

      try {
        const result = await fn.apply(context, args)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    processing = false

    // 检查在处理过程中是否有新项目被添加
    if (queue.length > 0) {
      void processQueue()
    }
  }

  return function (this: unknown, ...args: T): Promise<R> {
    return new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject, context: this })
      void processQueue()
    })
  }
}
