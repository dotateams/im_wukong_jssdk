# SDK 加密群性能优化需求

### Requirement: SDK 必须支持加密群发送前预热

SDK SHOULD 支持对 E2EE 群进行发送前预热，使 Web 可以在用户点击发送前准备群成员设备、memberHash 和 sender key。

#### Scenario: 打开加密群后预热

- **Given** 当前频道是 E2EE 群
- **When** Web 调用 SDK 预热接口
- **Then** SDK SHOULD 获取并缓存群成员设备信息
- **And** SDK SHOULD 预计算或缓存 memberHash
- **And** SDK SHOULD 长期复用与 memberHash/deviceVersion 匹配的成员设备缓存
- **And** SDK MUST NOT 发送明文消息或泄露密钥材料

#### Scenario: 重复预热同一群

- **Given** 同一群同一 memberHash 的预热正在进行
- **When** Web 再次调用预热接口
- **Then** SDK MUST 复用已有 promise
- **And** SDK MUST NOT 重复发起群成员设备请求

### Requirement: SDK 必须减少加密群连续发送的重复准备

SDK MUST 在同一群成员集合未变化时复用 sender key record 和成员设备缓存，避免连续发送时重复拉取所有成员 key 或重复上传相同 sender-key envelopes。

#### Scenario: 连续发送两条消息

- **Given** 加密群的成员设备和 sender key 已准备完成
- **When** 用户连续发送两条群消息
- **Then** 第二条消息 SHOULD 复用已有 sender key record
- **And** 第二条消息 SHOULD NOT 重复上传相同 sender-key envelopes
- **And** 两条消息都 MUST 以 E2EE 密文发送

### Requirement: 大群 envelope 构建必须有界并发

SDK MUST 对 sender-key envelope 构建设置并发上限，避免大群首次发送时阻塞 UI 或造成 CPU 峰值。

#### Scenario: 1200 人加密群首次发送

- **Given** 一个包含大量 E2EE 设备的加密群
- **When** SDK 需要构建 sender-key envelopes
- **Then** SDK MUST 使用有界并发处理设备加密
- **And** SDK 默认并发 SHOULD 为 10，宿主可配置覆盖
- **And** SDK MUST 批量上传 envelopes
- **And** SDK MUST 在失败时 fail closed，不发送明文 fallback

### Requirement: 历史解密缺 key 恢复必须去重

SDK MUST 对同一群、同一 sender device、同一 keyId、同一接收设备的 sender-key envelope lookup 做并发去重和短期负缓存。

#### Scenario: 打开群时多条历史消息缺同一个 sender key

- **Given** 多条历史消息都缺少同一个 sender key
- **When** Web 并发请求解密这些消息
- **Then** SDK MUST 只发起一次服务端 envelope lookup
- **And** 其他消息 MUST 等待同一个恢复结果
- **And** 如果服务端返回永久不存在，SDK SHOULD 短期缓存该失败结果，避免重复 404 请求

### Requirement: SDK 性能日志不得泄露敏感数据

SDK SHOULD 在 debug 模式下输出群加密性能指标，但 MUST NOT 打印明文、sender key、session key、media key 或完整密文。

#### Scenario: 发送加密群消息

- **When** debug 模式发送 E2EE 群消息
- **Then** SDK SHOULD 输出成员缓存命中、sender key 加载、envelope 构建、上传和总耗时
- **And** 日志 MUST NOT 包含明文消息内容或密钥材料
