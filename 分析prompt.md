# 研究提示词模板

> 用法：把下面的方括号 `[...]` 替换成具体的研究主题、仓库路径、输出文件名，然后整段发给我即可。
> 参考成品：`./claude-skill.html`（Claude Code skill 机制分析）。要保持风格一致，可以先打开那份文件看一遍。

---

## 提示词正文

请对 **`[研究主题，例如：MCP（Model Context Protocol）机制 / OpenAI 兼容层 / voice mode / hooks 系统]`** 进行一次深度技术分析，按下方规范输出到 **`./[输出文件名，例如：claude-mcp.html]`**。

### 1. 研究范围

- **代码仓库**：`/Users/admin/WorkSpace/claude-code`（当前反编译版本，版本 2.1.888）
- **设计背景**：用 `gh search issues` / `gh search prs` / `gh search discussions` 在 `anthropics/claude-code`（必要时 `anthropics/skills` / `modelcontextprotocol/modelcontextprotocol` 等相关仓库）查设计动机
- **官方文档**：尝试 WebFetch `https://www.anthropic.com/engineering/...`、`https://support.claude.com/...`、`https://docs.claude.com/...` 等

### 2. 研究方法（必须）

启动一个 **Workflow**（ultracode 模式下默认行为），分阶段：

**Discovery 阶段 — 8 个并行 agent**（每个聚焦一个维度，回报时必须含具体 file:line 引用 + 真实代码片段）：

1. `[核心工具/主流程定义]` —— 工具/系统主体的文件位置、schema、call()/execute() 流程
2. `[发现/加载机制]` —— 怎么从磁盘/网络/注册中心发现并组装
3. `[元数据/配置解析]` —— frontmatter / 配置文件 / schema 校验逻辑
4. `[内容加载与转换]` —— 文件读入、模板替换、变换管线
5. `[注册/注入到模型]` —— 怎么暴露给模型（system prompt / system-reminder / 工具列表）
6. `[限制汇总]` —— 显式与隐式的 size / count / format 上限
7. `[端到端调用流程]` —— 从用户输入/模型触发到最后执行的完整链路，step by step
8. `[引用/依赖处理]` —— 怎么处理附属资源、子文件、跨模块引用

**Verify 阶段 — 2 个并行 agent**：

- `crosscheck`：把 Discovery 结果中的所有 file:line 引用重新读文件验证，修正错误、标出"未在代码中找到"
- `design`：用 `gh` CLI + WebFetch 抓设计背景，整理"为什么这么设计"的原文引用 + URL

**Synthesize 阶段 — 1 个 agent**：把以上所有发现整合成 HTML 写入指定文件。

### 3. 输出规范

**文件**
- 位置：`/Users/admin/WorkSpace/claude-code/[输出文件名]`
- 格式：单文件 HTML5，内嵌 CSS，**不引用任何外部 CDN / 字体 / JS 库**
- 语言：**中文** 为主，保留必要英文（代码、标识符、官方引用）
- 行数：约 1000-1800 行（实质性内容，不是凑字）

**结构（按需调整，讲透为准）**：

`claude-skill.html` 那 12 章节是**一个具体主题恰好适合的拆法**，不是模板。小主题用不到 12 章就砍掉无关的；新主题有别的维度（比如权限系统、并发模型、状态机、跨进程通信）就加。不要为了凑章节把内容稀释。

最低限度要回答清楚：

- 这是什么？（一句话定义 + 与邻近概念的边界）
- 在哪里 / 怎么发现的？（路径、根、优先级）
- 怎么工作的？（核心数据流 / 状态机 / 调用链）
- 模型/调用方怎么看到的？（注入方式 + 上下文格式）
- 哪些限制是显式的，哪些是隐式的？
- 为什么这么设计？（设计动机 / 替代方案 / 官方原话）
- 已知问题 / 未修复的 issue / 改进计划
- 关键代码定位（按职责分组的 file:line 索引）

如果某个主题天然不需要回答其中一两项（比如研究"启动流程"就没有"已知问题"那一节），就直接跳过。**内容质量 > 章节完整性。**

`claude-skill.html` 的 12 章节结构（overview / layout / discovery / frontmatter / registration / invocation / references / limits / errors / design / issues / files）仅供参考，不强制。

**布局（强约束 — 不要换）**：

```
┌─────────┬───────────────────────────────────┐
│         │                                   │
│  侧边栏  │          主内容区                 │
│  (固定)  │          (可滚动)                │
│         │                                   │
│  目录    │   [Hero / 章节正文 / 表格 / ...]  │
│  TOC    │                                   │
│         │                                   │
│         │                                   │
└─────────┴───────────────────────────────────┘
```

- 左侧 `<aside>` 用 `position: sticky; top: 0; height: 100vh;` 固定，**不跟随内容滚动**
- 右侧 `<main>` 是主滚动区，承载所有章节内容
- 移动端（`< 960px`）自动隐藏侧边栏，垂直堆叠
- 这是 IDE、文档站、Notion、VS Code 等通用阅读布局，符合"左侧导航 + 右侧内容"的人类操作直觉。**不要换成顶部导航或全宽布局**

**视觉风格（必须严格匹配 `claude-skill.html`）**：

| 元素 | 样式类 | 用途 |
|------|--------|------|
| 侧边栏 TOC | `<aside>` 内的 `<ol>` | 12 章节 + 子节锚链接 |
| 章节标题 | `<span class="section-num">` + 编号 | 蓝色徽标 + 数字 |
| 信息块 | `<div class="callout info">` | 蓝色，强调事实 |
| 警告块 | `<div class="callout warn">` | 黄色，强调反直觉/陷阱 |
| 提示块 | `<div class="callout tip">` | 绿色，强调最佳实践 |
| 重点块 | `<div class="callout pin">` | 紫色，强调关键文件 |
| 补充块 | `<div class="supp-block">` | **紫色虚线 + 渐变背景**，深度延展用 |
| 双语引用 | `<div class="bilingual">` | **双栏 EN ⇄ ZH**，所有外文引用必须用此格式 |
| 流程图 | `<div class="flow">` | 单字体框，ASCII art 风格 |
| 限制表 | `<table>` | 列：限制 / 值 / 位置 / 说明 |

**配色**（深色主题）：
```
--bg: #0d1117; --fg: #c9d1d9; --accent: #58a6ff;
--purple: #bc8cff; --green: #3fb950; --yellow: #e3b341;
--red: #f85149; --orange: #d29922;
```

**完整 CSS 模板**可以直接从 `claude-skill.html` 头部 `<style>` 整段复制，无需重写。

### 4. 引用规范（硬性要求）

- **每个技术声明必须含 file:line 引用**，格式：`src/path/to/file.ts:line_start-line_end`
- **不猜测**：找不到实现就说"未在代码中找到明确实现"，列在"未确认/存疑"小节
- **GitHub 引用**：用 `issue #12345` 简写，链接给完整 URL
- **官方文档引用**：用 `<blockquote>` + `<cite>` 标注来源 URL，**且必须用 `.bilingual` 双语块**
- **反编译代码特征**：保留 `__bun:bun` / `_c(N)` / `unknown` 类型等"这是反编译的"事实，不假装是源码

### 5. 增量补充块的触发条件

我可能在收到初版后要求你补"补充说明"块。预留三个入口位置（任选其一追加）：

- 章节末尾：`<h3>主题</h3>` 之后、`</section>` 之前
- 行内插入：表格 `<tr>` 之间、`<p>` 段落之间
- 独立小节：作为第 13 节"X 模式深度解析"插入 12 节后

补充块统一用 `.supp-block` 样式，header 徽标按主题选：
- `ESSENCE` 💡：概念性补充（如"X 的本质"）
- `NAMING` 🔍：命名/语义澄清（如"某个词到底是 A 还是 B"）
- `DEPTH DIVE` 📘：实现细节深挖
- `PATTERN` 🧩：设计模式分析
- `GOTCHA` ⚠️：已知陷阱与反直觉点

### 6. 翻译要求

**所有外文引用必须双语对照**（用 `.bilingual` 块）。范围：
- Anthropic 工程博客原文 → 必翻
- 官方支持文档原文 → 必翻
- GitHub issue 用户长篇评论 → 必翻
- 代码字符串字面量（错误信息、用户可见消息）→ **不翻**，保留原样
- 字段名 / 工具名 / 路径 / 标识符 → **不翻**
- 代码块内的英文注释 → **不翻**（属于代码本身）

### 7. 工作流失败的回退

如果 Workflow 在 Verify 阶段卡住（之前的经验），Discovery 阶段 8 个 agent 的结果**已经被持久化在 transcript 目录**。回退方案：

1. 从 `/Users/admin/.claude/projects/-Users-admin-WorkSpace-claude-code/<session-id>/subagents/workflows/wf_*/journal.jsonl` 提取 `type: "result"` 条目
2. 对照 transcript 中各 agent 第一条 user 消息的 prompt 头，映射到 8 个 Discovery key
3. 把所有 `.md` 结果喂给 Synthesize agent（或自己整合）

### 8. 完成后的自检

- [ ] HTML 在浏览器打开正常渲染，无控制台错误
- [ ] 关键问题都讲透了，没有为了凑章节而稀释
- [ ] 所有外文引用都用 `.bilingual` 双语块
- [ ] 关键文件清单的 file:line 全部能 grep 到
- [ ] **"用户实测可用性"检查**：对每个描述为"功能 / 机制 / 模式"的章节，问自己——用户在不修改任何配置 / flag / 环境变量的前提下，**能直接用上这个功能吗**？如果不能（如被 feature flag 默认关闭、依赖某个未实现模块、需要特定启动参数），**必须在该章节明确标注**："需要 flag X 启用"、"需要 Y 配置"、"Z 模块为占位实现未生效"等。**不要把"如果启用会怎样"或"设计意图"写成"已实现机制"**。
- [ ] 行数 1000-1800 之间（内容不够宁可少写，不灌水）
- [ ] 文件自包含（`<style>` 内嵌、无 `<link rel="stylesheet" href="http...">`）

---

## 模板使用示例

如果我想研究 MCP 机制，提示词开头就改成：

```
请对 MCP（Model Context Protocol）机制进行一次深度技术分析，按下方规范输出到
./claude-mcp.html。
```

并把"研究范围"里的 `[代码仓库]` 改成当前路径（如果还是同一个仓库就不用改）。

---

## 备注

- 提示词整体偏长，但**不要简化**——每个约束都是经验教训（Workflow 卡住、引用遗漏、样式不一致等真实发生过的问题）
- 如果只研究小主题（比如单个工具），可以把"必须包含的 12 个章节"压缩到 5-6 个，但样式/引用规范不能省
- 如果有具体的小问题想问（比如"inline 模式再解释一下"），直接发问题即可，**不需要**套这个模板
