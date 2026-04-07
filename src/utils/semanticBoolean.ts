import { z } from 'zod/v4'

/**
 * 也接受字符串字面量 "true"/"false" 的布尔类型。
 *
 * 工具输入以模型生成的 JSON 形式到达。模型偶尔会引用布尔值
 * — `"replace_all":"false"` 而不是 `"replace_all":false` — 而
 * z.boolean() 会以类型错误拒绝它。z.coerce.boolean() 是错误的修复方式：
 * 它使用 JS 真假值，所以 "false" → true。
 *
 * z.preprocess 向 API schema 发出 {"type":"boolean"}，所以模型仍然被告知这是布尔值
 * — 字符串容差是不可见的客户端强制转换，不是公开的输入形状。
 *
 * .optional()/.default() 放在内部（内部 schema 上），而不是链接在后面：
 * 在 Zod v4 中将它们链接到 ZodPipe 会将 z.output<> 扩大到 unknown。
 *
 *   semanticBoolean()                              → boolean
 *   semanticBoolean(z.boolean().optional())        → boolean | undefined
 *   semanticBoolean(z.boolean().default(false))     → boolean
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  )
}
