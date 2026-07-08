# 任务清单

## SDK 修复

- [ ] 新增群消息待解密队列，按 recovery key 去重。
- [ ] 对 `Missing sender key`、`Missing message key`、group distribution `OperationError` 做可恢复分类。
- [ ] 新消息解密失败时，先强制 envelope lookup，再提交 repair request。
- [ ] envelope lookup 成功后保存 sender key，并按顺序重试同 key 队列。
- [ ] repair request 提交、lookup、队列重试都需要有退避、TTL 和上限。
- [ ] 收到 `signal_group_distribution` 或 sender key record 更新后，触发相关队列重试。
- [ ] 收到服务端 `e2ee_redistribute_request` 后，立即查询 pending repair 并批量补 envelope。
- [ ] 发送消息前处理 pending repair，但必须有单次预算，避免大群首条消息长时间卡住。
- [ ] 对群设备目录版本变化、identity 修复、新设备注册完成清理相关缓存。

## 测试

- [ ] 单测：同一 recovery key 多条失败消息只触发一次 lookup。
- [ ] 单测：lookup 404 后提交 repair request，队列不丢失。
- [ ] 单测：补回 envelope 后队列消息按顺序恢复。
- [ ] 单测：OperationError 只在 group sender key 场景进入恢复链路。
- [ ] 单测：队列 TTL 和上限生效。
- [ ] 集成脚本：新设备首次登录后，旧加密群收到新消息可自动恢复。
- [ ] 集成脚本：某个发送者换设备后，接收端缺 key 可通过 repair 恢复。
- [ ] 压测脚本：300/1200 人群，repair 只针对缺 key 设备，发送延迟不出现线性全群放大。

