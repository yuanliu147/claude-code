/**
 * 通过 /env 设置的会话级环境变量。
 * 仅应用于派生的子进程（通过 bash 提供者的环境覆盖），
 * 不应用于 REPL 进程本身。
 */
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

export function setSessionEnvVar(name: string, value: string): void {
  sessionEnvVars.set(name, value)
}

export function deleteSessionEnvVar(name: string): void {
  sessionEnvVars.delete(name)
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
