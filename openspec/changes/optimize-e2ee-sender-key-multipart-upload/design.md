# 设计：JavaScript SDK SenderKey 分片上传

1. `uploadDistributionEnvelopes` 继续保持同一 SenderKey 的并发去重。
2. 信封数不超过 `senderKeyEnvelopeUploadBatchSize` 时调用旧完整上传接口。
3. 超过批大小时生成唯一 `upload_id`，构建 `version=3` compact 分片。
4. 使用有界工作队列上传分片，默认并发 3。
5. 全部分片成功后调用 commit 接口；commit 成功后才写入上传完成缓存。
6. 分片或提交临时失败时抛出错误，发送流程 fail closed。
7. 仅在接口能力缺失，或明确收到 404、405、501 时回退为单次完整上传。

配置新增：

- `senderKeyEnvelopeUploadBatchSize`：默认 100，最小 1。
- `senderKeyEnvelopeUploadConcurrency`：默认 3，最小 1。

诊断不得输出信封正文，只记录接收设备数、分片数、批大小、并发数和耗时。
