# 双向管理接口：dsh-mcp 0.1.4

这是通用 stdio MCP 接口，不依赖某个上游客户端的权限弹窗。上游可以自动作答，也可以转交真人；桥不自行同意。此接口允许有审查的原生 Full access 执行，不允许从 MCP 直接选择无审查的 Full access。

## 1. 查询能力，不执行模型

`dsh_capabilities {}` 返回版本、固定上游基线、guardian/SDK 协议、权限预设、推理档位、问卷策略、限额及验证状态。`verification.profile` 是内容完整性；`verification.packages` 是安装清单；`runtime_verified=false` 表示还没有为本次启动执行原生握手。凭据 presence 与 provider authorization 分开。查询不创建 profile、不初始化状态、不调用模型。

`dsh_self_check {}` 保留部署、状态路径、监督和凭据诊断，并附同类结构化能力数据。不要把工具调用成功或 profile ready 当成任务成功。

## 2. 提交与显式续接

普通 `dsh_task` 必填 prompt、绝对 workspace。提供 session_id 只续接该已验证原生会话；省略总是新建。不从“最近任务”或聊天 metadata 推断身份。

| 字段 | 取值与默认 |
| --- | --- |
| `reasoning_effort` | off / low / high / max；省略采用模型默认。log 非别名；不支持时报错。 |
| `permission_mode` | read-only / workspace-write / auto / inherit；默认 workspace-write。 |
| `upstream_permission_mode` | read-only / workspace-write / full-access；仅 inherit 必填，其他情况下只是上下文。 |
| `sandbox_mode` | 兼容旧调用的 read-only / workspace-write；不能与 permission_mode 同传。旧直接 Full access 值拒绝。 |
| `provider`、`model` | 必须同时提供；省略保持 deepseek-official / deepseek-flash。 |
| `question_policy` | pause（默认）或 continue。 |
| `question_timeout_seconds` | 只用于 continue，默认 120，范围 1–2147483 的整数。 |
| `timeout_ms` | 整个任务期限，默认 20 分钟，1–86400000；包括排队、初始化、问答与退出。 |
| `background` | true 立即返回 task_id；否则最多前台等 30 秒后 detach。 |

Inherit 映射 read-only → read-only、workspace-write → workspace-write、full-access → auto。`upstream_permission_mode` 是调用方逐次声明，`upstreamDeclarationVerified=false`，不是已验证系统授权，也不是显式预设的上限。只声明上游 full-access 而不指定 inherit，仍得到 workspace-write。

```json
{
  "prompt": "检查项目并提出修改建议；需要决策时提问。",
  "workspace": "C:/work/project",
  "permission_mode": "inherit",
  "upstream_permission_mode": "full-access",
  "reasoning_effort": "high",
  "question_policy": "continue",
  "question_timeout_seconds": 120,
  "background": true
}
```

Auto 必须是真正的原生 auto preset。底层 danger-full-access + ask 是其正常状态；审查通过后执行允许。官方 Auto 审查 started PTC 内层工具，不另审外层 run_code 传输。单次允许也可执行原生 Full access body；不改变会话的常设 read-only/workspace-write 预设。原生 never 表示拒绝审批请求，不解释为自动同意。

无运行中配置切换。显式普通会话续接可以选择新的配置；迟答续接使用原任务已记录的配置，不从缺少新字段的旧记录推断。

## 3. 状态与交互发现

`dsh_status` 保留 task_id、state、phase、session_id、报告 cursor/has_more，并增加：

- `waiting_phase`：审批／问卷等待或仍可回答的 continued 请求；它不是终态判据。
- `pending_interaction_count`、`pending_interactions`：总数和有界摘要，完整列表用 dsh_interactions。
- `requested_configuration`：包括 inherit、上游声明和是否显式设置推理深度。
- `effective_configuration`：原生 provider/model/reasoning、preset、sandbox/approval、originalProject 和 effectiveWorkingDirectory。初始化前可为 null。

会话 header 保留原始项目，不能据此声称当前 cwd。最终状态中的有效目录来自工作目录服务与持久化投影。查询成功不等于任务成功；继续检查 state、error、recovery_required，报告读到终态且 has_more=false。

`dsh_interactions` 参数：task_id 必填；列表 cursor 为非负偏移，limit 默认 50、最大 100。摘要包含 request_id、request_digest、type、session_id、call_id、status、submitted、acknowledged 和 continuation_task_id。

指定 request_id 时读取完整请求，`detail_offset` 默认为 0、`detail_limit` 默认为 16384 字节且不能更大。返回 detail_base64、detail_bytes、next_detail_offset 和 has_more。**先 base64 解码每页，再拼接全部字节，最后按 UTF-8 解析 JSON**；页边界可能位于多字节字符中。详情包含完整操作参数、schema、当前 cwd、原生审批理由，或原生问题 ID、options、multiSelect、intent。摘要可能截短，不能用摘要代替审批关键内容。

请求摘要是完整请求（去除 requestDigest 字段）递归排序键后的 canonical JSON 的 SHA-256；它绑定操作内容，不是认证凭据。调用方应获取全部详情后决定。单次 MCP 文本与结构化输出合计 64 KiB；请求存储上限为 8 MiB，超过会拒绝执行，不静默删掉关键字段。

## 4. 提交审批或问卷答案

`dsh_respond` 必填 task_id、request_id、64 位十六进制 request_digest、type。审批 type=approval，只传 decision：allowed-once / rejected / cancelled。没有“永久允许”“本会话全部允许”。

```json
{
  "task_id": "t-example",
  "request_id": "i-00000000000000000000000000000000",
  "request_digest": "0000000000000000000000000000000000000000000000000000000000000000",
  "type": "approval",
  "decision": "allowed-once",
  "wait_ms": 30000
}
```

示例 ID/摘要是占位符，必须替换成读取的真实值。问卷 type=questionnaire，只传 answers，按原生 ID 回答每题一次：

```json
{
  "task_id": "t-example",
  "request_id": "i-00000000000000000000000000000000",
  "request_digest": "0000000000000000000000000000000000000000000000000000000000000000",
  "type": "questionnaire",
  "answers": [
    {"id": "scope", "selected": ["Workspace only"]},
    {"id": "extras", "selected": ["Tests", "Docs"], "custom": "Keep compatibility notes"}
  ],
  "wait_ms": 30000
}
```

selected 使用原生 option label，不使用数组位置；单选只能一个选项或自定义内容，多选保留所有所选项。`selected: []` 且无 custom 是原生明确跳过该题的答案；没有提交整批 answers 则是仍待回答，两者不同。桥做结构校验，DSH 仍执行原生校验。计划审阅 intent 原样保留；问卷同意不产生工具权限或原生父会话授权。

wait_ms 默认 0，最大 30000，只等待回执，不修改任务总期限。返回：

| 字段 | 含义 |
| --- | --- |
| `queued: true`、`state: submitted` | 提交与路由意图已持久化；尚未证明原生应用。 |
| `acknowledged: true`、`state: acknowledged` | 匹配的原生审计／回答事件已持久化，回执已保存。 |
| `state: not-applied` | 原生未采用答复或交付已失效；不是 ACK。 |
| `idempotent: true` | 与已保存答复一致，不重复应用、不创建另一个续接。 |
| `response_digest` | 规范化答复摘要。 |
| `continuation_task_id` | 迟到回答显式创建的新任务 ID；否则 null。 |
| `recovery_required` | 例如路由意图已落盘但续接任务尚未注册；不得自动重放。 |

可重复提交相同答复查询 ACK，或读取详情中的 receipt；冲突答复拒绝。跨任务、类型不符、摘要不符、过期、取消、已失效请求不得应用。排队成功和管道字节 ACK 都不等于原生批准。机器指导不伪装为人类消息，继续使用 dsh_steer 的独立通道。

## 5. Pause、continue 与迟到回答

Pause 使用原生无限等待形式（-1），直到回答、取消或任务总期限。Continue 使用原生超时流程 open → continued → settled；模型传入 timeout 不能覆盖任务策略。超时结果 pending 不是跳过答案或允许操作。原生计划审阅属于阻塞流程，continue 不强制改变它。

请求 continued 后，优先交给仍存活且开放接收的原 agent。原任务已正常完成时，调用 dsh_respond 明确授权创建同会话续接任务：不发送普通 prompt，而是 session/resume → 原生 userQuestions.answer → 持久化 user-question-reply → 新轮次 → 监督退出。返回的新 ID 要独立查询和读取报告；新期限沿用原任务时长（从续接接受时重新计时）。

若原任务尚在关闭入口阶段，续接会在同会话锁后等待，并再次要求原任务正常完成。原任务失败、崩溃、取消或仍有 quarantine，则不执行续接。存在路由记录但无对应任务时不会自动补建；保留证据供人工恢复。普通重新提交不是崩溃重放的替代途径。

**晚答续接可能再次调用模型，Auto 可能额外调用审查模型。** submittedTasks、continuationTaskIds 和模型请求数分开记录；未从 provider dispatch 观察到的计数为 null，不能拿任务数冒充请求数。
