# Deki 多 Agent 使用指南

本文介绍如何在 Deki 中使用多 Agent 协作，把一个复杂任务拆成多个独立调查，由主 Agent 派发给 Worker 并汇总带证据的结果。

如果你需要了解底层数据模型、状态机和后续路线，请同时阅读[多 Agent、后台任务与 Plan 模式完整规划](./multi-agent-background-tasks-plan-mode.md)。

## 当前实现状态

Deki 当前已经实现第一阶段的“只读主从式多 Agent”：

- 主 Agent 可以为当前根任务派发 Worker。
- 每次可以并行派发 1～2 个 Worker。
- 每个根任务默认最多使用 2 个 Worker，可在设置中调整，硬上限为 4 个。
- Worker 使用独立 Session 和最小上下文包，不继承父会话的全部历史。
- Worker 不能继续创建子 Worker。
- Worker 不会直接修改真实工作区。
- Worker 必须返回包含结论、置信度、证据、风险和未解决问题的结构化结果。
- Task Center 会展示 Agent Tree、Worker 状态、Token/Tool 预算和最终结果。

当前可用的 Worker Profile：

| Profile | 主要职责 | 当前工具边界 |
| --- | --- | --- |
| Explorer | 搜索代码、定位实现、收集文件证据 | 只读文件与搜索工具 |
| Tester | 分析测试，并在临时工作区副本中运行受控验证 | 只读工具 + 受控 `test`/`lint`/`typecheck` |
| Reviewer | 审查实现、安全性、边界条件和回归风险 | 只读文件与搜索工具 |

以下能力仍属于后续规划，当前不能依赖：

- Implementer Worker 在独立 worktree 中修改代码。
- 多个写入 Agent 并行实现。
- Integrator 自动合并 Patch、处理冲突和应用结果。
- Worker 递归创建更多 Worker。
- 桌面应用退出后由独立 daemon 继续运行。

## 多 Agent 是如何工作的

多 Agent 模式不是多个 Agent 自由讨论，而是一个受 Task Orchestrator 管理的主从流程：

```text
用户目标
  └── 主 Agent
      ├── Explorer：调查模块 A
      ├── Tester：验证测试 B
      └── Reviewer：检查风险 C
              ↓
        结构化 Worker Result
              ↓
        主 Agent 综合并回答
```

主 Agent 负责：

- 判断任务能否有效拆分。
- 为每个 Worker 提供清晰、互不重叠的目标。
- 分配文件、符号和 Plan Step 线索。
- 等待 Worker 返回结果。
- 比较不同 Worker 的结论。
- 处理矛盾、缺失证据和未解决问题。
- 给用户提供统一结论或继续执行后续步骤。

Worker 只负责给定子任务。它收到的上下文包通常包含：

- 根任务目标。
- 当前子任务目标。
- 完成标准。
- 已知事实和约束。
- 推荐检查的文件或代码符号。
- 关联的 Plan、revision 和 step。
- 时间、Token 和 Tool Call 预算。

## 什么时候适合使用

适合多 Agent 的任务通常可以拆成两个相对独立的调查方向：

- 同时调查业务实现和测试代码。
- 分别检查前端、后端或不同 package。
- 一边定位代码路径，一边分析测试失败。
- 完成实现后，同时检查安全风险和回归风险。
- 对一个方案分别做架构审查与测试覆盖审查。
- 阅读多个互不依赖的协议、依赖或配置来源。

例如：

```text
请并行调查登录失败：
1. Explorer 检查 token 刷新和会话过期逻辑；
2. Tester 分析并运行认证相关测试。

先只读调查，不要修改文件。最后综合根因、证据、风险和建议修复顺序。
```

以下任务通常不适合多 Agent：

- 只需要读取一两个文件的小问题。
- 后一步必须完全依赖前一步结论的串行任务。
- 需要 Worker 共享完整思考过程的任务。
- 希望多个 Worker 同时修改同一批文件。
- 分派和汇总成本高于直接完成的简单任务。
- 无法为每个子任务定义独立完成标准的任务。

## 使用前准备

1. 打开一个项目会话。
2. 确认工作区已经受信任。
3. 在“设置 → Agent”中检查 Worker 配置。
4. 根据任务成本选择主模型和可选的 Worker 模型。
5. 如果需要 Tester，确保 `package.json` 中存在明确的测试、Lint 或类型检查脚本。
6. 如果任务可能进一步修改代码，先确认权限模式和 Git Checkpoint 设置。

默认 Worker 预算为：

| 设置 | 默认值 | 说明 |
| --- | ---: | --- |
| `workerMaxPerRoot` | 2 | 一个根任务最多创建的 Worker 数 |
| `workerTimeoutMs` | 300000 ms | 单个 Worker 运行时间预算 |
| `workerMaxInputTokens` | 64000 | Worker 输入 Token 上限 |
| `workerMaxOutputTokens` | 16000 | Worker 输出 Token 上限 |
| `workerMaxToolCalls` | 50 | Worker Tool 调用上限 |
| `workerModel` | 空 | 留空时继承当前模型 |

预算达到硬上限时，Worker 会停止继续消耗资源；Task Center 会显示预算是否超限。

## 如何启动多 Agent 调查

Deki 当前没有单独的“创建 Worker”按钮。Worker 由主 Agent 根据任务需要，通过受控的 `worker__delegate` Tool 创建。

最可靠的方式是在提示中明确写出：

- 为什么需要并行。
- 希望使用哪些 Profile。
- 每个 Worker 的独立目标。
- 每个目标的完成标准。
- 是否只读。
- 最终由主 Agent 如何汇总。

推荐模板：

```text
请使用两个只读 Worker 并行调查这个问题。

Worker 1（Explorer）：
- 目标：
- 重点文件或符号：
- 完成标准：

Worker 2（Reviewer 或 Tester）：
- 目标：
- 重点风险或测试：
- 完成标准：

约束：
- 不修改真实工作区；
- 所有结论必须给出文件、行号、命令或 Artifact 证据；
- 如果证据不足，明确列为 unresolved；
- 等两个 Worker 都完成后再综合结论。
```

主 Agent 可能判断任务不值得拆分，或者因为预算不足而不创建全部 Worker。此时可以进一步说明子任务之间为什么独立，但不建议为了形式强行并行。

## 示例一：并行定位测试失败

### 用户输入

```text
认证模块的测试最近开始失败。请使用两个只读 Worker 并行调查：

1. Explorer：检查认证实现、token 刷新、时钟和 session 过期逻辑，找出可能导致失败的代码路径。
2. Tester：检查 package.json 中可用脚本，在临时副本中运行最小范围的认证测试，并分析错误输出。

不要修改文件或安装依赖。每个结论必须包含文件位置或测试 Artifact。
最后由主 Agent 给出：
- 最可能根因；
- 支持和反对该判断的证据；
- 最小修复范围；
- 建议验证命令；
- 尚未解决的问题。
```

### 预期过程

1. 主 Agent 创建根 Task。
2. Orchestrator 创建 Explorer 和 Tester Worker Task。
3. 根 Task 进入“等待 Worker”状态。
4. Explorer 搜索代码并提交文件证据。
5. Tester 在临时副本中运行受控测试并保存输出 Artifact。
6. 两个 Worker 完成后，根 Task 恢复运行。
7. 主 Agent 综合结果并返回统一结论。

### 如何检查结果

打开 Task Center，选择根任务：

- “Agent Tree”中应出现两个 Worker。
- “Worker 预算”会显示 Worker、Token 和 Tool 使用量。
- 点击 Worker 可查看结构化 Result。
- `finding` 会显示置信度和对应 evidence。
- Tester 的命令输出可作为 Artifact 查看。
- 根任务的最终 Run Summary 应综合两个 Worker，而不是简单拼接原始对话。

## 示例二：实现后的双重审查

如果主 Agent 已经完成代码修改，可以让两个只读 Worker 对结果进行独立审查：

```text
代码修改已经完成，请不要继续写文件。

并行派发：
1. Reviewer：检查这次修改的权限边界、错误处理、敏感信息泄漏和回归风险。
2. Tester：检查现有测试是否覆盖变更，在临时副本中运行允许的最小测试脚本。

Reviewer 必须引用具体文件和行号；Tester 必须报告实际运行的脚本、退出码和 Artifact。
最后总结哪些问题必须在合并前解决，哪些属于后续优化。
```

这种方式适合把“代码审查”和“验证执行”分开，减少单个 Agent 只验证自己原有判断的倾向。

## 示例三：与 Plan 模式配合

复杂任务可以先生成 Plan，再在某个执行步骤中使用 Worker：

```text
请先在 Plan 模式分析设置系统重构。

计划中需要单独包含：
- Explorer 调查设置分层和 revision 机制；
- Reviewer 调查 IPC、Secret 和向后兼容风险；
- 主 Agent 综合两个 Worker 结果后再确定修改范围；
- 最后运行 typecheck 和相关测试。
```

计划批准并执行后，主 Agent 派发 Worker 时会携带当前 `planId`、revision 和 step ID。Plan 面板会在对应步骤下显示关联 Worker 及其摘要。

完整 Plan 操作见 [Plan 模式使用指南](./plan-mode-usage.md)。

## Worker 结果包含什么

每个 Worker 必须提交结构化结果：

```ts
interface WorkerResult {
  summary: string;
  findings: Array<{
    claim: string;
    confidence: number;
    evidence: Array<FileEvidence | CommandEvidence | ArtifactEvidence | UrlEvidence>;
  }>;
  artifacts: string[];
  risks: string[];
  unresolved: string[];
  recommendedNextActions: string[];
}
```

常见证据类型：

- 文件路径、起止行和相关摘录。
- 实际运行的验证目标、退出码和输出 Artifact。
- Deki 内部保存的报告或测试产物。
- 调查使用的 URL 和说明。

查看结果时，不要只看 `summary`，还应确认：

- 高置信度结论是否有直接证据。
- 文件证据是否确实属于当前工作区。
- Tester 是否真实运行了命令，而不是只建议命令。
- 不同 Worker 的结论是否冲突。
- `unresolved` 是否影响下一步决策。

## Tester 的特殊限制

Tester 不是通用 Shell Agent。它只能运行项目已经在 `package.json` 中声明、且名称符合下列形式的脚本：

```text
test
test:<name>
lint
typecheck
```

例如：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:auth": "vitest run src/auth",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

Tester 会在临时写时复制的工作区副本中运行验证，并使用经过收紧的环境变量。当前实现还存在以下条件：

- 工作区不能超过 2 GiB。
- 不复制 `.git`。
- 拒绝指向工作区外的符号链接。
- 不允许任意脚本名、安装脚本或通用 Bash。
- 写时复制 Tester 当前依赖 macOS 或 Linux 的文件复制能力；Windows 尚不支持该执行方式。

测试在副本中产生的修改不会写回真实工作区。

## Task Center 中的控制

根任务和 Worker 都会进入 Task Store。常见状态：

| 状态 | 含义 |
| --- | --- |
| `running` | 主 Agent 或 Worker 正在运行 |
| `waiting_workers` | 主 Agent 已暂停自身执行，等待 Worker 完成 |
| `waiting_approval` | 某个 Tool 需要用户审批 |
| `waiting_user` | Agent 需要用户补充信息 |
| `paused` | 已暂停，可继续 |
| `succeeded` | 成功完成并保存结果 |
| `failed` | 运行失败，可在允许时重试 |
| `interrupted` | 应用退出、崩溃或 Runtime 中断，可尝试恢复 |
| `cancelled` | 用户取消，不会自动恢复 |

取消根任务会向其 Worker 传播取消。恢复根任务时，已经持久化的 Worker Result 会作为证据重新提供给主 Agent；已经完成的 Worker 派发不会自动重复执行。

## 权限和安全边界

- Worker 权限不能超过父任务权限。
- Explorer 和 Reviewer 只能读取，不允许文件写入、删除、Git 写操作或 Bash。
- Tester 只能使用专用测试 Tool，不能直接操作真实工作区。
- Worker 不加载项目 Skill、项目提示模板或完整记忆上下文。
- Worker 不获得未明确提供的 Secret。
- 所有 Worker 都受时间、Token、Tool Call 和数量预算约束。
- Worker 的证据和 Result 会关联到 Task、Run 和 Session，便于追溯。

只读 Worker 能降低并发写入风险，但它仍会把必要的代码上下文发送给所选模型 Provider。处理敏感项目时，应同时检查模型的数据策略和项目权限。

## 常见问题

### 为什么 Agent 没有创建 Worker？

可能原因：

- 任务太小或不能独立拆分。
- 当前根任务已经达到 Worker 数量上限。
- 预算已经耗尽。
- 当前不是可运行的主 Task。
- Agent 认为串行调查更可靠。

可以重新说明两个独立目标和各自完成标准，但不要要求多个 Worker 同时写同一文件。

### Worker 为什么不能直接修复问题？

当前发布阶段只开放只读 Worker。并行写入需要 worktree 隔离、写集声明、冲突检测和集成审批，这些属于后续阶段。

### Worker 的结果会直接显示在聊天里吗？

默认由主 Agent 汇总后显示。完整 Worker Result、证据、预算和状态在 Task Center 的 Agent Tree 中查看。

### Worker 失败会导致整个任务失败吗？

主 Agent 会收到每个 Worker 的状态和已保存结果。它可以在已有证据足够时继续，也可以说明缺失项；如果关键 Worker 失败且无法继续，根任务可能失败或等待用户处理。

### 可以同时使用后台任务和多 Agent 吗？

可以。后台任务控制根 Task 的交付方式，多 Agent 决定根 Task 内部是否派发 Worker。详细操作见[后台任务使用指南](./background-tasks-usage.md)。

## 相关文档

- [后台任务使用指南](./background-tasks-usage.md)
- [Plan 模式使用指南](./plan-mode-usage.md)
- [多 Agent、后台任务与 Plan 模式完整规划](./multi-agent-background-tasks-plan-mode.md)
- [架构说明](./architecture.md)
- [设置与权限](./settings-and-permissions.md)
