# SDK E2EE 缓存保留、私聊文件懒解密与首次登录同步需求

## MODIFIED Requirements

### Requirement: SDK 退出相关流程不得隐式清理 E2EE 本地数据

SDK MUST NOT 在退出登录相关流程中隐式清理 E2EE 本地缓存、消息缓存或密钥。

#### Scenario: Web 执行退出登录

- **Given** 当前设备存在 E2EE plaintext cache、sender key、Signal session 或媒体缓存
- **When** Web 执行退出登录但未显式调用清理 API
- **Then** SDK MUST 保留这些 E2EE 本地数据

#### Scenario: 显式清理 API

- **Given** 调用方显式调用 SDK 的 E2EE 本地数据清理 API
- **When** SDK 执行该 API
- **Then** SDK MAY 清理指定账号设备范围内的 E2EE 本地数据
- **And** 该行为 MUST NOT 被普通退出登录自动触发

### Requirement: SDK 必须支持私聊 E2EE 普通文件刷新后懒解密

SDK MUST 支持根据持久化消息内容重新加载并解密私聊 E2EE 普通文件原文。

#### Scenario: 无运行时 blob URL 的私聊文件下载

- **Given** 一条私聊 E2EE 普通文件消息只保留持久化消息内容
- **And** 运行时不存在旧的 `blob:` URL
- **When** Web 请求 SDK 加载文件原文
- **Then** SDK MUST 从消息内容读取 E2EE 文件原文 part
- **And** SDK MUST 下载密文、校验并解密
- **And** SDK MUST 返回新的本地可下载 URL

#### Scenario: 文件元数据缺失

- **Given** 私聊文件消息缺少 E2EE 原文 part 或必要加密参数
- **When** Web 请求 SDK 加载文件原文
- **Then** SDK MUST 返回明确的元数据缺失错误
- **And** SDK MUST NOT 返回拼接错误的下载 URL

#### Scenario: 渲染文件卡片

- **Given** Web 只是在渲染私聊 E2EE 普通文件卡片
- **When** SDK 处理消息内容
- **Then** SDK MUST NOT 自动下载文件原文
- **And** SDK MUST NOT 自动解密文件原文

### Requirement: SDK 必须允许调用方跳过首次登录初始化历史同步

SDK MUST 支持 Web 在首次登录初始化阶段跳过自动历史同步，同时不影响后续重连和手动同步。

#### Scenario: 首次登录初始化跳过历史同步

- **Given** Web 判定当前账号设备是首次登录
- **When** Web 配置或调用 SDK 跳过初始化历史同步
- **Then** SDK MUST NOT 主动发起初始化历史拉取

#### Scenario: 断线重连仍同步

- **Given** 当前账号设备已经完成首次登录初始化
- **When** WebSocket 断线后重连
- **Then** SDK MUST 保持原有重连后消息同步行为

#### Scenario: 手动同步

- **Given** Web 已经跳过首次登录初始化历史同步
- **When** Web 明确调用历史同步或加载更多
- **Then** SDK MUST 按原逻辑执行该同步请求

