# E2EE 本地明文缓存与 sender key 持久化需求

## ADDED Requirements

### Requirement: SDK 必须长期缓存已解密文本明文

SDK MUST 在 E2EE 文本消息解密成功后，将解密后的消息内容写入当前设备本地明文缓存，且该缓存 MUST NOT 设置时间过期。

#### Scenario: 解密历史文本消息后写入缓存

- **Given** 当前设备成功解密一条 E2EE 文本历史消息
- **When** 解密完成
- **Then** SDK MUST 按账号、设备、频道和消息维度写入本地明文缓存
- **And** 缓存内容 MUST 能恢复原始 `MessageContent`
- **And** 缓存 MUST NOT 设置 TTL 或固定过期时间

#### Scenario: 刷新后优先读取文本明文缓存

- **Given** 当前设备本地存在某条 E2EE 文本消息的明文缓存
- **When** Web 刷新后再次拉取到同一条密文消息
- **Then** SDK MUST 优先读取本地明文缓存
- **And** SDK MUST NOT 再执行该消息的密文解密流程

#### Scenario: 明文缓存未命中

- **Given** 当前设备本地不存在某条 E2EE 消息的明文缓存
- **When** Web 拉取到该密文消息
- **Then** SDK MUST 回退到密文解密流程
- **And** 解密成功后 MUST 写入本地明文缓存

### Requirement: 本地明文缓存必须按账号设备频道隔离

SDK MUST 避免不同账号、不同设备、不同频道或不同消息之间复用同一条明文缓存。

#### Scenario: 同一浏览器切换账号

- **Given** 账号 A 已缓存一条 E2EE 明文消息
- **When** 同一浏览器登录账号 B
- **Then** SDK MUST NOT 使用账号 A 的明文缓存展示账号 B 的消息

#### Scenario: 同一账号不同设备

- **Given** 同一账号在设备 X 上存在明文缓存
- **When** 设备 Y 登录并拉取同一频道消息
- **Then** 设备 Y MUST NOT 读取设备 X 的本地明文缓存

### Requirement: SDK 必须长期持久化 sender key

SDK MUST 将群聊 sender key 长期保存在当前设备本地，且 MUST NOT 因时间到期主动删除或刷新 sender key。

#### Scenario: 重启浏览器后读取 sender key

- **Given** 当前设备已经保存某个加密群的 sender key
- **When** 用户重启浏览器并重新打开该加密群
- **Then** SDK MUST 从本地持久化存储读取 sender key
- **And** SDK MUST 优先使用本地 sender key 解密历史消息

#### Scenario: sender key 缺失或失效后恢复

- **Given** 当前设备本地 sender key 缺失、损坏或无法解密当前消息
- **When** SDK 捕获到缺 key 或 key 失效错误
- **Then** SDK MUST 向服务端查询对应的 key envelope
- **And** 查询成功后 MUST 保存新的 sender key
- **And** SDK MUST 使用新的 sender key 重试解密当前消息

#### Scenario: sender key 可用时不得主动拉取

- **Given** 当前设备本地 sender key 可以成功解密当前消息
- **When** SDK 处理该消息
- **Then** SDK MUST NOT 主动调用服务端 envelope lookup

### Requirement: sender key 恢复请求必须去重

SDK MUST 对相同 groupId、senderUid、senderDeviceId、keyId、recipientUid、recipientDeviceId 的 sender key 恢复请求做并发去重。

#### Scenario: 多条消息同时缺少同一个 sender key

- **Given** 当前页多条历史消息都缺少同一个 sender key
- **When** SDK 并发处理这些消息
- **Then** SDK MUST 只发起一次 envelope lookup
- **And** 其他消息 MUST 等待同一个恢复结果

### Requirement: SDK 必须缓存已解密媒体缩略图

SDK MUST 对 E2EE 图片、GIF、自定义表情等媒体消息的解密后缩略图进行本地缓存，缓存不设置时间过期。

#### Scenario: 刷新后展示加密图片缩略图

- **Given** 当前设备曾成功解密并展示某条 E2EE 图片缩略图
- **When** 用户刷新页面并重新打开该会话
- **Then** SDK MUST 优先读取本地缩略图缓存
- **And** SDK MUST 使用缓存内容生成新的 `blob:` URL
- **And** SDK MUST NOT 重复下载同一缩略图密文

#### Scenario: 缩略图缓存未命中

- **Given** 当前设备没有某条 E2EE 图片缩略图缓存
- **When** Web 展示该消息
- **Then** SDK MUST 下载密文缩略图
- **And** SDK MUST 校验 hash 并解密
- **And** SDK MUST 写入缩略图缓存

### Requirement: 普通大文件必须保持点击后懒解密

SDK MUST NOT 在消息接收、历史拉取或页面渲染阶段自动下载并长期缓存普通大文件原文。

#### Scenario: 渲染 E2EE 普通文件消息

- **Given** 历史消息中包含 E2EE 普通文件
- **When** Web 渲染文件卡片
- **Then** SDK MUST 只恢复文件名、大小和 E2EE 媒体元数据
- **And** SDK MUST NOT 下载或解密文件原文

#### Scenario: 用户点击下载 E2EE 普通文件

- **Given** Web 已渲染 E2EE 普通文件卡片
- **When** 用户点击下载
- **Then** SDK MUST 下载密文原文件
- **And** SDK MUST 校验并解密
- **And** SDK MUST 返回本地可下载 URL

### Requirement: SDK 必须支持清理当前账号设备 E2EE 本地数据

SDK MUST 提供清理当前账号当前设备 E2EE 本地数据的能力。

#### Scenario: 用户确认退出登录并清理

- **Given** 当前账号设备存在 E2EE 明文缓存、缩略图缓存和 sender key
- **When** Web 调用 SDK 清理能力
- **Then** SDK MUST 清理当前账号当前设备的 E2EE 本地数据
- **And** SDK MUST 返回清理成功或失败结果

#### Scenario: 清理后重新打开加密群

- **Given** 用户退出登录时已经清理当前账号设备的 E2EE 本地数据
- **When** 用户重新登录并打开加密群
- **Then** SDK MUST 通过密文消息和服务端 key envelope 尝试恢复展示
- **And** 如果 key 无法恢复，SDK MUST 展示无法解密状态

