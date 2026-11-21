# Reader 宿主接缝 v1

本合同供 Moke 宿主与下一阶段的 Reader 消费端对接，继续使用
`moke.readest.embed.v1` 和 `moke.readest.progress.v1`。
当前 Reader gitlink `0b75933bde1712bf693ca811b77ba3c921bd05a5` 未声明下面的能力组，
因此本阶段不开放 managed/prefix 阅读入口，也不代表实际阅读端到端已通过。

## 信任与数据范围

打包 Reader 顶层与宿主是共同可信应用；出版物、远程页面、外部 URL/query 不可信。
claim 只交当前单书所需的来源、资源与进度身份，不交服务器列表、备份、历史令牌或原件。
该合同不为同 origin 的可信 Reader 应用增加严格文件隔离，也不新增 fs/HTTP/sandbox 权限。

能力组必须同时具备：

- `moke.readest.host-launch.v1`
- `moke.readest.resource-base.v1`
- `moke.readest.progress-identity.v1`

能力来自实际打包 Reader manifest 和宿主实现。裸 query 中的能力名、窗口 label、
launch ID 或 URL 都不能赋予权限。旧、未知或错配的 Reader 必须在 prefix bootstrap、
Reader HTTP、打开窗口或导航之前得到明确的不支持结果。

## 两种身份

`SourceIdentity` 是首个异步操作前捕获的不可变运行时身份，包含：

- `libraryBaseUrl`：唯一 `src/lib/discovery/base-url.ts` parser 得到的原始完整 canonical base。
- `savedServerId` 和 `entryRevision`：已保存服务器的稳定 ID 与当前条目版本。
- `sessionRevision`：宿主 JS 会话代。
- 原生会话存在时，持有原 authority 发出的 `nativeLease` 和实际 `documentGeneration`。

不得复制或从 query 重建原生 lease。文档代和 session epoch 是独立栅栏。
有效资源 base/origin、资源 URL、book/resource revision、launch ID 和 request generation
属于本次打开授权，不能替换持久进度身份。

持久进度 key 仅是 `JSON.stringify([libraryBaseUrl, bookId])`。
同 origin 的 `/a` 和 `/b` 即使 bookId 与书籍字节相同，也使用不同 key。
HTTP 资源升级为 HTTPS 后，资源地址保留原 path prefix，进度仍归原 HTTP library base。
离线原件和旧空 namespace 保留；不能证明归属的数据不借给当前库。
同一完整 base 与 book 的本地、远端进度冲突时，只有两端 `updated_at` 都是有效且带明确时区
的 ISO 日期，并且远端严格更新，才用远端覆盖本地。时间相同、缺失或无效时保留本地；
GET 返回后重读原 source 的本地 key，避免在途新进度被旧响应回退。

## 宿主与 Reader 调用顺序

机器可读字段表是 `contract/reader-host-launch.v1.json`，虚构样例位于
`contract/fixtures/reader-host-launch.v1.json`。样例没有运行时授权凭据，不能直接授予 IPC 权限。

| 调用方 | 命令 | 成功后的责任 |
| --- | --- | --- |
| 宿主 | `moke_reader_capabilities` | 核打包能力组，未支持即停止，不先发 prefix bootstrap。 |
| 宿主 | `moke_reader_reserve` | 用现 connection authority 的原 lease 预留单书和原始来源。 |
| 宿主 | `moke_reader_check` | 预检前后复核来源、entry revision、session 和文档代。 |
| 宿主 | `moke_reader_seal` | 冻结本书 resource URL、effective base、revision、size 和 ETag。 |
| 宿主 | `moke_reader_open` | 由后端创建并绑定固定 Reader 文档；创建/导航失败由宿主撤销。 |
| Reader | `moke_reader_claim` | 真实目标 caller 领取单书最小上下文，成功前不请求资源或恢复进度。 |
| Reader | `moke_reader_resource_dispatch` | 每次 HTTP 前用同一 claim 预留精确 sealed 单书 URL 的 GET/HEAD 原 ticket。 |
| Reader | `moke_reader_resource_settle` | 真实 EOF/取消终态后，等待原生 settle ACK；仅能结束自己的 launch ticket。 |
| Reader | `moke_reader_progress` | 用当前 claim 与递增 sequence 提交旧 progress wire。 |
| 宿主 | `moke_reader_progress_take` | 从原生记录取权威 envelope，不能直接信任唤醒事件的 payload。 |
| 宿主 | `moke_reader_progress_ack` | 确认该 sequence 的本地与远端实际结果。 |
| Reader | `moke_reader_closing` | 交最后 sequence，停止继续提交并等待宿主 drain。 |
| 宿主 | `moke_reader_revoke` | 撤销旧代；未确认工作继续占用，不能凭撤销丢失 IO。 |

宿主调用携带现 authority 的 `documentToken`、`leaseToken` 和 `expectedEpoch`。
这些凭据只用于原生校验，不进入持久身份或 Reader URL；source 从原 authority 和宿主
repository 取得，不能靠 payload 自报。Reader 的 `launchId` 仅是查找键，claim 仍核真实
Webview、固定文档与本地文档代。claim 的 `progressOwner` 固定为 `host`。
后端固定 URI 为 `/readest/reader?moke=1&mokeLaunchId=<lookup-id>`；该 query 不携带来源凭据。
同一实际文档重复 claim 幂等返回已有 claim，不增加授权。

原生 reservation、claim 与 relay envelope 分别提供 `ownerDocumentGeneration`（宿主文档代）
和 `documentGeneration`（目标 Reader 文档代，绑定前为 0、首个受控文档为 1）。
二者不能混用；`SourceIdentity.documentGeneration` 仍指捕获它的宿主文档代。
request generation 也不能用 session epoch 冒充；native 未提供它时，队列使用真实本地序号或省略。

resource dispatch/settle 复用现 `Authority.pending`，不是另一套来源 authority 或 HTTP 许可。
Reader 消费端必须把两者接入真实 `nativeHttpRequest` 生命周期：先 dispatch，再 HTTP，
响应到真实 EOF 或取消操作得到终态后才 settle，并等到 settle IPC ACK。
`finally`、`AbortController.abort()`、JS 文档销毁或网络超时本身都不是 EOF/settle 证明。
若原 ticket 未终态，关闭和切服仍被占用；不扩大任意 URL 或 mutation 的 Reader dispatch 权限。

`moke:reader-progress` 的 `{launchId, sequence}` 与 `moke:reader-closing` 的
`{launchId, lastSequence}` 都只是唤醒提示。宿主必须调用 take/check 取得权威记录。
保留原 `reader:page:changed` wire 并不让裸事件获得 managed source 的授权。
relay 的 `payload` 是 `moke.readest.progress.v1` 持久化 wire，使用 `reader_book_id`；
旧裸事件的 `book_id` 别名不属于新 native relay 字段。native 要求本书 ID、schema、reader、
updated_at，拒绝额外字段和超过 64 KiB 的 JSON；可选字段和类型见机器合同。

## 保存与关闭

desktop 的远端进度保存者唯一为宿主，不向 Reader 补传 `mokeServerUrl` 形成双写。
整页和移动端必须有明确且经平台验证的 owner 交接；当前没有该证据时保持对应 gate。

宿主进度队列按完整运行时 source、book、launch、request/document generation 区分。
timer 和 cleanup 使用冻结的 source 与原 native lease，不能重读当前服务器获取发送权限。
本地写与 HTTP 写返回 `complete`、`failed` 或 `unknown`：

- `complete` 表示该写操作得到完成结果。
- `failed` 表示得到明确拒绝结果。
- `unknown` 表示无法确认写入结果，不能重放 mutation，也不能据此释放原生占用。

关闭必须处理明确的 trailing event、已发本地写和 HTTP promises。
完成 JS promises 只说明队列观察到的工作完成，不构成原生来源释放 ACK。
Reader 必须在首次 closing 前监听原生发往实际目标的 `moke:reader-drain-ready`。
首次 `moke_reader_closing` 可以返回 `closing/pending`；原生进度 ACK 和原 HTTP tickets
终态齐备且无 unknown 时，drain-ready hint 唤醒 Reader，用同一 claim 与相同 `lastSequence`
再调用 closing 观察
`returned/complete` 或 `returned/failed`。这不是重放进度 POST，不能改 sequence 或重发 mutation，
也不能依据 hint 直接释放、在未知状态下无界轮询或以超时推定 returned。
hint 发送失败只使 Reader 生命周期 unknown；已成功的原 ticket settle ACK 仍保持成功，
不能为补发通知重放原请求或丢失其终态记录。
销毁 Reader JS 文档、超时、丢失消息或晚到 IPC 都不能冒充正常 returned。
切服、注销、entry 更正、关窗或异常导航使旧代失效；晚到事件不能写入新库。

## 前端适配器

`src/lib/reader-launch.ts` 导出 `createReaderLaunchController`，方法为
`capabilities / reserve / check / seal / open / refresh / revoke / revokeStaleSources / launchOnline / record`。
`launchOnline` 顺序执行预留、预检后复核、密封和打开；`bindReaderSourceRequest` 将 HTTP
绑定到首个 await 前捕获的 source/lease，并在每个响应后复核旧 source。
`reserve` 返回的 `ReaderPreflightPermit` 是本进程品牌化句柄，复制 JSON 或填写 query 不能产生它。

`refresh` 只读已有原生记录；只有 `returned/complete`、`returned/failed` 或
`revoked/complete` 才能证明旧 reservation 已终态。旧 lease 的只读终态观察不恢复 session，
也不允许发新 HTTP。unknown 保持占用并使原 authority 进入待确认状态。

现有 query/`open_reader` 入口调用 `requireHostBoundReaderLaunch`，核真实能力后仍明确
返回 unsupported；后续集成阶段必须有意切到 `readerLaunch.launchOnline`。
只替换 manifest 能力声明不会自动开放旧入口。

`bindReaderSourceLifecycle(readerLaunch)` 订阅实际 store 的来源、entry/session revision、
offline 和连接状态变化，以旧捕获 lease 调用跟踪中的 `revokeStaleSources`；同一 launch 的
撤销不会因再次变化而重复派发。即使注销 HTTP 失败，JS logout 本身也使旧来源失效。

原生 authority 另在原完整 base 下的精确认证请求拿到 HTTP permit **之前**同步撤旧 Reader 代：
`GET/POST /api/user/sign_out`，以及 `POST /api/user/sign_in`、`POST /api/user/sign_up`、
`POST /api/user/reset`、`POST /api/welcome`。
因此 Cookie 的变化不必等 JS 响应后才隔离。普通 book progress POST 不撤销自己的 Reader，
已有 resource/progress/HTTP tickets 仍完整保留；未知结果继续阻断。

## 阶段与验证范围

本阶段只修改 Moke。Reader 消费端仍需实现权威 claim、受限单书 resource dispatch/settle 与
真实 EOF/ACK、完整本地进度 adapter、drain-ready 监听和关闭生命周期；随后由集成阶段有意更新 gitlink、
冻结新组合并验证真实平台。
当前 claim 不含 `restoreProgress` 或远端进度快照。Reader 本地 adapter 必须使用 claim 的原完整
base 与 book 身份；如集成需要远端恢复，由宿主按冻结 source 读取当前单书后显式交接，
不能声称现 claim 已传该快照，也不能让 Reader 借当前全局服务器补取身份。
旧进度 wire 中的字段含义不变，临时 annotation navigation 字段仍不进入持久化。

Node 替身、纯逻辑/Rust 状态测试、浏览器页面证据和真实 Tauri IPC 是不同证据。
测试替身返回新能力组不能证明实际打包 Reader 已匹配；Web 页面通过不能证明原生
caller、文档代、窗口生命周期或平台 owner 交接已通过。具体命令与结果见本次交付报告。

阶段 18 本轮环境没有 DISPLAY/WAYLAND，也没有可用的 Xvfb、tauri-driver 或
WebKitWebDriver，真实 GUI/WebView IPC 未验。MCP 的虚构 IPC 页面门禁证据只覆盖 Web UI；
Rust 实际单元测试/编译结果单列于交付报告，不与真实窗口或已接 Reader 消费端混称。
