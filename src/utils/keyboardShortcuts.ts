// macOS Option+按键产生的特殊字符，映射到等效的快捷键。
// 用于在未启用 "Option as Meta" 的 macOS 终端上检测 Option+按键快捷键。
export const MACOS_OPTION_SPECIAL_CHARS = {
  '†': 'alt+t', // Option+T -> thinking toggle
  π: 'alt+p', // Option+P -> model picker
  ø: 'alt+o', // Option+O -> fast mode
} as const satisfies Record<string, string>

export function isMacosOptionChar(
  char: string,
): char is keyof typeof MACOS_OPTION_SPECIAL_CHARS {
  return char in MACOS_OPTION_SPECIAL_CHARS
}
