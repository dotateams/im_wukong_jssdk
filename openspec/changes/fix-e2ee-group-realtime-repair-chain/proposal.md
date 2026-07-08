# 修复群 E2EE 新消息 sender key 自动修复闭环

## 背景

当前群 E2EE 使用 Signal 类似的 sender key 模型：每个发送设备在每个加密群内拥有自己的 sender key。接收端如果缺少“某个发送者某个设备”的 sender key，就会出现同一个群里其他人消息正常、唯独某个人消息无法解密的情况。

现有代码已经具备一部分恢复能力：

- 接收端解密失败后会尝试 `/v1/e2e/group_sender_keys/envelope/lookup`。
- 查不到 envelope 时会提交 `/v1/e2e/group_sender_keys/repair_requests`。
- 发送端发送前会查询 `/v1/e2e/group_sender_keys/repair_requests/pending`，并批量上传 envelopes。
- 服务端收到 repair request 后会通过 `e2ee_redistribute_request` 催促发送方重分发。

但这条链路还没有形成强闭环。实际表现是：新设备登录后、发送者换设备后、群设备目录缓存过期/失效后，某些新收到的群消息会提示缺少群密钥或无法解密；有时刷新可恢复，有时刷新也不恢复。

## 目标

- 新收到的群 E2EE 消息如果缺 sender key，必须进入可追踪、可重试、有上限的自动修复队列。
- 接收端优先强制拉取最新 envelope；拉不到时提交 repair request，并等待发送方补发。
- 发送端收到或发现 pending repair 后，应尽快批量补发目标设备的 sender key envelope。
- 补发完成后，接收端应自动重试待解密消息，不依赖用户刷新页面。
- 保持 fail-closed：任何时候都不能降级明文发送，不能让服务端接触明文 sender key。
- 保证性能：大群内修复只针对缺 key 的设备，不做每条消息全群重分发。

## 非目标

- 不保证新设备能解密登录前的旧历史消息。
- 不共享同一套账号密钥给多个设备。
- 不把群 sender key 明文上传服务端。
- 不改普通明文群逻辑。
- 不把所有群消息都强制携带全量 distribution。

## 推荐方案

采用“接收端有界队列 + 强制 envelope lookup + repair request + 发送端批量补发 + 接收端自动重试”的闭环。

对比方案：

- 只增加 lookup 重试：实现简单，但发送方漏发 envelope 时仍无法恢复。
- 每条群消息都携带全量分发信息：恢复快，但 300-1200 人大群消息体和发送成本过高。
- 推荐方案：只在失败时修复，补发对象仅为缺 key 的设备，性能和可靠性更平衡。

## 性能约束

- 接收端按 `group_id + sender_uid + sender_device_id + key_id + recipient_device_id` 去重恢复任务。
- 同一 recovery key 同时只允许一个 envelope lookup 或 repair request 在飞。
- 待解密队列必须有上限和 TTL，避免内存无限增长。
- repair request 本地去重窗口建议 30-60 秒。
- 发送端 pending repair 查询需要分页或循环处理，但单次处理要有上限，避免首条消息被大批量补发拖死。
- envelope 上传继续走批量接口，服务端继续分批 upsert。

## 待确认

- 新消息等待密钥时 UI 文案使用“解密中...”还是“等待密钥同步...”。
- 单群待解密队列默认上限是否采用 200 条，全局上限 2000 条。
- 发送端一次最多处理 pending repair 是否采用 500 个设备，超过部分后台继续处理。

