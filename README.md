# Deki

本地优先、自由扩展的 AI 开发工作台。

当前仓库提供 Electron 桌面 PoC：主进程嵌入 Pi Agent Runtime，支持权限受控的代码工具与 Shell、stdio MCP、项目 Skill、JSONL 会话、长期记忆和完整设置页。

## 当前能力

- Electron + React 中文桌面界面
- 无需项目即可使用的普通会话模式
- Pi `AgentSessionRuntime` 流式消息和工具事件
- 工作区信任门禁
- 受控工作区工具：`read`、`grep`、`find`、`ls`、`edit`、`write`、`bash`
- 动态 stdio MCP Tool
- `.deki/skills`、`.agents/skills` 与项目内 `.pi/skills`
- `/remember` 用户/项目记忆及跨会话召回
- 本地 SQLite 记忆库和 Pi JSONL 会话
- 全局、项目共享和项目本机设置
- 受权限网关保护的文件修改、Shell、MCP、Diff 与脱敏审计

当前版本不支持真实 Sandbox、本地模型、HTTP/OAuth MCP、内置 MCP Server 或自动更新下载。

## 环境要求

- Node.js 22.23.1
- pnpm 11.4.0
- macOS、Linux 或 Windows
- 至少一个由 Pi 支持的云模型 API Key

```bash
nvm install
nvm use
pnpm install
export OPENAI_API_KEY="..."
pnpm dev
```

Deki 不会读取 `~/.pi/agent/auth.json`。可以从设置中配置自定义云 Provider，也可以从启动
Deki 的终端进程传入 Pi 支持的模型环境变量。
普通会话不会读取项目内容；需要项目工具时，可从左侧项目区选择目录并完成信任，或使用
`pnpm dev -- --workspace /absolute/path/to/project` 直接启动指定项目。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:electron
pnpm build
pnpm package
```

测试专用 MCP Server 和 Skill 位于 `tests/fixtures/`，不会作为产品示例或预置 Server 发布。

## 数据位置

Deki 用户数据只保存在 `~/.deki/`：

- `config.json`：受信任工作区
- `settings.json`：全局设置
- `sessions/`：Pi JSONL 会话
- `memory/memory.db`：长期记忆
- `models.json`：自定义云模型配置（权限 `0600`）
- `projects/`：项目本机设置
- `logs/audit-*.jsonl`：脱敏权限审计与 Diff

设置分层、密钥边界和权限规则详见
[设置与权限文档](docs/settings-and-permissions.md)。

## 许可证

Deki 以 [GNU Affero General Public License v3.0 or later](LICENSE) 发布，SPDX 标识为 `AGPL-3.0-or-later`。
