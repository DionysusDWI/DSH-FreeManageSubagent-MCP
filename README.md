# dsh-mcp 0.1.4

通用本地 stdio MCP 服务，用 DSH Desktop 执行经授权的任务。保留原生会话、持久报告、受监督取消与隔离恢复，并提供审批和结构化问卷的双向管理接口。不依赖特定客户端的弹窗、聊天身份或插件环境变量。

**唯一兼容基线：Windows x64、DSH Desktop 0.2.1-rc.2，参考源码固定于 [687f282e](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。** 本版由 headless 单向输出改用官方 SDK JSON-RPC；仍是每任务一个受监督进程，不启动共享服务或监听端口。

这是预发布版本的源码。零模型测试不等于真实模型验收或发布认证；实际交付以精确候选 ZIP 和新的 `host-acceptance.json` 为准。无 npm 发布，不复用 0.1.3 的验收证明。

## 安装与配置

自包含 Windows x64 ZIP 包含 Node 24.19.0、锁定依赖、Job Object guardian、许可证、manifest 与脱敏测试摘要。DSH Desktop 仍需独立安装。校验 `SHA256SUMS`，解压到固定目录后，在 PowerShell 中运行：

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js config --format mcp-json
.\runtime\node.exe .\bin\dsh-mcp.js config --format server-json
.\runtime\node.exe .\bin\dsh-mcp.js config --format toml
.\runtime\node.exe .\bin\dsh-mcp.js diagnose
```

配置生成只输出实际安装目录的绝对运行路径，不修改客户端。可粘贴到通用 MCP 管理界面；应用后须重新连接。移动安装目录后重新生成。客户端 RPC 期限应大于前台 30 秒等待窗口。

启动、自检、能力查询和配置生成都不初始化 profile。**bootstrap 必须显式执行**，会在 `DSH_HOME` 下安装新的不可变指纹 profile，可能访问网络：

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js bootstrap
```

旧源码、手动 Desktop profile 和旧桥 profile 不会被覆盖。此次更新不自动换供应商或配置 Search/Fetch。桥的默认路由保持 `deepseek-official / deepseek-flash`，不跟随 Desktop 手动选择。SDK profile 显式禁用 GUI 凭据服务和账户路由，保留启动环境凭据策略。`profile ready=true` 只证明内容匹配，不证明有密钥、额度或 API 授权。

若要显式补入 Windows 用户环境中缺失的凭据引用，可生成以下配置；输出只含来源和变量名，不含密钥：

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js config --format toml --credential-env-source windows-user --credential-env-refs DEEPSEEK_API_KEY
```

现有进程变量（包括空字符串）不会被替换。详见[部署与凭据](docs/public/configuration.md)。

## 管理接口

| 工具 | 用途 |
| --- | --- |
| `dsh_task` | 必填 `prompt`、绝对 `workspace`；可显式指定原生 `session_id`、模型、思考深度、权限预设和问卷策略 |
| `dsh_status` | 显式 `task_id`；分页报告、任务阶段、待处理交互、请求配置和实际生效配置；`wait_ms` 最多 30000 |
| `dsh_capabilities` | 只读返回基线、可选配置、包可用性、profile 完整性和验证状态；不创建 profile、不调用模型 |
| `dsh_interactions` | 分页列审批／问卷；用 `request_id` 读取完整请求的无损字节页 |
| `dsh_respond` | 按请求 ID、摘要和类型提交原生单次审批决定或结构化答案；排队不等于 ACK |
| `dsh_steer` | 持久排队机器指导；只有主 agent 成功接收且原生事件持久化后才确认 |
| `dsh_cancel` | 取消指定任务；只有进程树退出已确认才返回 `cancelled` |
| `dsh_self_check` | 只读诊断部署、DSH、profile、凭据引用和监督准备条件 |
| `dsh_quarantine_status` | 只读查看指定任务的隔离、退出证据和快照摘要 |
| `dsh_quarantine_release` | 匹配摘要和经验证退出证据后显式恢复；人工退出声明仅限 CLI |
| `dsh_sessions` | 列管理会话，或指定原生会话的任务元数据；不返回聊天正文 |

完整参数与调用流程见[双向管理接口](docs/public/management-0.1.4.md)。

### 思考深度与权限

- `reasoning_effort`：`off / low / high / max`，不是 `log`。省略时采用模型默认值，状态返回原生解析结果。不支持的组合报错，不静默降档。
- `permission_mode`：`read-only / workspace-write / auto / inherit`，默认 `workspace-write`。
- `inherit` 必须同时声明 `upstream_permission_mode`：`read-only → read-only`、`workspace-write → workspace-write`、`full-access → auto`。这只是调用方声明，不是桥验证的系统授权，也不限制显式选择其他公开预设。仅声明上游 Full access 不会自动启用 Auto。
- MCP **不提供直接 Full access 选择**；原生 Auto 逐次审查通过，或原生单次审批通过后以 Full access 执行，均允许。不因内部出现 `danger-full-access` 而拒绝。
- Auto 使用官方插件与原生 `permissionPresets.set(..., 'auto')`，不自建风险分类器。插件缺失或卸载后停止新执行。原生 PTC 审查内层工具调用，不另审外层 `run_code` 传输。
- 旧 `sandbox_mode` 只保留 `read-only / workspace-write`，与新字段同时传入时报错。旧直接 Full access 输入明确拒绝，不偷偷映射到 Auto。

配置只在启动或显式续接时生效，不支持运行中热切换。问卷同意不等于工具权限批准，原生 `never` 表示拒绝审批请求，不是自动放行。

### 问卷、续接与证据

问卷默认 `pause`，无限等待原生回答，但仍受任务总期限和取消约束。`continue` 默认等 120 秒，然后保留 `open → continued → settled` 生命周期。超时不是跳过答案；任务完成不删除仍可回答的问题。原生计划审阅保留意图且继续阻塞，不伪造超时续行。

`dsh_respond` 优先交给仍存活且开放接收的原 agent；原进程结束后，迟到回答可显式创建同会话续接任务，返回 `continuation_task_id`，使用 `session/resume` 和原生回答服务，不拼造普通提示词。**此调用可能产生新的模型费用**。任务数、续接数不等于模型请求数，Auto 还会产生审查请求；没有观察依据时计数为 unknown/null。

相同答复幂等，冲突、跨任务、过期、已取消或摘要不匹配的答复拒绝。请求、提交和原生回执分别持久化；只有原生审计／回答事件成功 flush 后才 ACK。大请求使用完整详情分页；单次 MCP 文本与结构化内容合计上限为 64 KiB。

## 会话、监督与迁移

省略 `session_id` 总是新建；提供时只续接已验证的真实 DSH 会话，不选择“最近会话”。初始返回中的 session ID 可能为 null。新版用工作目录投影区分原始项目与当前 cwd，不再把会话 header 当作当前目录。

Bridge v3 状态增量扩展，旧记录不改写。`DSH_MCP_NAMESPACE` 默认为 `local`，是可信客户端共享的配置隔离，不是认证或逐聊天自动隔离。同会话串行，重叠真实工作区受跨进程写锁限制。任务总期限包含排队、初始化、问答等待、执行与退出清理。前台最多等 30 秒后 detach；MCP EOF 停本连接任务，不停止其他进程任务。

成功须同时证明原生新轮次成功、最终持久化、关闭执行入口和进程树退出。SDK `idle`、退出码 0 或截断的进度都不足以证明成功。保留 Job Object、IPC 排空和 quarantine；不自动重放崩溃任务。存在隔离时，迟答续接也必须先显式恢复。

升级前排空并停止共享状态目录的旧桥。见 [0.1.4 升级](docs/public/upgrade-0.1.4.md)、[架构与上游差异](docs/architecture.md)、[既有监督恢复机制](docs/public/supervision-0.1.3.md)。

## 开发、验证与发布

源码使用 Node 24.19.0：`npm ci --ignore-scripts`、`npm run build:native`、`npm test`、`npm run validate:package`、`npm run check:guardian`。`npm run check:dsh-contract` 需要安装匹配 DSH，使用临时隔离目录及本地确定性适配器，不调用真实模型。它不认证完整打包 profile 或持久 PTC 子进程的内核级权限行为。

`npm run build:release` 要求干净已提交源码、对应官方 Node LICENSE 和同源测试证明。Actions 先 prepare，另行授权验收，再 publish **相同 ZIP 字节**，不重建、不重用旧证明。本轮实现不自行授权 bootstrap、真实模型验收或发布。

[0.1.4 验证范围](docs/public/v0.1.4-verification.md) · [发行变更](docs/releases/v0.1.4.md) · [精确候选晋升](docs/release-and-acceptance.md)。机器原始证据、密钥、真实会话不进入源码或发行包。历史四次收费验收仍为 **0/4**，不重置、不用于证明新候选。MIT；原署名和贡献者声明保留。
