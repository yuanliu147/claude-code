/**
 * 在 Commander.js 处理参数之前早期解析 CLI 标志值。
 * 支持空格分隔（--flag value）和等号分隔（--flag=value）语法。
 *
 * 此函数旨在用于必须在 init() 运行之前解析的标志，
 * 例如影响配置加载的 --settings。对于普通标志解析，
 * 依赖 Commander.js 自动处理。
 *
 * @param flagName 包含破折号的标志名称（例如 '--settings'）
 * @param argv 要解析的可选 argv 数组（默认为 process.argv）
 * @returns 如果找到则返回值，否则为 undefined
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // 处理 --flag=value 语法
    if (arg?.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
    // Handle --flag value syntax
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * 处理 CLI 参数中的标准 Unix `--` 分隔符约定。
 *
 * 当使用带有 `.passThroughOptions()` 的 Commander.js 时，
 * `--` 分隔符作为位置参数传递，而不是被消费。
 * 这意味着当用户运行：
 *   `cmd --opt value name -- subcmd --flag arg`
 *
 * Commander 将其解析为：
 *   positional1 = "name", positional2 = "--", rest = ["subcmd", "--flag", "arg"]
 *
 * 此函数通过在位置参数为 `--` 时从 rest 数组中提取实际命令来纠正解析。
 *
 * @param commandOrValue - 可能为 "--" 的解析位置参数
 * @param args - 剩余参数数组
 * @returns 包含更正后的命令和参数的对象
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    return {
      command: args[0]!,
      args: args.slice(1),
    }
  }
  return { command: commandOrValue, args }
}
