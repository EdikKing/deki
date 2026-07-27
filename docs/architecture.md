# Deki 阶段 0 架构

```text
Electron Renderer (sandbox)
        │ typed IPC
Electron Preload
        │ validated commands/events
Electron Main
        ├── DekiAgentRuntime ── Pi AgentSessionRuntime
        ├── ToolGateway ─────── Deki Tool / MCP Providers
        ├── GitCheckpoint ───── isolated index + refs/deki/checkpoints
        ├── McpManager ──────── stdio child processes
        ├── MemoryEngine ────── SQLite
        └── Config ──────────── ~/.deki + project .deki

Deki CLI
        ├── desktop launch / resume
        └── Config / MCP / Settings / GitCheckpoint management
```

## 边界

Renderer 只渲染状态并发出明确命令，不能访问 Node.js、文件系统或子进程。Main Process 是唯一可信执行边界，负责工作区信任、参数校验、Agent 生命周期和持久化。

Pi SDK 被限制在 `agent-runtime` 适配层。UI 只消费 Deki 标准事件，不依赖 Pi 原始事件结构。会话由 Pi 以 JSONL 保存到 `~/.deki/sessions/<workspace-hash>/`；Deki 在同一棵追加式会话树中持久化运行状态、Tool Timeline、Diff 和审批事件。Main Process 提供全文搜索、消息级分叉、恢复、重命名、删除和保留期限清理。并发提交会从当前持久化上下文创建独立会话分叉，各自持有 AgentSession 并共享具有并发上限的 Tool Gateway。

Tool Gateway 使用内部名 `provider.tool`，暴露给模型时转换为 `provider__tool`。项目文件、Shell 和 MCP Tool 统一经过 Permission Engine；Pi 原始写入与 Shell Tool 不会直接启用。所有 Provider（包括 MCP）的返回值会在网关统一脱敏，并按整个结果的字节预算限制文本、图片和结构化内容；网关同时限制实际 Provider 调用并发。写入产生完整 Diff，审计在真实执行结束后记录最终成功或失败状态。

受信任 Git 项目的可变更操作在权限确认后、真实 I/O 前通过独立临时 index
创建 Checkpoint。Checkpoint 只增加 `refs/deki/checkpoints/*` 引用，不改变
HEAD、当前分支或用户暂存区。

Memory Engine 使用 `node:sqlite` 和版本化迁移。运行时支持 FTS5 时使用
BM25 全文检索，不支持时自动回退到 SQLite 词项倒排索引；索引候选再结合
词项相关性、置顶和时间衰减进行混合排序。每轮提问可在 user、project、
workspace、Git branch 和 task 作用域召回，并使用各自独立的数量和 Token
Budget 注入隐藏上下文。任务记忆以 Pi 会话 ID 隔离，分支记忆以工作区与
Git HEAD 隔离。治理任务自动处理冲突 supersede、到期归档和低置信度归档；
自动记忆只生成待确认候选，未经确认不会进入召回。
