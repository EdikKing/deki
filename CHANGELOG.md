# Changelog

所有重要变更记录在此文件。格式参考 Keep a Changelog，版本遵循 Semantic Versioning。

## [Unreleased]

## [0.0.4] - 2026-07-30

### Fixed

- 修复桌面端自动更新的版本检测与安装流程。

## [0.0.3] - 2026-07-30

### Fixed

- 修复桌面端输入法回车误提交提示词的问题。
- 修复自动更新集成、计划执行失败状态展示及失败原因无限增长问题。
- 让 Agent 生成的 Git 提交信息跟随应用语言。

### Changed

- 重新设计后台任务中心，并优化默认窗口宽度、会话滚动条和执行会话展示。

## [0.0.2] - 2026-07-29

### Fixed

- Tool Gateway 统一限制并脱敏工作区与 MCP Tool 返回值，并对 Provider 调用实施并发控制。

### Added

- 会话消息级分叉、完整 Timeline 恢复、异常运行恢复和会话命令集。
- 模型 Token/上下文统计与独立会话分叉的并发运行池。
- Skill 全局兼容目录、来源更新和版本锁定。
- MCP 周期健康检查、原连接自动重连、指数退避和 `${secret:NAME}` 引用。
- workspace/branch 记忆作用域、Token Budget、冲突 supersede、过期与低置信度治理。
- 可手动检查、后台下载并退出安装的 GitHub Releases 更新客户端。

- 三平台正式安装器：macOS DMG/ZIP、Windows NSIS/Portable、Linux AppImage/DEB。
- SemVer Tag Release 工作流、macOS 签名与公证、Windows Authenticode、GitHub Releases 更新源。
- SHA-256 校验和、CycloneDX SBOM、Artifact Attestation 和应用内 Stable/Beta 自动更新。
- 自有 Deki CLI，覆盖启动/恢复、doctor、模型、Skill、MCP、权限、审计和 Git Checkpoint 管理。
- 基于 `refs/deki/checkpoints/*` 的分支无侵入 Checkpoint、Agent 修改前自动快照、Diff 预览和安全恢复。
- 阶段 0 Electron + React 桌面 PoC。
- Pi Agent Runtime、只读 Tool、stdio MCP 与 Skill 加载。
- 工作区信任、SQLite 项目记忆和跨会话来源展示。
- pnpm Monorepo、自动化测试和三平台 CI 配置。
- 完整设置中心、内置云模型 Provider、项目作用域和密钥脱敏存储。
- 权限审批、完整 Diff Viewer、真实执行结果审计和审计保留清理。
- 会话搜索、恢复、切换、重命名、删除和保留期限清理。
- stdio MCP 单服务管理和 Skill 发现、校验、冲突诊断与重载。
- 用户/项目记忆中心及模型驱动、仅确认后生效的自动记忆候选。
- SQLite 全文/倒排索引、逐轮混合排序和会话隔离的任务级记忆。
- Shell 工作区边界、删除/移动 Tool、Shell 修改 Diff 和细粒度 MCP Tool 策略。
- 会话层设置、完整自定义模型编辑、Provider Header 脱敏及模型配置损坏恢复。
- MCP 本机环境变量、历史审计、冲突感知数据导入和自动生成第三方许可证清单。
