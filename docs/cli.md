# Deki CLI

`deki` 是桌面应用的本地管理和诊断入口。它不会输出 API Key；支持 `--json`
的命令只输出已经脱敏的模型元数据和审计内容。

## 启动

```text
deki [path] [--general]
deki resume [path] [--general]
```

开发仓库中使用 `pnpm deki -- <arguments>`。CLI 会优先查找
`DEKI_DESKTOP_PATH`，然后查找已安装的 Deki，最后回退到当前 monorepo 的
开发启动命令。`resume` 会把 `--resume` 传给桌面 Runtime，不依赖默认启动设置。

## 管理命令

```text
deki doctor [--workspace path] [--json]
deki models list
deki models import --file provider.json
deki models remove <provider-id>
deki skills list [--workspace path]
deki skills create <name> [--description text]
deki skills validate <path>
deki mcp list [--workspace path]
deki mcp add <id> --command cmd [--arg value] [--cwd relative]
deki mcp remove <id>
deki mcp test <id>
deki permissions list [--workspace path]
deki permissions set <category> <allow|ask|deny> [--scope global|project]
deki audit [--limit 100] [--json]
```

模型导入文件使用设置系统的严格 Provider Schema。API Key 必须显式写成
`{"action":"set","value":"..."}`，文件应由用户自行保护；CLI 永不回显该值。
MCP 本机环境变量仍只从权限为 `0600` 的项目本机配置读取。

## Git Checkpoint

```text
deki checkpoint list [--limit 50]
deki checkpoint create [--message text]
deki checkpoint show <id>
deki checkpoint diff <id>
deki checkpoint restore <id> --yes
deki checkpoint remove <id> --yes
```

Checkpoint 使用独立临时 Git index 构造 tree 和 commit，并保存在
`refs/deki/checkpoints/<id>`。它不会执行 `git commit`、不会移动 HEAD、不会切换
分支，也不会改变用户的 index。被 Git 忽略的文件不会进入快照。

恢复前会自动创建一个 safety checkpoint。恢复只更新工作区内容，不删除当前
存在且 checkpoint 中没有的未跟踪文件。桌面端也可在“设置 → 项目与工作区”
查看、预览、创建和恢复 checkpoint。

受信任 Git 项目默认在 Agent 的 edit、write、delete、move 以及可能产生副作用的
Shell 操作获得权限后、真实 I/O 前创建 checkpoint。只读 Shell 不创建快照；
可通过项目设置关闭自动创建。
