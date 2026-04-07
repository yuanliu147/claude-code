/**
 * 固定大小的循环缓冲区，当缓冲区满时自动清除最旧的项。
 * 用于维护数据的滚动窗口。
 */
export class CircularBuffer<T> {
  private buffer: T[]
  private head = 0
  private size = 0

  constructor(private capacity: number) {
    this.buffer = new Array(capacity)
  }

  /**
   * 向缓冲区添加一个项。如果缓冲区已满，
   * 最旧的项将被清除。
   */
  add(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) {
      this.size++
    }
  }

  /**
   * 一次向缓冲区添加多个项。
   */
  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  /**
   * 从缓冲区获取最近的 N 个项。
   * 如果缓冲区包含少于 N 个项，则返回较少的项。
   */
  getRecent(count: number): T[] {
    const result: T[] = []
    const start = this.size < this.capacity ? 0 : this.head
    const available = Math.min(count, this.size)

    for (let i = 0; i < available; i++) {
      const index = (start + this.size - available + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * 获取缓冲区中当前的所有项，按从最旧到最新的顺序排列。
   */
  toArray(): T[] {
    if (this.size === 0) return []

    const result: T[] = []
    const start = this.size < this.capacity ? 0 : this.head

    for (let i = 0; i < this.size; i++) {
      const index = (start + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * 清除缓冲区中的所有项。
   */
  clear(): void {
    this.buffer.length = 0
    this.head = 0
    this.size = 0
  }

  /**
   * 获取缓冲区中当前项的数量。
   */
  length(): number {
    return this.size
  }
}
