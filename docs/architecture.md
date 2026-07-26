# Deki 阶段 0 架构

```text
Electron Renderer (sandbox)
        │ typed IPC
Electron Preload
        │ validated commands/events
Electron Main
        ├── DekiAgentRuntime ── Pi AgentSessionRuntime
        ├── ToolGateway ─────── Deki Tool / MCP Providers
        ├── McpManager ──────── stdio child processes
        ├── MemoryEngine ────── SQLite
        └── Config ──────────── ~/.deki + project .deki
```

## 边界

Renderer 只渲染状态并发出明确命令，不能访问 Node.js、文件系统或子进程。Main Process 是唯一可信执行边界，负责工作区信任、参数校验、Agent 生命周期和持久化。

Pi SDK 被限制在 `agent-runtime` 适配层。UI 只消费 Deki 标准事件，不依赖 Pi 原始事件结构。会话由 Pi 以 JSONL 保存到 `~/.deki/sessions/<workspace-hash>/`，并由 Main Process 提供搜索、恢复、重命名、删除和保留期限清理。

Tool Gateway 使用内部名 `provider.tool`，暴露给模型时转换为 `provider__tool`。项目文件、Shell 和 MCP Tool 统一经过 Permission Engine；Pi 原始写入与 Shell Tool 不会直接启用。写入产生完整 Diff，审计在真实执行结束后记录最终成功或失败状态。

Memory Engine 使用 `node:sqlite` 和版本化迁移，以小规模内存评分召回，并提供用户/项目作用域的记忆中心。自动记忆只生成待确认候选，未经确认不会进入召回。
