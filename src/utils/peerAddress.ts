/**
 * 对端地址解析 — 与 peerRegistry.ts 分开，以便 SendMessageTool
 * 可以在工具枚举时导入 parseAddress，而不需要传递加载
 * bridge（axios）和 UDS（fs、net）模块。
 */

/** 将 URI 风格的地址解析为 scheme + target。 */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'other'
  target: string
} {
  if (to.startsWith('uds:')) return { scheme: 'uds', target: to.slice(4) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice(7) }
  // 遗留问题：旧代码的 UDS 发送方在 from= 中发送裸套接字路径；
  // 通过 UDS 分支路由它们，以避免回复被静默丢弃到 teammate 路由中。
  //（没有裸会话 ID 回退 — bridge messaging 足够新，没有旧发送方存在，
  // 且此前缀会劫持类似 session_manager 的 teammate 名称。）
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}
