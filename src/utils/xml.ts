// 转义 XML/HTML 特殊字符以便安全地插入元素文本内容（标签之间）。
// 当不受信任的字符串（进程 stdout、用户输入、外部数据）进入 `<tag>${here}</tag>` 时使用。
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 转义用于插入双引号或单引号属性值中：`<tag attr="${here}">`。
// 除了 `& < >` 还会转义引号。
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
