import { z } from 'zod/v4'

/**
 * 也接受数字字符串字面量如 "30"、"-5"、"3.14" 的数字类型。
 *
 * 工具输入以模型生成的 JSON 形式到达。模型偶尔会引用数字
 * — `"head_limit":"30"` 而不是 `"head_limit":30` — 而
 * z.number() 会以类型错误拒绝它。z.coerce.number() 是错误的修复方式：
 * 它通过 JS Number() 转换接受 "" 或 null 等值，掩盖了 bug 而不是暴露它们。
 *
 * 仅对匹配 /^-?\d+(\.\d+)?$/ 的有效十进制数字字符串进行强制转换。
 * 其他任何内容都会传递并被内部 schema 拒绝。
 *
 * z.preprocess 向 API schema 发出 {"type":"number"}，所以模型仍然被告知这是数字
 * — 字符串容差是不可见的客户端强制转换，不是公开的输入形状。
 *
 * .optional()/.default() 放在内部（内部 schema 上），而不是链接在后面：
 * 在 Zod v4 中将它们链接到 ZodPipe 会将 z.output<> 扩大到 unknown。
 *
 *   semanticNumber()                              → number
 *   semanticNumber(z.number().optional())         → number | undefined
 *   semanticNumber(z.number().default(0))        → number
 */
export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
) {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner)
}
