// 依赖于用户设置的 Git 相关行为。
//
// 此模块放在 git.ts 之外，因为 git.ts 在 vscode 扩展的依赖图中，
// 必须保持不含 settings.ts，而 settings.ts 会传递引入
// @opentelemetry/api + undici（vscode 中禁止使用）。这里也存在循环依赖：
// settings.ts → git/gitignore.ts → git.ts，所以 git.ts → settings.ts 会形成循环。
//
// 如果你想在 git.ts 中添加 `import settings` — 不要这样做。放在这里。

import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  return getInitialSettings().includeGitInstructions ?? true
}
