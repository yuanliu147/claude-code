# Claude Code 工具描述规范

本文档分析 Claude Code 内置工具的 `description` 与 `prompt` 写作模式，总结工具描述需要包含的要素，并提供各工具 prompt 文件的索引。

## 双层描述体系

每个工具提供两个描述方法：

| 方法 | 传给谁 | 长度 | 作用 |
|------|--------|------|------|
| `description()` | UI / 用户 | 一句话（< 20 字） | 在工具列表、权限提示等界面展示 |
| `prompt()` | 大模型 | 多段落（50 ~ 数千字） | 作为 system prompt 的一部分，指导模型何时、如何、为何使用该工具 |

两者分离的原因是：**用户需要知道工具是什么，模型需要知道工具怎么用**。

## 典型 Prompt 写作模式

### 1. 参数驱动型 — FileReadTool

**核心特征**：以参数说明为主线，逐项解释每个字段的含义、约束和默认值。

```
Reads a file from the local filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning...
- You can optionally specify a line offset and limit...
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images...
- This tool can read PDF files...
- This tool can only read files, not directories. To read a directory, use an ls command...
```

**要素**：功能定义 → 参数约束 → 输出格式 → 特殊文件类型 → 工具边界

---

### 2. 规则约束型 — FileEditTool

**核心特征**：以"必须/禁止/会失败"等强制性规则为主，防止模型误操作。

```
Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once before editing.
- When editing text from Read tool output, ensure you preserve the exact indentation...
- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.
- The edit will FAIL if old_string is not unique in the file.
- Use replace_all for replacing and renaming strings across the file.
```

**要素**：前置条件 → 格式规则 → 策略指导 → 失败条件 → 参数技巧

---

### 3. 百科全书型 — BashTool

**核心特征**：最复杂的 prompt，覆盖完整工作流、安全协议、常见操作速查。

```
Run commands in a bash shell

Usage:
- You can call multiple tools in a single response...
- When issuing multiple commands: ...chain with && / ; / &
- Git Safety Protocol:
  - NEVER update the git config
  - NEVER run destructive git commands (push --force, reset --hard...)
  - CRITICAL: Always create NEW commits rather than amending...
- When staging files, prefer adding specific files by name...
```

**要素**：性能优化（并行/串行）→ 安全协议（大量 NEVER）→ 完整工作流（Git 5 步流程）→ 常见操作速查 → 背景任务说明

---

### 4. 区分型 — GrepTool / GlobTool

**核心特征**：重点说明与类似工具（尤其是 Bash）的边界，防止模型选错工具。

```
A powerful search tool built on ripgrep

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax...
- Use Agent tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping...
```

**要素**：与 Bash 的明确区分 → 功能细节 → 工具选择指导（什么时候用 Agent）→ 语法陷阱

---

### 5. 动态描述型 — WebSearchTool

**核心特征**：`description()` 是动态的（包含输入参数），而 `prompt()` 是静态的。

```typescript
// description 动态生成
async description(input) {
  return `Claude wants to search the web for: ${input.query}`
}

// prompt 静态获取
async prompt() {
  return getWebSearchPrompt() // 预定义的通用说明
}
```

---

## Prompt 必备要素清单

| 要素 | 说明 | 示例 |
|------|------|------|
| **一句话功能定义** | 工具是干什么的 | `"Reads a file from the local filesystem"` |
| **参数约束** | 格式、必填/可选、默认值、范围 | `"file_path must be absolute"` |
| **输出格式** | 结果长什么样、怎么解析 | `"Results use cat -n format"` |
| **前置条件** | 使用本工具前必须先做什么 | `"You must use Read first"` |
| **工具边界** | 不能干什么、超出范围怎么办 | `"Cannot read directories"` |
| **与其他工具的区分** | 避免模型选错工具 | `"NEVER invoke grep via Bash"` |
| **策略指导** | 什么时候用、优先选哪个 | `"Prefer Edit over Write for modifications"` |
| **安全/禁止规则** | 绝对不允许的操作 | `"NEVER run push --force"` |
| **失败条件与修复** | 什么情况下会报错、怎么解决 | `"Edit will FAIL if old_string is not unique"` |
| **高级技巧** | 提高效率的参数或模式 | `"Use replace_all to rename across file"` |

## 核心原则

把模型当成一个刚入职的工程师——它知道编程，但不熟悉你们项目的具体规范和工具边界。prompt 不是 API 文档，而是**操作规程**，要告诉它：

1. **什么时候用**：什么场景下该调这个工具
2. **怎么用**：参数怎么填、格式要注意什么
3. **不能怎么用**：常见错误、禁止操作、失败条件

---

## 工具 Prompt 文件索引

| 工具名 | Prompt 文件路径 |
|--------|-----------------|
| AgentTool | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/prompt.ts` |
| AskUserQuestionTool | `/Users/xianyi/CustomGit/claude-code/src/tools/AskUserQuestionTool/prompt.ts` |
| BashTool | `/Users/xianyi/CustomGit/claude-code/src/tools/BashTool/prompt.ts` |
| BriefTool | `/Users/xianyi/CustomGit/claude-code/src/tools/BriefTool/prompt.ts` |
| ConfigTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ConfigTool/prompt.ts` |
| DiscoverSkillsTool | `/Users/xianyi/CustomGit/claude-code/src/tools/DiscoverSkillsTool/prompt.ts` |
| EnterPlanModeTool | `/Users/xianyi/CustomGit/claude-code/src/tools/EnterPlanModeTool/prompt.ts` |
| EnterWorktreeTool | `/Users/xianyi/CustomGit/claude-code/src/tools/EnterWorktreeTool/prompt.ts` |
| ExitPlanModeTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ExitPlanModeTool/prompt.ts` |
| ExitWorktreeTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ExitWorktreeTool/prompt.ts` |
| FileEditTool | `/Users/xianyi/CustomGit/claude-code/src/tools/FileEditTool/prompt.ts` |
| FileReadTool | `/Users/xianyi/CustomGit/claude-code/src/tools/FileReadTool/prompt.ts` |
| FileWriteTool | `/Users/xianyi/CustomGit/claude-code/src/tools/FileWriteTool/prompt.ts` |
| GlobTool | `/Users/xianyi/CustomGit/claude-code/src/tools/GlobTool/prompt.ts` |
| GrepTool | `/Users/xianyi/CustomGit/claude-code/src/tools/GrepTool/prompt.ts` |
| ListMcpResourcesTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ListMcpResourcesTool/prompt.ts` |
| LSPTool | `/Users/xianyi/CustomGit/claude-code/src/tools/LSPTool/prompt.ts` |
| MCPTool | `/Users/xianyi/CustomGit/claude-code/src/tools/MCPTool/prompt.ts` |
| NotebookEditTool | `/Users/xianyi/CustomGit/claude-code/src/tools/NotebookEditTool/prompt.ts` |
| PowerShellTool | `/Users/xianyi/CustomGit/claude-code/src/tools/PowerShellTool/prompt.ts` |
| ReadMcpResourceTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ReadMcpResourceTool/prompt.ts` |
| RemoteTriggerTool | `/Users/xianyi/CustomGit/claude-code/src/tools/RemoteTriggerTool/prompt.ts` |
| ScheduleCronTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ScheduleCronTool/prompt.ts` |
| SendMessageTool | `/Users/xianyi/CustomGit/claude-code/src/tools/SendMessageTool/prompt.ts` |
| SendUserFileTool | `/Users/xianyi/CustomGit/claude-code/src/tools/SendUserFileTool/prompt.ts` |
| SkillTool | `/Users/xianyi/CustomGit/claude-code/src/tools/SkillTool/prompt.ts` |
| SleepTool | `/Users/xianyi/CustomGit/claude-code/src/tools/SleepTool/prompt.ts` |
| SnipTool | `/Users/xianyi/CustomGit/claude-code/src/tools/SnipTool/prompt.ts` |
| TaskCreateTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TaskCreateTool/prompt.ts` |
| TaskGetTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TaskGetTool/prompt.ts` |
| TaskListTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TaskListTool/prompt.ts` |
| TaskStopTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TaskStopTool/prompt.ts` |
| TaskUpdateTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TaskUpdateTool/prompt.ts` |
| TeamCreateTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TeamCreateTool/prompt.ts` |
| TeamDeleteTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TeamDeleteTool/prompt.ts` |
| TerminalCaptureTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TerminalCaptureTool/prompt.ts` |
| TodoWriteTool | `/Users/xianyi/CustomGit/claude-code/src/tools/TodoWriteTool/prompt.ts` |
| ToolSearchTool | `/Users/xianyi/CustomGit/claude-code/src/tools/ToolSearchTool/prompt.ts` |
| WebFetchTool | `/Users/xianyi/CustomGit/claude-code/src/tools/WebFetchTool/prompt.ts` |
| WebSearchTool | `/Users/xianyi/CustomGit/claude-code/src/tools/WebSearchTool/prompt.ts` |

### Agent 子代理内置工具 Prompt

AgentTool 子代理自带一套精简工具，其 prompt 文件位于：

| 工具名 | Prompt 文件路径 |
|--------|-----------------|
| FileReadTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/FileReadTool/prompt.ts` |
| FileWriteTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/FileWriteTool/prompt.ts` |
| GlobTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/GlobTool/prompt.ts` |
| GrepTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/GrepTool/prompt.ts` |
| WebFetchTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/WebFetchTool/prompt.ts` |
| WebSearchTool (Agent) | `/Users/xianyi/CustomGit/claude-code/src/tools/AgentTool/built-in/src/tools/WebSearchTool/prompt.ts` |
