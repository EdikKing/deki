# Deki

本地优先、自由扩展的 AI 开发工作台。

当前仓库提供 Electron 桌面 PoC：主进程嵌入 Pi Agent Runtime，支持权限受控的代码工具与 Shell、stdio MCP、项目 Skill、JSONL 会话、长期记忆和完整设置页。

## 当前能力

- Electron + React 中文桌面界面
- 无需项目即可使用的普通会话模式
- Pi `AgentSessionRuntime` 流式消息和工具事件
- 会话搜索、恢复、切换、重命名、删除与保留期限清理
- 工作区信任门禁
- 受控工作区工具：`read`、`grep`、`find`、`ls`、`edit`、`write`、`delete`、`move`、`bash`
- stdio MCP Server 的配置、启停、重启、测试、Tool 权限/开关/超时和本机环境变量
- `.deki/skills`、`.agents/skills`、项目内 `.pi/skills` 的发现、校验和重载
- `/remember`、`/remember --task`、待确认记忆候选和用户/项目/任务记忆中心
- 本地 SQLite 全文/倒排索引、逐轮混合召回和 Pi JSONL 会话
- 内置常用云模型 Provider 与自定义 OpenAI 兼容 Provider
- 全局、项目共享、项目本机和会话设置、字段来源及修订冲突保护
- 受权限网关保护的文件修改、Shell、MCP、完整 Diff Viewer、历史审计与脱敏诊断
- 自有 `deki` CLI：启动/恢复、doctor、模型、Skill、MCP、权限、审计与 Checkpoint 管理
- 修改前 Git Checkpoint：不移动 HEAD、不改变当前分支或暂存区，可预览并安全恢复
- macOS DMG/ZIP、Windows NSIS/Portable、Linux AppImage/DEB 正式打包流水线
- GitHub Releases 自动更新源、平台代码签名与公证、SHA-256、CycloneDX SBOM 和构建 Attestation

当前版本不支持真实 Sandbox、本地模型、HTTP/OAuth MCP 或内置 MCP Server。

## 环境要求

- Node.js 24.18.0
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

CLI 在仓库中可通过以下方式使用：

```bash
pnpm deki -- --help
pnpm deki -- doctor --workspace .
pnpm deki -- checkpoint create --workspace . --message "before refactor"
pnpm deki -- checkpoint list --workspace .
```

构建后的入口为 `apps/cli/dist/deki.js`。`deki [path]` 启动项目桌面会话，
`deki resume [path]` 强制恢复该作用域最近一次会话；`--general` 启动普通会话。
完整命令见 [CLI 文档](docs/cli.md)。

Deki 不会读取 `~/.pi/agent/auth.json`。常用云模型只需在设置中填写对应 API Key；
也可以配置自定义 OpenAI 兼容 Provider，或从启动 Deki 的终端进程传入 Pi 支持的模型环境变量。
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

`pnpm package` 生成当前平台安装器；`pnpm package:dir` 只生成用于快速验证的目录包。
正式 Release 的 Tag、签名 Secrets、产物与校验方法见[发布文档](docs/releasing.md)。

测试专用 MCP Server 和 Skill 位于 `tests/fixtures/`，不会作为产品示例或预置 Server 发布。

## 数据位置

Deki 用户数据只保存在 `~/.deki/`：

- `config.json`：受信任工作区
- `settings.json`：全局设置
- `sessions/`：Pi JSONL 会话
- `memory/memory.db`：长期记忆
- `models.json`：自定义云模型配置（权限 `0600`）
- `projects/`：项目本机设置
- `projects/<workspace-hash>/mcp-local.json`：本机 MCP 环境变量（权限 `0600`）
- `logs/audit-*.jsonl`：脱敏权限审计与 Diff

设置分层、密钥边界和权限规则详见
[设置与权限文档](docs/settings-and-permissions.md)。

## 许可证

Deki 以 [GNU Affero General Public License v3.0 or later](LICENSE) 发布，SPDX 标识为 `AGPL-3.0-or-later`。
