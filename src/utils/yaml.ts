/**
 * YAML 解析包装器。
 *
 * 在 Bun 环境下使用 Bun.YAML（内置，零成本），否则回退到 `yaml` npm 包。
 * 该包在非 Bun 分支中懒加载，以便原生 Bun 构建永远不会加载约 270KB 的 yaml 解析器。
 */

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}
