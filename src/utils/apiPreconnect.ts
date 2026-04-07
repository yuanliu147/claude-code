/**
 * 预连接到 Anthropic API 以将 TCP+TLS 握手与启动重叠。
 *
 * TCP+TLS 握手约 100-200ms，通常在第一次 API 调用内阻塞。
 * 在初始化期间启动一个即发即忘的 fetch 可以让握手
 * 与 action-handler 工作并行发生（-p 模式下 API 请求前的约 100ms 设置/命令/mcp；
 * 交互模式下不受限制的"用户正在输入"窗口）。
 *
 * Bun 的 fetch 在全局共享 keep-alive 连接池，所以真正的 API
 * 请求会重用预热的连接。
 *
 * 从 init.ts 在 applyExtraCACertsFromConfig() + configureGlobalAgents() 之后调用，
 * 以便应用 settings.json 环境变量并最终确定 TLS 证书存储。
 * 早期的 cli.tsx 调用点已移除 — 它在 settings.json 加载之前运行，
 * 所以 settings 中的 ANTHROPIC_BASE_URL/proxy/mTLS 会被忽略，预连接
 * 会预热错误的池（或者更糟，在应用 NODE_EXTRA_CA_CERTS 之前锁定 BoringSSL 的证书存储）。
 *
 * 以下情况跳过：
 * - 配置了 proxy/mTLS/unix socket（预连接会使用错误的传输 —
 *   SDK 传递的自定义 dispatcher/agent 不共享全局池）
 * - Bedrock/Vertex/Foundry（不同的端点，不同的认证）
 */

import { getOauthConfig } from '../constants/oauth.js'
import { isEnvTruthy } from './envUtils.js'

let fired = false

export function preconnectAnthropicApi(): void {
  if (fired) return
  fired = true

  // Skip if using a cloud provider — different endpoint + auth
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return
  }
  // 如果使用 proxy/mTLS/unix — SDK 的自定义 dispatcher 不会重用此池
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET ||
    process.env.CLAUDE_CODE_CLIENT_CERT ||
    process.env.CLAUDE_CODE_CLIENT_KEY
  ) {
    return
  }

  // Use configured base URL (staging, local, or custom gateway). Covers
  // ANTHROPIC_BASE_URL env + USE_STAGING_OAUTH + USE_LOCAL_OAUTH in one lookup.
  // NODE_EXTRA_CA_CERTS no longer a skip — init.ts applied it before this fires.
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL

  // 即发即忘。HEAD 意味着没有响应体 — 连接在头部到达后立即符合
  // keep-alive 池重用条件。10s 超时，这样慢速网络不会挂起进程；
  // 如果需要中止，新的请求会进行新的握手。
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
