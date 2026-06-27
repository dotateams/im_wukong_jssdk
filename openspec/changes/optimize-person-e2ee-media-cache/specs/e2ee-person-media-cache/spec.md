# E2EE 私聊媒体缓存优化需求

## ADDED Requirements

### Requirement: 私聊媒体元数据恢复必须避免重复消费 Signal message key

当 E2EE 私聊媒体消息已经成功解密并恢复过，SDK MUST 缓存稳定的 `MessageEncryptedMedia` 元数据，使后续恢复同一消息时不需要再次消费私聊 Signal message key。

#### Scenario: 私聊图片刷新后恢复

- **Given** 当前频道类型是私聊
- **And** 一条 E2EE 图片消息已经成功解密并展示过
- **When** 页面刷新或切换会话后再次恢复同一条消息
- **Then** SDK MUST 优先通过本地媒体元数据缓存恢复消息
- **And** SDK MUST NOT 再次消费该消息的 Signal message key

### Requirement: 私聊媒体元数据缓存失败不得影响展示

私聊媒体元数据缓存 MUST 是 best-effort。缓存读取失败、缓存内容损坏或浏览器拒绝写入时，SDK MUST 删除或忽略损坏缓存，并回退到原有解密恢复流程。

#### Scenario: 私聊媒体元数据缓存损坏

- **Given** 当前频道类型是私聊
- **And** 本地存在同一媒体的损坏元数据缓存
- **When** SDK 恢复该媒体消息
- **Then** SDK MUST 删除或忽略损坏缓存
- **And** SDK MUST 继续通过原有解密流程恢复消息

### Requirement: 群聊媒体不得进入私聊媒体元数据缓存路径

本变更不得改变群聊 E2EE 媒体恢复行为。群聊频道中的媒体消息 MUST 保持原有解密和恢复路径，不得依赖本次新增的私聊媒体元数据 plaintext cache。

#### Scenario: 群聊图片恢复

- **Given** 当前频道类型是群聊
- **And** 一条 E2EE 群图片消息包含 `thumb`
- **When** SDK 恢复该群图片消息
- **Then** SDK MUST 保持原有群聊媒体恢复流程
- **And** SDK MUST NOT 通过私聊媒体元数据 plaintext cache 绕过群聊 decrypt 路径

### Requirement: 群聊缩略图缓存行为不得退化

本变更不得关闭或收窄变更前已有的群聊缩略图缓存行为。群聊媒体缩略图仍 MAY 按原有 best-effort 策略复用本地缩略图缓存。

#### Scenario: 群聊图片重复恢复

- **Given** 当前频道类型是群聊
- **And** 同一 E2EE 群图片消息已经成功恢复过缩略图
- **When** SDK 再次恢复该群图片消息
- **Then** SDK MAY 复用已有缩略图缓存
- **And** SDK MUST NOT 因本次私聊优化而强制重新请求缩略图密文

### Requirement: 原图和文件不得默认持久缓存明文

SDK MUST NOT 因进入会话或刷新页面而持久化缓存私聊原图、视频原始内容或文件明文字节。只有用户主动查看原图或下载文件时，SDK MAY 在当前页面生命周期内复用 `blob:` URL。

#### Scenario: 私聊文件刷新后下载

- **Given** 用户曾在私聊中下载过 E2EE 文件
- **When** 用户刷新页面
- **Then** SDK MAY 丢失内存中的 `blob:` URL
- **And** 用户再次点击下载时，SDK MUST 通过密文文件和 E2EE 元数据重新解密
