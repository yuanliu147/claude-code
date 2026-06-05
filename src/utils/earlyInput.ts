/**
 * 早期输入捕获
 *
 * 此模块用于捕获在 REPL 完全初始化之前输入的终端内容。用户经常在输入 `claude` 后
 * 立即开始输入指令，但这些早期按键在启动过程中可能会丢失。
 *
 * 使用方法：
 * 1. 在 cli.tsx 中尽早调用 startCapturingEarlyInput()
 * 2. 当 REPL 就绪时，调用 consumeEarlyInput() 获取缓冲的文本
 * 3. stopCapturingEarlyInput() 在输入被消费时自动调用
 */

import { lastGrapheme } from './intl.js'

// 早期输入字符的缓冲区
let earlyInputBuffer = ''
// 标志位，用于跟踪当前是否正在捕获
let isCapturing = false
// 可读事件处理器的引用，以便后续移除
let readableHandler: (() => void) | null = null

/**
 * 在 REPL 初始化之前尽早开始捕获 stdin 数据。
 * 应在启动序列中尽可能早地调用。
 *
 * 仅在 stdin 为 TTY（交互式终端）时捕获。
 */
export function startCapturingEarlyInput(): void {
  // Only capture in interactive mode: stdin must be a TTY, and we must not
  // be in print mode. Raw mode disables ISIG (terminal Ctrl+C → SIGINT),
  // which would make -p uninterruptible.
  if (
    !process.stdin.isTTY ||
    isCapturing ||
    process.argv.includes('-p') ||
    process.argv.includes('--print')
  ) {
    return
  }

  isCapturing = true
  earlyInputBuffer = ''

  // 将 stdin 设置为原始模式，并像 Ink 一样使用 'readable' 事件
  // 这确保了与 REPL 后续处理 stdin 方式的兼容性
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.ref()

    readableHandler = () => {
      let chunk = process.stdin.read()
      while (chunk !== null) {
        if (typeof chunk === 'string') {
          processChunk(chunk)
        }
        chunk = process.stdin.read()
      }
    }

    process.stdin.on('readable', readableHandler)
  } catch {
    // 如果无法设置原始模式，则静默继续，不进行早期捕获
    isCapturing = false
  }
}

/**
 * 处理一段输入数据
 */
function processChunk(str: string): void {
  let i = 0
  while (i < str.length) {
    const char = str[i]!
    const code = char.charCodeAt(0)

    // Ctrl+C (code 3) - 停止捕获并立即退出。
    // 此处使用 process.exit 而不是 gracefulShutdown，因为在启动早期阶段，
    // 关闭机制尚未初始化。
    if (code === 3) {
      stopCapturingEarlyInput()
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(130) // Standard exit code for Ctrl+C
      return
    }

    // Ctrl+D (code 4) - EOF，停止捕获
    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }

    // 退格 (code 127 或 8) - 删除最后一个字素簇
    if (code === 127 || code === 8) {
      if (earlyInputBuffer.length > 0) {
        const last = lastGrapheme(earlyInputBuffer)
        earlyInputBuffer = earlyInputBuffer.slice(0, -(last.length || 1))
      }
      i++
      continue
    }

    // 跳过转义序列（方向键、功能键、焦点事件等）
    // 所有转义序列都以 ESC (0x1B) 开头，以 0x40-0x7E 范围内的字节结尾
    if (code === 27) {
      i++ // Skip the ESC character
      // Skip until the terminating byte (@ to ~) or end of string
      while (
        i < str.length &&
        !(str.charCodeAt(i) >= 64 && str.charCodeAt(i) <= 126)
      ) {
        i++
      }
      if (i < str.length) i++ // Skip the terminating byte
      continue
    }

    // 跳过其他控制字符（制表符和换行符除外）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      i++
      continue
    }

    // 将回车符转换为换行符
    if (code === 13) {
      earlyInputBuffer += '\n'
      i++
      continue
    }

    // 将可打印字符和允许的控制字符添加到缓冲区
    earlyInputBuffer += char
    i++
  }
}

/**
 * 停止捕获早期输入。
 * 在输入被消费时自动调用，也可手动调用。
 */
export function stopCapturingEarlyInput(): void {
  if (!isCapturing) {
    return
  }

  isCapturing = false

  if (readableHandler) {
    process.stdin.removeListener('readable', readableHandler)
    readableHandler = null
  }

  // 不要重置 stdin 状态 — REPL 的 Ink App 会管理 stdin 状态。
  // 如果在此处调用 setRawMode(false)，可能会干扰 REPL 在同一时间段
  // 自己进行的 stdin 设置。
}

/**
 * 消费任何已捕获的早期输入。
 * 返回捕获的输入并清除缓冲区。
 * 调用时自动停止捕获。
 */
export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const input = earlyInputBuffer.trim()
  earlyInputBuffer = ''
  return input
}

/**
 * 检查是否有可用的早期输入，但不消费它。
 */
export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

/**
 * 用指定文本填充早期输入缓冲区，该文本在 REPL 渲染时会预填充在
 * 提示符输入框中。不会自动提交。
 */
export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

/**
 * 检查早期输入捕获是否当前处于活动状态。
 */
export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
