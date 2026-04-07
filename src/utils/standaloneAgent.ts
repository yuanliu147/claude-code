/**
 * Standalone agent utilities for sessions with custom names/colors
 *
 * These helpers provide access to standalone agent context (name and color)
 * for sessions that are NOT part of a swarm team. When a session is part
 * of a swarm, these functions return undefined to let swarm context take
 * precedence.
 */

import type { AppState } from '../state/AppState.js'
import { getTeamName } from './teammate.js'

/**
 * Returns the standalone agent name if set and not a swarm teammate.
 * Uses getTeamName() for consistency with isTeammate() swarm detection.
 */
export function getStandaloneAgentName(appState: AppState): string | undefined {
  // 如果在团队中（swarm），不返回独立名称
  if (getTeamName()) {
    return undefined
  }
  return appState.standaloneAgentContext?.name
}
