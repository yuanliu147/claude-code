/**
 * 返回一个记忆化的工厂函数，在首次调用时构造值。
 * 用于将 Zod schema 的构造从模块初始化时间延迟到首次访问。
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => (cached ??= factory())
}
