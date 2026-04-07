/**
 * Promise.withResolvers() 的 polyfill（ES2024, Node 22+）。
 * package.json 声明了 "engines": { "node": ">=18.0.0" }，所以我们不能使用原生实现。
 */
export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
