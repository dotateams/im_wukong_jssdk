# 实施任务

## SDK 预热与缓存

- [x] 明确并测试 `prewarmChannel` 的群成员设备缓存行为。
- [x] 新增发送前准备能力 `prepareGroupSend`，支持 Web 在输入前预热 sender key。
- [x] 为群成员设备列表增加进程内长期缓存。
- [x] 同一群成员设备获取请求做并发去重。
- [x] 群成员变动时支持显式失效缓存。
- [ ] 接入服务端 memberHash/deviceVersion 后，用版本约束缓存有效性。

## SDK 发送性能

- [x] envelope 构建改为有界并发，SDK 默认 10，Web 可配置覆盖。
- [x] envelope 上传继续保持批量上传和并发去重。
- [x] 增加单元测试验证 envelope 构建并发上限。
- [x] 发送前准备只上传 sender-key envelopes，不推进消息链索引。
- [x] sender key record 加载、创建、保存增加性能计时日志。

## SDK 历史解密性能

- [x] 保持 envelope lookup 并发去重和 403/404 负缓存。
- [x] 保持 `Missing message key` 优先本地重推导，再进行 envelope 恢复。
- [ ] 增加专门测试验证历史消息有限并发解密下同一 envelope lookup 只请求一次。

## 压测脚本

- [ ] 增加群成员设备获取耗时测试。
- [x] 增加 300、600、1200 人群 sender-key 准备耗时测试，并覆盖并发 5、10、20、30、50。
- [ ] 增加首次发送和连续发送耗时测试。
- [ ] 增加刷新后打开加密群历史消息恢复耗时测试。
