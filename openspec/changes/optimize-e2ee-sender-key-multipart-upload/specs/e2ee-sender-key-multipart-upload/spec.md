# JavaScript SDK SenderKey 分片上传规范

## ADDED Requirements

### Requirement: SDK 必须按规模选择安全上传路径

JavaScript SDK MUST 根据完整信封数量选择单包上传或分片暂存与提交协议。

- 信封数小于或等于配置批大小时，SDK SHOULD 使用一次性完整上传。
- 信封数大于批大小时，SDK MUST 使用分片暂存与提交协议。
- SDK MUST NOT 通过多次调用旧完整上传接口模拟分片。

#### Scenario: 信封数量超过配置批大小

- **When** JavaScript SDK 需要上传的信封数量超过配置批大小
- **Then** SDK MUST 将完整信封集合拆成有界分片
- **And** SDK MUST 在全部分片暂存成功后只提交一次

### Requirement: SDK 必须在提交成功前阻止消息发送

JavaScript SDK MUST 在 SenderKey 完整分发并提交成功前保持群消息发送关闭。

#### Scenario: 任一分片失败

- **When** 任一 SenderKey 分片上传失败且未恢复
- **Then** SDK MUST NOT 调用提交
- **And** SDK MUST NOT 发送依赖该 SenderKey 的群消息

### Requirement: SDK 必须限制上传并发

JavaScript SDK MUST 使用可配置的有界并发调度 SenderKey 信封分片。

#### Scenario: 1201 个设备

- **When** SDK 使用默认配置上传 1201 个信封
- **Then** 每个分片 MUST NOT 超过 100 个信封
- **And** 同时进行的分片请求 MUST NOT 超过 3 个
- **And** 全部信封 MUST 在一次原子提交后可查询
