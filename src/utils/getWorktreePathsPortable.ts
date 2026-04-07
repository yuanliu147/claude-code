import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFileCb)

/**
 * 使用纯 child_process 的可移植 worktree 检测 — 无 analytics、
 * 无 bootstrap 依赖、无 execa。由 listSessionsImpl.ts（SDK）和
 * 任何需要 worktree 路径但不引入 CLI 依赖链的地方使用
 *（execa → cross-spawn → which）。
 */
export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: 5000 },
    )
    if (!stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).normalize('NFC'))
  } catch {
    return []
  }
}
