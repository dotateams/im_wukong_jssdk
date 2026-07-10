import { MessageContentType } from "./const";
import { Guid } from "./guid";
import WKSDK from "./index";
import { Channel, ChannelTypePerson, MediaMessageContent, Message, MessageContent, SyncOptions, MessageSignalContent, MessageText, CMDContent } from "./model";
import { Packet, RecvackPacket, RecvPacket, SendackPacket, SendPacket, Setting } from "./proto";
import { Task, MessageTask, TaskStatus } from "./task";
import { Md5 } from "md5-typescript";
import { SecurityManager } from "./security";
import { utf8BytesToString } from "./utils/utf8";

export type MessageListener = ((message: Message) => void);
export type MessageStatusListener = ((p: SendackPacket) => void);
export interface DecryptMessageOptions {
    realtime?: boolean;
    recoverableSync?: boolean;
    deferRecoverable?: boolean;
}

interface PendingRealtimeE2EEDecrypt {
    key: string;
    groupKey: string;
    message: Message;
    signalContent: MessageSignalContent;
    context: { message: Message; fromUID: string; senderDeviceId: string | number };
    error: any;
    options: DecryptMessageOptions;
    createdAt: number;
    attempts: number;
}

// FailedGroupE2EEDecrypt 记录已“终态失败”（缺群 sender key）的群消息，等待信封/分发到达后原地重解密，避免必须刷新页面。
interface FailedGroupE2EEDecrypt {
    key: string;
    channelKey: string;
    senderKey: string;
    message: Message;
    signalContent: MessageSignalContent;
    context: { message: Message; fromUID: string; senderDeviceId: string | number };
    failedAt: number;
}

export class ChatManager {
    cmdListeners: ((message: Message) => void)[] = new Array(); // 命令类消息监听
    listeners: MessageListener[] = new Array(); // 收取消息监听
    sendingQueues: Map<number, SendPacket> = new Map(); // 发送中的消息
    sendPacketQueue: Packet[] = [] // 发送队列
    sendTimer: any // 发送定时器
    sendStatusListeners: MessageStatusListener[] = new Array(); // 消息状态监听
    clientSeq: number = 0
    private e2eePlaintextMemoryCache: Map<string, string> = new Map()
    private e2eeDecryptFailureMemoryCache: Map<string, number> = new Map()
    private e2eeDecryptFailureTTL: number = 10 * 60 * 1000
    private realtimeE2EERetryDelays: number[] = [300, 800, 1500, 3000]
    private realtimeE2EEMaxAttempts: number = 5
    private realtimeE2EEPendingTTL: number = 30 * 1000
    private realtimeE2EEOperationRecoverWindow: number = 30 * 1000
    private realtimeE2EERetryChains: Map<string, Promise<void>> = new Map()
    private pendingRealtimeE2EEDecrypts: Map<string, PendingRealtimeE2EEDecrypt> = new Map()
    private pendingRealtimeE2EETimers: Map<string, any> = new Map()
    private pendingRealtimeE2EERetryDelays: number[] = [5000, 15000, 30000, 60000, 120000]
    private pendingRealtimeE2EEMaxTTL: number = 5 * 60 * 1000
    private pendingRealtimeE2EEMaxTotal: number = 2000
    private pendingRealtimeE2EEMaxPerGroup: number = 200
    private readonly e2eeDecryptingText: string = "消息解密中..."
    private readonly e2eeDecryptFailedText: string = "消息无法解密"
    // 终态失败群消息登记表，等待 sender key 到达后原地重解密（无需刷新页面）。
    private failedGroupE2EEDecrypts: Map<string, FailedGroupE2EEDecrypt[]> = new Map()
    private failedGroupE2EERetryTimers: Map<string, any> = new Map()
    private failedGroupE2EERetryAttempts: Map<string, number> = new Map()
    private failedGroupE2EERetryDelays: number[] = [15000, 30000, 60000, 120000]
    private failedGroupE2EEMaxTotal: number = 2000 // 全局上限，覆盖多个大群短时间补 key 场景
    private failedGroupE2EEMaxPerChannel: number = 200 // 单群上限，防止单群噪声挤占
    private failedGroupE2EETTL: number = 15 * 60 * 1000 // 略大于待解密队列 10min

    private static instance: ChatManager
    public static shared() {
        if (!this.instance) {
            this.instance = new ChatManager();
        }
        return this.instance;
    }


    private constructor() {
        if (WKSDK.shared().taskManager) {
            WKSDK.shared().taskManager.addListener((task: Task) => {
                if (task.status === TaskStatus.success) {
                    if (task instanceof MessageTask) {
                        const messageTask = task as MessageTask
                        const sendPacket = this.sendingQueues.get(messageTask.message.clientSeq)
                        if (sendPacket) {
                            sendPacket.payload = messageTask.message.content.encode() // content需要重新编码
                            WKSDK.shared().connectManager.sendPacket(sendPacket)
                        }
                    }
                }
            })
        }

    }

    async onPacket(packet: Packet) {
        if (packet instanceof RecvPacket) {
            const recvPacket = packet as RecvPacket
            const actMsgKey = SecurityManager.shared().encryption(recvPacket.veritifyString)
            const actMsgKeyMD5 = Md5.init(actMsgKey)
            if (actMsgKeyMD5 !== recvPacket.msgKey) {
                console.log(`非法的消息，期望msgKey:${recvPacket.msgKey} 实际msgKey:${actMsgKeyMD5} 忽略此消息！！`);
                return
            }
            recvPacket.payload = SecurityManager.shared().decryption(recvPacket.payload)

            // const setting = Setting.fromUint8(recvPacket.setting)

            const message = new Message(recvPacket)
            this.debugRawReceivedMessage(message)
            this.logRealtimeE2EEStep("收到实时消息", message)
            if (this.deferRealtimeE2EEDecryptIfNeed(message)) {
                this.sendRecvackPacket(recvPacket);
                this.logRealtimeE2EEStep("实时消息已先回ACK并进入后台解密", message)
                WKSDK.shared().channelManager.notifySubscribeIfNeed(message);
                return;
            }
            await this.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true })
            this.logRealtimeE2EEStep("实时消息同步解密完成", message)
            this.sendRecvackPacket(recvPacket);
            if (message.contentType === MessageContentType.cmd) { // 命令类消息分流处理
                if (this.handleE2EEControlCMD(message)) { // E2EE 控制类 CMD 由 SDK 内部消费
                    return;
                }
                this.notifyCMDListeners(message);
                return;
            }
            this.notifyMessageListeners(message);
            WKSDK.shared().channelManager.notifySubscribeIfNeed(message); // 通知指定的订阅者
        } else if (packet instanceof SendackPacket) {
            const sendack = packet as SendackPacket;
            this.sendingQueues.delete(sendack.clientSeq);
            // 发送消息回执
            this.notifyMessageStatusListeners(sendack);
        }

    }

    async syncMessages(channel: Channel, opts: SyncOptions): Promise<Message[]> {
        if (!WKSDK.shared().config.provider.syncMessagesCallback) {
            throw new Error("没有设置WKSDK.shared().config.provider.syncMessagesCallback")
        }
        const messages = await WKSDK.shared().config.provider.syncMessagesCallback!(channel, opts)
        if (messages && messages.length > 0) {
            for (const message of this.messagesForE2EEDecryption(messages)) {
                await this.decryptMessageIfNeeded(message)
            }
        }
        return messages
    }

    async syncMessageExtras(channel: Channel, extraVersion: number) {
        if (!WKSDK.shared().config.provider.syncMessageExtraCallback) {
            throw new Error("没有设置WKSDK.shared().config.provider.syncMessageExtraCallback")
        }
        return WKSDK.shared().config.provider.syncMessageExtraCallback!(channel, extraVersion, 100)
    }

    sendRecvackPacket(recvPacket: RecvPacket) {
        const packet = new RecvackPacket();
        packet.noPersist = recvPacket.noPersist
        packet.syncOnce = recvPacket.syncOnce
        packet.reddot = recvPacket.reddot
        packet.messageID = recvPacket.messageID;
        packet.messageSeq = recvPacket.messageSeq;
        WKSDK.shared().connectManager.sendPacket(packet)
    }

    /**
     *  发送消息
     * @param content  消息内容
     * @param channel 频道对象
     * @param setting  发送设置
     * @returns 完整消息对象
     */
    async send(content: MessageContent, channel: Channel, setting?: Setting): Promise<Message> {
        const opts = new SendOptions()
        opts.setting = setting || new Setting()
        return this.sendWithOptions(content, channel, opts)
    }

    async sendWithOptions(content: MessageContent, channel: Channel, opts: SendOptions) {
        const finalContent = await this.prepareContentForSend(content, channel)
        const packet = this.getSendPacketWithOptions(finalContent, channel, opts)
        const localContent = this.isSignalMessageContent(finalContent) ? content : finalContent

        this.sendingQueues.set(packet.clientSeq, packet);

        const message = Message.fromSendPacket(packet, localContent)
        if (this.isSignalMessageContent(finalContent)) {
            this.cacheE2EEPlaintext(message, finalContent, (finalContent as any).e2eePlaintextContent || content)
        }
        if (finalContent instanceof MediaMessageContent) {
            if(!finalContent.file) { // 没有文件，直接上传
                console.log("不需要上传",finalContent.remoteUrl)
                this.sendSendPacket(packet)
            }else {
                console.log("开始上传")
                const task = WKSDK.shared().config.provider.messageUploadTask(message)
                if (task) {
                    console.log("上传任务添加成功")
                    WKSDK.shared().taskManager.addTask(task)
                }else {
                    console.log("没有实现上传数据源")
                }
            }
           
        } else {
            this.sendSendPacket(packet)
        }
        this.notifyMessageListeners(message)

        return message
    }

    async prepareContentForSend(content: MessageContent, channel: Channel): Promise<MessageContent> {
        const sdk = WKSDK.shared()
        const channelInfo = sdk.channelManager.getChannelInfo(channel)
        const plan = await sdk.config.e2ee.resolveSendPlan(channel, content, {
            channelInfo,
            refreshChannelInfo: async (target: Channel) => {
                await sdk.channelManager.fetchChannelInfo(target)
                return sdk.channelManager.getChannelInfo(target)
            },
        })

        if (plan.action === "plaintext") {
            return content
        }
        if (plan.action === "block") {
            throw new Error(plan.reason || "E2EE send blocked")
        }
        if (content instanceof MediaMessageContent) {
            return sdk.config.e2ee.encryptMediaMessage(content, channel)
        }
        return sdk.config.e2ee.encryptMessage(content, channel)
    }

    async decryptMessageIfNeeded(message: Message, options: DecryptMessageOptions = {}): Promise<void> {
        if (!this.isSignalMessageContent(message.content)) {
            return
        }
        const signalContent = message.content
        const cachedContent = this.restoreCachedE2EEPlaintext(message, signalContent)
        if (cachedContent) {
            try {
                this.logRealtimeE2EEStep("E2EE解密尝试使用本地明文缓存", message, signalContent)
                message.content = await WKSDK.shared().config.e2ee.restoreCachedPlaintext(cachedContent, message.channel)
                ;(message as any).e2eeDecryptFailed = false
                this.debugE2EEDecrypt("cache", message, message.content)
                this.logRealtimeE2EEStep("E2EE本地明文缓存恢复成功", message, signalContent, { contentType: message.contentType })
                return
            } catch (error) {
                this.logRealtimeE2EEStep("E2EE本地明文缓存恢复失败，删除缓存后继续密文解密", message, signalContent, { error: this.e2eeErrorText(error) })
                this.removeE2EEPlaintextCacheKeys(message, signalContent)
                this.debugE2EEDecryptFailure(message, cachedContent, error)
                console.error("[E2EE] cached plaintext restore failed", {
                    channelID: message.channel && message.channel.channelID,
                    channelType: message.channel && message.channel.channelType,
                    fromUID: message.fromUID,
                    senderDeviceId: signalContent.senderDeviceId,
                    messageID: message.messageID,
                    clientMsgNo: message.clientMsgNo,
                }, error)
            }
        }
        this.debugE2EEDecrypt("before", message, message.content)
        const decryptContext = {
            message,
            fromUID: message.fromUID,
            senderDeviceId: signalContent.senderDeviceId,
        }
        try {
            const decryptStartedAt = Date.now()
            this.logRealtimeE2EEStep("E2EE开始调用解密适配器", message, signalContent)
            message.content = await WKSDK.shared().config.e2ee.decryptMessage(message.content, message.channel, decryptContext)
            this.logRealtimeE2EEStep("E2EE解密适配器返回成功", message, signalContent, { costMs: Date.now() - decryptStartedAt, contentType: message.contentType })
            this.cacheE2EEPlaintext(message, signalContent, message.content)
            this.debugE2EEDecrypt("after", message, message.content)
            ;(message as any).e2eePendingDecrypt = false
            ;(message as any).e2eeDecrypting = false
            ;(message as any).e2eeDecryptFailed = false
            ;(message as any).e2eeDecryptError = undefined
            await this.retryPendingE2EEDecryptsAfterGroupDistribution(message, signalContent)
        } catch (error) {
            this.logRealtimeE2EEStep("E2EE解密适配器返回失败", message, signalContent, { error: this.e2eeErrorText(error) })
            if (this.isRecoverableE2EEPath(options) && options.deferRecoverable && this.isRecoverableRealtimeE2EEError(error, message, signalContent, options)) {
                this.logRealtimeE2EEStep("E2EE失败可恢复，保持解密中占位并进入异步修复队列", message, signalContent, { error: this.e2eeErrorText(error) })
                this.buildE2EEDecryptSkeletonContent(message)
                this.enqueueRealtimeE2EERetry(message, signalContent, decryptContext, error, options)
                return
            }
            const realtimeRetry = await this.retryRealtimeE2EEDecryptIfRecoverable(
                message,
                signalContent,
                decryptContext,
                error,
                options,
            )
            if (realtimeRetry.recovered) {
                this.logRealtimeE2EEStep("E2EE实时重试恢复成功", message, signalContent)
                return
            }
            if (realtimeRetry.error) {
                error = realtimeRetry.error
            } else if (this.isRecoverableRealtimeE2EEError(error, message, signalContent, options)) {
                this.logRealtimeE2EEStep("E2EE尝试同步恢复缺失密钥", message, signalContent, { error: this.e2eeErrorText(error) })
                const recovered = await this.recoverRealtimeE2EEDecryptFailure(message, signalContent, decryptContext, error, options)
                if (recovered) {
                    try {
                        const retryStartedAt = Date.now()
                        this.logRealtimeE2EEStep("E2EE密钥恢复成功，开始二次解密", message, signalContent)
                        message.content = await WKSDK.shared().config.e2ee.decryptMessage(signalContent, message.channel, decryptContext)
                        this.logRealtimeE2EEStep("E2EE二次解密成功", message, signalContent, { costMs: Date.now() - retryStartedAt, contentType: message.contentType })
                        this.cacheE2EEPlaintext(message, signalContent, message.content)
                        this.debugE2EEDecrypt("after", message, message.content)
                        ;(message as any).e2eeDecryptFailed = false
                        ;(message as any).e2eeDecryptError = undefined
                        return
                    } catch (retryError) {
                        this.logRealtimeE2EEStep("E2EE二次解密失败", message, signalContent, { error: this.e2eeErrorText(retryError) })
                        error = retryError
                    }
                }
            }
            this.logRealtimeE2EEStep("E2EE解密最终失败，显示用户友好失败文案", message, signalContent, { error: this.e2eeErrorText(error) })
            this.finalizeE2EEDecryptFailure(message, signalContent, error, options)
        }
    }

    private enqueueRealtimeE2EERetry(
        message: Message,
        signalContent: MessageSignalContent,
        context: { message: Message; fromUID: string; senderDeviceId: string | number },
        firstError: any,
        options: DecryptMessageOptions,
    ): void {
        const key = this.realtimeRetryKey(message, signalContent)
        const previous = this.realtimeE2EERetryChains.get(key) || Promise.resolve()
        const chain = previous.catch(() => undefined).then(async () => {
            const result = await this.retryRealtimeE2EEDecryptIfRecoverable(
                message,
                signalContent,
                context,
                firstError,
                { ...options, deferRecoverable: false },
            )
            if (result.recovered) {
                this.notifyMessageListeners(message)
                return
            }
            const finalError = result.error || firstError
            if (this.isRecoverableRealtimeE2EEError(finalError, message, signalContent, { ...options, realtime: true })) {
                this.buildE2EEDecryptSkeletonContent(message)
                this.addPendingRealtimeE2EEDecrypt(message, signalContent, context, finalError, { ...options, realtime: true })
            } else {
                this.finalizeE2EEDecryptFailure(message, signalContent, finalError, { ...options, realtime: true })
            }
            this.notifyMessageListeners(message)
        }).finally(() => {
            if (this.realtimeE2EERetryChains.get(key) === chain) {
                this.realtimeE2EERetryChains.delete(key)
            }
        })
        this.realtimeE2EERetryChains.set(key, chain)
    }

    deferRealtimeE2EEDecryptIfNeed(message: Message): boolean {
        if (!this.isSignalMessageContent(message.content)) {
            return false
        }
        const signalContent = message.content as MessageSignalContent
        if (!this.isUserVisibleSignalContent(signalContent)) {
            this.logRealtimeE2EEStep("实时E2EE消息是内部控制消息，不展示占位", message, signalContent)
            return false
        }
        this.logRealtimeE2EEStep("实时E2EE消息先展示解密中占位", message, signalContent)
        this.buildE2EEDecryptSkeletonContent(message)
        this.notifyMessageListeners(message)
        setTimeout(() => {
            this.decryptRealtimeE2EEMessageInBackground(message, signalContent).catch((error) => {
                this.logRealtimeE2EEStep("实时E2EE后台解密异常，显示失败占位", message, signalContent, { error: this.e2eeErrorText(error) })
                this.finalizeE2EEDecryptFailure(message, signalContent, error, { realtime: true })
                this.notifyMessageListeners(message)
            })
        }, 0)
        return true
    }

    private isUserVisibleSignalContent(signalContent: MessageSignalContent): boolean {
        if (signalContent.realContentType === MessageContentType.cmd) {
            return false
        }
        return signalContent.messageType !== "signal_group_distribution"
    }

    private async decryptRealtimeE2EEMessageInBackground(message: Message, signalContent: MessageSignalContent): Promise<void> {
        const startedAt = Date.now()
        this.logRealtimeE2EEStep("实时E2EE后台解密开始", message, signalContent)
        message.content = signalContent
        await this.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true })
        this.logRealtimeE2EEStep("实时E2EE后台解密结束", message, signalContent, { costMs: Date.now() - startedAt, contentType: message.contentType })
        if (message.contentType === MessageContentType.cmd) {
            if (this.handleE2EEControlCMD(message)) {
                this.logRealtimeE2EEStep("实时E2EE后台解密结果为内部控制消息，已内部消费", message, signalContent, { costMs: Date.now() - startedAt })
                return
            }
            this.logRealtimeE2EEStep("实时E2EE后台解密结果为CMD，通知CMD监听", message, signalContent, { costMs: Date.now() - startedAt })
            this.notifyCMDListeners(message)
            return
        }
        this.logRealtimeE2EEStep("实时E2EE后台解密成功，通知UI原地替换", message, signalContent, { costMs: Date.now() - startedAt })
        this.notifyMessageListeners(message)
        WKSDK.shared().channelManager.notifySubscribeIfNeed(message)
    }

    private logRealtimeE2EEStep(step: string, message: Message, signalContent?: MessageSignalContent, extra?: any): void {
        try {
            const content = signalContent || (this.isSignalMessageContent(message.content) ? message.content as MessageSignalContent : undefined)
            const payload = {
                step,
                channelID: message.channel && message.channel.channelID,
                channelType: message.channel && message.channel.channelType,
                fromUID: message.fromUID,
                senderDeviceId: content && content.senderDeviceId,
                messageID: message.messageID,
                clientMsgNo: message.clientMsgNo,
                messageSeq: message.messageSeq,
                messageType: content && content.messageType,
                realContentType: content && content.realContentType,
                pending: (message as any).e2eePendingDecrypt === true,
                failed: (message as any).e2eeDecryptFailed === true,
                ...(extra || {}),
            }
            console.info("[E2EE调试]", payload)
        } catch (_error) {
            // ignore log failures
        }
    }

    private e2eeErrorText(error: any): string {
        if (!error) {
            return ""
        }
        if (error.message) {
            return String(error.message)
        }
        return String(error)
    }

    async retryPendingE2EEDecrypts(groupKey?: string): Promise<number> {
        const entries = Array.from(this.pendingRealtimeE2EEDecrypts.values())
            .filter((entry) => !groupKey || entry.groupKey === groupKey)
        let recovered = 0
        for (const entry of entries) {
            if (await this.retryOnePendingE2EEDecrypt(entry)) {
                recovered++
            }
        }
        return recovered
    }

    private addPendingRealtimeE2EEDecrypt(
        message: Message,
        signalContent: MessageSignalContent,
        context: { message: Message; fromUID: string; senderDeviceId: string | number },
        error: any,
        options: DecryptMessageOptions,
    ): void {
        if (!this.isRecoverableRealtimeE2EEError(error, message, signalContent, options)) {
            return
        }
        const key = this.e2eeDecryptFailureCacheKey(message, signalContent)
        if (!key) {
            return
        }
        const existing = this.pendingRealtimeE2EEDecrypts.get(key)
        const entry: PendingRealtimeE2EEDecrypt = existing || {
            key,
            groupKey: this.realtimeRetryKey(message, signalContent),
            message,
            signalContent,
            context,
            error,
            options,
            createdAt: Date.now(),
            attempts: 0,
        }
        entry.error = error
        entry.options = options
        this.pendingRealtimeE2EEDecrypts.set(key, entry)
        this.enforcePendingRealtimeE2EEDecryptCaps()
        this.schedulePendingRealtimeE2EERetry(entry)
    }

    private enforcePendingRealtimeE2EEDecryptCaps(): void {
        const entries = Array.from(this.pendingRealtimeE2EEDecrypts.values())
            .sort((a, b) => a.createdAt - b.createdAt)
        const perGroupCount = new Map<string, number>()
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]
            const count = (perGroupCount.get(entry.groupKey) || 0) + 1
            perGroupCount.set(entry.groupKey, count)
            if (count > this.pendingRealtimeE2EEMaxPerGroup) {
                this.finalizePendingRealtimeE2EEDecrypt(entry)
            }
        }
        while (this.pendingRealtimeE2EEDecrypts.size > this.pendingRealtimeE2EEMaxTotal) {
            let oldest: PendingRealtimeE2EEDecrypt | undefined
            this.pendingRealtimeE2EEDecrypts.forEach((entry) => {
                if (!oldest || entry.createdAt < oldest.createdAt) {
                    oldest = entry
                }
            })
            if (!oldest) {
                return
            }
            this.finalizePendingRealtimeE2EEDecrypt(oldest)
        }
    }

    private schedulePendingRealtimeE2EERetry(entry: PendingRealtimeE2EEDecrypt): void {
        if (this.pendingRealtimeE2EETimers.get(entry.key)) {
            return
        }
        const age = Date.now() - entry.createdAt
        if (age > this.pendingRealtimeE2EEMaxTTL) {
            this.finalizePendingRealtimeE2EEDecrypt(entry)
            return
        }
        const delay = this.pendingRealtimeE2EERetryDelays[
            Math.min(entry.attempts, this.pendingRealtimeE2EERetryDelays.length - 1)
        ] || this.pendingRealtimeE2EERetryDelays[this.pendingRealtimeE2EERetryDelays.length - 1] || 30000
        const timer = setTimeout(async () => {
            this.pendingRealtimeE2EETimers.delete(entry.key)
            const current = this.pendingRealtimeE2EEDecrypts.get(entry.key)
            if (!current) {
                return
            }
            const recovered = await this.retryOnePendingE2EEDecrypt(current)
            if (!recovered && this.pendingRealtimeE2EEDecrypts.has(entry.key)) {
                this.schedulePendingRealtimeE2EERetry(current)
            }
        }, delay)
        this.pendingRealtimeE2EETimers.set(entry.key, timer)
    }

    private async retryOnePendingE2EEDecrypt(entry: PendingRealtimeE2EEDecrypt): Promise<boolean> {
        if (Date.now() - entry.createdAt > this.pendingRealtimeE2EEMaxTTL) {
            this.finalizePendingRealtimeE2EEDecrypt(entry)
            return false
        }
        entry.attempts++
        try {
            await this.attemptInPlaceRedecrypt(entry.message, entry.signalContent, entry.context, entry.error, entry.options)
            this.clearPendingRealtimeE2EEDecrypt(entry.key)
            this.notifyMessageListeners(entry.message)
            return true
        } catch (error) {
            entry.error = error
            if (!this.isRecoverableRealtimeE2EEError(error, entry.message, entry.signalContent, entry.options)) {
                this.clearPendingRealtimeE2EEDecrypt(entry.key)
            }
            return false
        }
    }

    private finalizePendingRealtimeE2EEDecrypt(entry: PendingRealtimeE2EEDecrypt): void {
        this.clearPendingRealtimeE2EEDecrypt(entry.key)
        this.finalizeE2EEDecryptFailure(entry.message, entry.signalContent, entry.error, entry.options)
        this.notifyMessageListeners(entry.message)
    }

    // attemptInPlaceRedecrypt 先尝试恢复缺失的群 sender key，再原地重解密该消息并更新其状态；
    // 成功则原地写回 content 并清除失败标记，失败则抛出（由调用方决定重试/清理）。供 pending 与 finalized 两条重试路径共用。
    private async attemptInPlaceRedecrypt(
        message: Message,
        signalContent: MessageSignalContent,
        context: { message: Message; fromUID: string; senderDeviceId: string | number },
        error: any,
        options: DecryptMessageOptions,
    ): Promise<void> {
        await this.recoverRealtimeE2EEDecryptFailure(message, signalContent, context, error, { ...options, realtime: true })
        message.content = await WKSDK.shared().config.e2ee.decryptMessage(signalContent, message.channel, context)
        this.cacheE2EEPlaintext(message, signalContent, message.content)
        this.debugE2EEDecrypt("after", message, message.content)
        ;(message as any).e2eePendingDecrypt = false
        ;(message as any).e2eeDecryptFailed = false
        ;(message as any).e2eeDecryptError = undefined
    }

    private clearPendingRealtimeE2EEDecrypt(key: string): void {
        this.pendingRealtimeE2EEDecrypts.delete(key)
        const timer = this.pendingRealtimeE2EETimers.get(key)
        if (timer) {
            clearTimeout(timer)
            this.pendingRealtimeE2EETimers.delete(key)
        }
    }

    private async retryPendingE2EEDecryptsAfterGroupDistribution(message: Message, signalContent: MessageSignalContent): Promise<void> {
        const content = message.content as CMDContent | any
        if (!content || content.contentType !== MessageContentType.cmd || content.cmd !== "signal_group_distribution") {
            return
        }
        const groupKey = [
            (content.param && content.param.group_id) || (message.channel && message.channel.channelID),
            message.channel && message.channel.channelType,
            message.fromUID || "",
            signalContent.senderDeviceId || "",
        ].join(":")
        try {
            await this.retryPendingE2EEDecrypts(groupKey)
            // 同时治愈已终态失败、来自同一发送方的历史消息（无需刷新页面）。
            await this.retryFailedGroupE2EEDecrypts(groupKey)
        } catch (error) {
            if (WKSDK.shared().config.debug) {
                console.warn("[E2EE] retry pending decrypt after group distribution failed", {
                    groupKey,
                    channelID: message.channel && message.channel.channelID,
                    channelType: message.channel && message.channel.channelType,
                }, error)
            }
        }
    }

    // handleE2EEControlCMD 处理服务端下发的 E2EE 控制类 CMD：
    // - e2eeDevicesChanged：群设备集变更（如新设备注册）。失效设备目录 + 清该群 repair 缓存，
    //   并尝试重解密该群终态失败的消息（此时可能已能补拉到信封）。
    // - e2eeRedistributeRequest：服务端催促本端作为发送方立即重新分发某群 sender key。
    // 返回 true 表示该 CMD 已被内部消费（不再向上层业务 cmd 监听透传）。
    private handleE2EEControlCMD(message: Message): boolean {
        const content = message.content as CMDContent | any
        if (!content || content.contentType !== MessageContentType.cmd) {
            return false
        }
        const param = content.param || {}
        if (content.cmd === "e2eeDevicesChanged") {
            const groupId = param.group_id || (message.channel && message.channel.channelID)
            const channelType = param.channel_type !== undefined ? param.channel_type : (message.channel && message.channel.channelType)
            this.onE2EEDevicesChanged(groupId, channelType).catch((error) => {
                if (WKSDK.shared().config.debug) {
                    console.warn("[E2EE] handle e2eeDevicesChanged failed", { groupId, channelType }, error)
                }
            })
            return true
        }
        if (content.cmd === "e2eeRedistributeRequest") {
            const groupId = param.group_id || (message.channel && message.channel.channelID)
            const channelType = param.channel_type !== undefined ? param.channel_type : (message.channel && message.channel.channelType)
            this.onE2EERedistributeRequest(groupId, channelType).catch((error) => {
                if (WKSDK.shared().config.debug) {
                    console.warn("[E2EE] handle e2eeRedistributeRequest failed", { groupId, channelType }, error)
                }
            })
            return true
        }
        return false
    }

    private async onE2EEDevicesChanged(groupId: any, channelType: any): Promise<void> {
        if (!groupId) {
            return
        }
        const channel = new Channel(String(groupId), Number(channelType))
        const e2ee = WKSDK.shared().config.e2ee as any
        // 失效发送方设备目录，使下次发送重算 memberHash 并把新设备纳入分发。
        if (e2ee && typeof e2ee.invalidateGroupMemberCache === "function") {
            try { e2ee.invalidateGroupMemberCache(channel) } catch (_error) { /* ignore */ }
        }
        // 清该群 repair 请求去抖缓存，使下次发送重新轮询 repair 请求。
        if (e2ee && typeof e2ee.invalidateGroupRepairRequestCache === "function") {
            try { e2ee.invalidateGroupRepairRequestCache(channel) } catch (_error) { /* ignore */ }
        }
        const channelKey = [String(groupId), Number(channelType)].join(":")
        await this.retryFailedGroupE2EEDecrypts(channelKey)
    }

    private async onE2EERedistributeRequest(groupId: any, channelType: any): Promise<void> {
        if (!groupId) {
            return
        }
        const e2ee = WKSDK.shared().config.e2ee as any
        if (e2ee && typeof e2ee.redistributeGroup === "function") {
            await e2ee.redistributeGroup(new Channel(String(groupId), Number(channelType)))
        }
    }

    private realtimeRetryKey(message: Message, signalContent: MessageSignalContent): string {
        return [
            message.channel && message.channel.channelID,
            message.channel && message.channel.channelType,
            message.fromUID || "",
            signalContent.senderDeviceId || "",
        ].join(":")
    }

    private finalizeE2EEDecryptFailure(
        message: Message,
        signalContent: MessageSignalContent,
        error: any,
        options: DecryptMessageOptions = {},
    ): void {
        ;(message as any).e2eePendingDecrypt = false
        ;(message as any).e2eeDecryptFailed = true
        ;(message as any).e2eeDecryptError = error
        this.debugE2EEDecryptFailure(message, signalContent, error)
        const shouldLog = this.markE2EEDecryptFailureIfNeeded(message, signalContent, error)
        if (shouldLog) {
            const detail = {
                channelID: message.channel && message.channel.channelID,
                channelType: message.channel && message.channel.channelType,
                fromUID: message.fromUID,
                senderDeviceId: signalContent.senderDeviceId,
                messageID: message.messageID,
                clientMsgNo: message.clientMsgNo,
            }
            if (this.isMissingSenderKeyError(error)) {
                if (WKSDK.shared().config.debug) {
                    console.warn("[E2EE] decrypt missing sender key", detail, error)
                }
            } else {
                console.error("[E2EE] decrypt failed", detail, error)
            }
        }
        message.content = this.buildE2EEDecryptFailureContent(error, options)
        // 缺群 sender key 是可恢复的（等信封/分发到达）：登记该消息，待后续 CMD 触发原地重解密，避免必须刷新页面。
        if (this.shouldTrackRecoverableGroupE2EEFailure(error, message, signalContent, options)) {
            this.trackFailedGroupE2EEDecrypt(message, signalContent, error)
        }
    }

    private shouldTrackRecoverableGroupE2EEFailure(
        error: any,
        message: Message,
        signalContent: MessageSignalContent,
        options: DecryptMessageOptions = {},
    ): boolean {
        if (this.isMissingSenderKeyError(error)) {
            return true
        }
        return this.isRecoverableE2EEPath(options)
            && this.isGroupSignalMessage(message, signalContent)
            && this.isRecoverableRealtimeE2EEError(error, message, signalContent, options)
    }

    private groupChannelKey(message: Message): string {
        return [
            message.channel && message.channel.channelID,
            message.channel && message.channel.channelType,
        ].join(":")
    }

    // trackFailedGroupE2EEDecrypt 登记一条终态失败的群消息，带全局/单群/TTL 上限与 FIFO 淘汰，内存有界。
    private trackFailedGroupE2EEDecrypt(message: Message, signalContent: MessageSignalContent, error: any): void {
        const context = { message, fromUID: message.fromUID, senderDeviceId: signalContent.senderDeviceId || "" }
        const channelKey = this.groupChannelKey(message)
        const key = this.e2eeDecryptFailureCacheKey(message, signalContent)
        if (!key) {
            return
        }
        this.pruneFailedGroupE2EEDecrypts()
        const entry: FailedGroupE2EEDecrypt = {
            key,
            channelKey,
            senderKey: this.realtimeRetryKey(message, signalContent),
            message,
            signalContent,
            context,
            failedAt: Date.now(),
        }
        const list = this.failedGroupE2EEDecrypts.get(channelKey) || []
        // 去重：同一 key 覆盖旧条目（保留最新的 Message 引用）。
        const existingIndex = list.findIndex((item) => item.key === key)
        if (existingIndex >= 0) {
            list[existingIndex] = entry
        } else {
            list.push(entry)
            if (list.length > this.failedGroupE2EEMaxPerChannel) {
                list.shift() // 单群 FIFO 淘汰
            }
        }
        this.failedGroupE2EEDecrypts.set(channelKey, list)
        this.enforceFailedGroupE2EEGlobalCap()
        this.scheduleFailedGroupE2EERetry(channelKey)
    }

    private failedGroupE2EETotal(): number {
        let total = 0
        this.failedGroupE2EEDecrypts.forEach((list) => { total += list.length })
        return total
    }

    // pruneFailedGroupE2EEDecrypts 清理过期条目与空分组。
    private pruneFailedGroupE2EEDecrypts(): void {
        const now = Date.now()
        this.failedGroupE2EEDecrypts.forEach((list, channelKey) => {
            const kept = list.filter((item) => now - item.failedAt <= this.failedGroupE2EETTL)
            if (kept.length === 0) {
                this.failedGroupE2EEDecrypts.delete(channelKey)
                this.clearFailedGroupE2EERetryTimer(channelKey)
            } else if (kept.length !== list.length) {
                this.failedGroupE2EEDecrypts.set(channelKey, kept)
            }
        })
    }

    // enforceFailedGroupE2EEGlobalCap 全局 FIFO 淘汰最旧的条目，保证总量有界。
    private enforceFailedGroupE2EEGlobalCap(): void {
        while (this.failedGroupE2EETotal() > this.failedGroupE2EEMaxTotal) {
            let oldestChannel: string | undefined
            let oldestAt = Infinity
            this.failedGroupE2EEDecrypts.forEach((list, channelKey) => {
                if (list.length > 0 && list[0].failedAt < oldestAt) {
                    oldestAt = list[0].failedAt
                    oldestChannel = channelKey
                }
            })
            if (oldestChannel === undefined) {
                return
            }
            const list = this.failedGroupE2EEDecrypts.get(oldestChannel)!
            list.shift()
            if (list.length === 0) {
                this.failedGroupE2EEDecrypts.delete(oldestChannel)
                this.clearFailedGroupE2EERetryTimer(oldestChannel)
            }
        }
    }

    // retryFailedGroupE2EEDecrypts 对指定群（channelKey）或指定发送方（senderKey）的终态失败消息尝试原地重解密。
    // 传入的 matchKey 既可能是 groupChannelKey（channelID:channelType，来自 devices-changed 提示），
    // 也可能是 realtimeRetryKey（含发送方，来自某发送方的 group distribution）。
    private async retryFailedGroupE2EEDecrypts(matchKey?: string): Promise<number> {
        this.pruneFailedGroupE2EEDecrypts()
        const targets: FailedGroupE2EEDecrypt[] = []
        this.failedGroupE2EEDecrypts.forEach((list, channelKey) => {
            for (const item of list) {
                if (!matchKey || channelKey === matchKey || item.senderKey === matchKey) {
                    targets.push(item)
                }
            }
        })
        let recovered = 0
        for (const entry of targets) {
            try {
                await this.attemptInPlaceRedecrypt(entry.message, entry.signalContent, entry.context, undefined, { realtime: true })
                this.removeFailedGroupE2EEDecrypt(entry)
                this.notifyMessageListeners(entry.message)
                recovered++
            } catch (error) {
                // 仍缺 key：保留条目，等待后续信号。不可恢复错误则移除，避免无谓占位。
                if (!this.isRecoverableRealtimeE2EEError(error, entry.message, entry.signalContent, { realtime: true })) {
                    this.removeFailedGroupE2EEDecrypt(entry)
                }
            }
        }
        this.rescheduleFailedGroupE2EERetries(matchKey)
        return recovered
    }

    private scheduleFailedGroupE2EERetry(channelKey: string): void {
        if (!channelKey || this.failedGroupE2EERetryTimers.get(channelKey)) {
            return
        }
        const list = this.failedGroupE2EEDecrypts.get(channelKey)
        if (!list || list.length === 0) {
            this.failedGroupE2EERetryAttempts.delete(channelKey)
            return
        }
        const attempt = this.failedGroupE2EERetryAttempts.get(channelKey) || 0
        const delays = this.failedGroupE2EERetryDelays && this.failedGroupE2EERetryDelays.length > 0
            ? this.failedGroupE2EERetryDelays
            : [30000]
        const delay = delays[Math.min(attempt, delays.length - 1)] || delays[delays.length - 1] || 30000
        const timer = setTimeout(async () => {
            this.failedGroupE2EERetryTimers.delete(channelKey)
            this.failedGroupE2EERetryAttempts.set(channelKey, attempt + 1)
            await this.retryFailedGroupE2EEDecrypts(channelKey)
        }, delay)
        this.failedGroupE2EERetryTimers.set(channelKey, timer)
    }

    private rescheduleFailedGroupE2EERetries(matchKey?: string): void {
        if (matchKey) {
            if (this.failedGroupE2EEDecrypts.has(matchKey)) {
                this.scheduleFailedGroupE2EERetry(matchKey)
            } else {
                this.failedGroupE2EERetryAttempts.delete(matchKey)
            }
            return
        }
        this.failedGroupE2EEDecrypts.forEach((_list, channelKey) => {
            this.scheduleFailedGroupE2EERetry(channelKey)
        })
    }

    private removeFailedGroupE2EEDecrypt(entry: FailedGroupE2EEDecrypt): void {
        const list = this.failedGroupE2EEDecrypts.get(entry.channelKey)
        if (!list) {
            return
        }
        const next = list.filter((item) => item.key !== entry.key)
        if (next.length === 0) {
            this.failedGroupE2EEDecrypts.delete(entry.channelKey)
            this.clearFailedGroupE2EERetryTimer(entry.channelKey)
        } else {
            this.failedGroupE2EEDecrypts.set(entry.channelKey, next)
        }
    }

    private clearFailedGroupE2EERetryTimer(channelKey: string): void {
        this.failedGroupE2EERetryAttempts.delete(channelKey)
        const timer = this.failedGroupE2EERetryTimers.get(channelKey)
        if (timer) {
            clearTimeout(timer)
            this.failedGroupE2EERetryTimers.delete(channelKey)
        }
    }

    private async retryRealtimeE2EEDecryptIfRecoverable(
        message: Message,
        signalContent: MessageSignalContent,
        context: { message: Message; fromUID: string; senderDeviceId: string | number },
        firstError: any,
        options: DecryptMessageOptions,
    ): Promise<{ recovered: boolean; error?: any }> {
        if (!this.isRecoverableE2EEPath(options) || !this.isRecoverableRealtimeE2EEError(firstError, message, signalContent, options)) {
            return { recovered: false }
        }
        const startedAt = Date.now()
        const maxAttempts = Math.max(1, Number(this.realtimeE2EEMaxAttempts || 1))
        let error = firstError
        this.buildE2EEDecryptSkeletonContent(message)

        for (let attempt = 1; attempt < maxAttempts; attempt++) {
            const recovered = await this.recoverRealtimeE2EEDecryptFailure(message, signalContent, context, error, options)
            if (!recovered) {
                const delayMs = this.realtimeE2EERetryDelays[Math.min(attempt - 1, this.realtimeE2EERetryDelays.length - 1)] || 0
                if (delayMs > 0) {
                    await this.delay(delayMs)
                }
            }
            if (Date.now() - startedAt > this.realtimeE2EEPendingTTL) {
                break
            }
            try {
                message.content = await WKSDK.shared().config.e2ee.decryptMessage(signalContent, message.channel, context)
                this.cacheE2EEPlaintext(message, signalContent, message.content)
                this.debugE2EEDecrypt("after", message, message.content)
                ;(message as any).e2eePendingDecrypt = false
                ;(message as any).e2eeDecryptFailed = false
                ;(message as any).e2eeDecryptError = undefined
                return { recovered: true }
            } catch (retryError) {
                error = retryError
                if (!this.isRecoverableRealtimeE2EEError(error, message, signalContent, options)) {
                    break
                }
            }
        }
        return { recovered: false, error }
    }

    private buildE2EEDecryptSkeletonContent(message: Message) {
        ;(message as any).e2eePendingDecrypt = true
        ;(message as any).e2eeDecryptFailed = false
        const content = new MessageText(this.e2eeDecryptingText)
        ;(content as any).e2eeDecryptState = "pending"
        message.content = content
    }

    private isRecoverableRealtimeE2EEError(error: any, targetMessage?: Message, signalContent?: MessageSignalContent, options: DecryptMessageOptions = {}): boolean {
        const errorMessage = error && error.message ? String(error.message) : String(error || "")
        const errorName = error && error.name ? String(error.name) : ""
        if (!errorMessage) {
            if (errorName !== "OperationError") {
                return false
            }
        }
        const e2eeState = (WKSDK.shared().config.e2ee as any)?.readyState
        if (e2eeState === "failed") {
            return false
        }
        if (errorName === "OperationError" || errorMessage.indexOf("OperationError") >= 0) {
            if (options.recoverableSync && this.isGroupSignalMessage(targetMessage, signalContent)) {
                return true
            }
            return this.isRecoverableOperationError()
        }
        return errorMessage.indexOf("Missing sender key") >= 0
            || errorMessage.indexOf("Missing message key") >= 0
            || errorMessage.indexOf("E2EE is not initialized") >= 0
            || errorMessage.indexOf("E2EE decrypt adapter is unavailable") >= 0
            || errorMessage.indexOf("MessageCounterError") >= 0
            || errorMessage.indexOf("Message key not found") >= 0
            || errorMessage.indexOf("DB not initialized") >= 0
            || errorMessage.indexOf("SQLiteService not initialized") >= 0
            || errorMessage.indexOf("IndexedDB") >= 0
            || errorMessage.indexOf("NetworkError") >= 0
            || errorMessage.indexOf("Failed to fetch") >= 0
    }

    private isRecoverableE2EEPath(options: DecryptMessageOptions = {}): boolean {
        return !!(options.realtime || options.recoverableSync)
    }

    private isGroupSignalMessage(message?: Message, signalContent?: MessageSignalContent): boolean {
        return !!(
            message
            && message.channel
            && message.channel.channelType === 2
            && signalContent
            && signalContent.messageType === "signal_group"
        )
    }

    private isRecoverableOperationError(): boolean {
        const e2ee = (WKSDK.shared().config.e2ee as any)
        if (!e2ee) {
            return false
        }
        if (e2ee.readyState !== "ready") {
            return true
        }
        const readyAt = Number(e2ee.readyAt || e2ee.readyAtMs || 0)
        return readyAt > 0 && Date.now() - readyAt <= this.realtimeE2EEOperationRecoverWindow
    }

    private delay(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    private async recoverRealtimeE2EEDecryptFailure(
        message: Message,
        signalContent: MessageSignalContent,
        context: { message: Message; fromUID: string; senderDeviceId: string | number },
        error: any,
        options: DecryptMessageOptions,
    ): Promise<boolean> {
        if (!this.isRecoverableE2EEPath(options) || !WKSDK.shared().config.e2ee.recoverDecryptFailure) {
            return false
        }
        try {
            return await WKSDK.shared().config.e2ee.recoverDecryptFailure(signalContent, message.channel, {
                message,
                fromUID: message.fromUID,
                senderDeviceId: signalContent.senderDeviceId,
                error,
                realtime: true,
            })
        } catch (recoverError) {
            if (WKSDK.shared().config.debug) {
                console.warn("[E2EE] realtime decrypt recovery failed", {
                    channelID: message.channel && message.channel.channelID,
                    channelType: message.channel && message.channel.channelType,
                    fromUID: message.fromUID,
                    senderDeviceId: signalContent.senderDeviceId,
                    messageID: message.messageID,
                    clientMsgNo: message.clientMsgNo,
                }, recoverError)
            }
            return false
        }
    }

    private messagesForE2EEDecryption(messages: Message[]): Message[] {
        return messages
            .map((message, index) => ({ message, index, seq: this.normalizedMessageSeq(message) }))
            .sort((a, b) => {
                if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) {
                    return a.seq - b.seq
                }
                return a.index - b.index
            })
            .map((item) => item.message)
    }

    private normalizedMessageSeq(message: Message): number | undefined {
        const seq = Number(message && message.messageSeq)
        if (!Number.isFinite(seq) || seq <= 0) {
            return undefined
        }
        return seq
    }

    buildE2EEDecryptFailureContent(error: any, options: DecryptMessageOptions = {}): MessageText {
        const content = new MessageText(this.e2eeDecryptFailedText)
        ;(content as any).e2eeDecryptState = "failed"
        return content
    }

    isSignalMessageContent(content: MessageContent | any): boolean {
        return content instanceof MessageSignalContent || (content && content.contentType === MessageContentType.signalMessage)
    }

    cacheE2EEPlaintext(message: Message, signalContent: MessageContent | any, plaintextContent: MessageContent) {
        if (!plaintextContent) {
            return
        }
        const e2ee = WKSDK.shared().config.e2ee
        const cacheContent = e2ee && typeof (e2ee as any).cacheablePlaintextContent === "function"
            ? (e2ee as any).cacheablePlaintextContent(plaintextContent, message.channel)
            : plaintextContent
        if (!cacheContent) {
            return
        }
        if (e2ee && !e2ee.shouldCachePlaintext(cacheContent, message.channel)) {
            return
        }
        const keys = this.e2eePlaintextCacheKeys(message, signalContent)
        if (keys.length === 0) {
            return
        }
        try {
            const payload = this.encodeContentPayload(cacheContent)
            const now = Date.now()
            const value = JSON.stringify({
                type: cacheContent.contentType,
                payload,
                cachedAt: now,
            })
            for (const key of keys) {
                this.e2eePlaintextMemoryCache.set(key, value)
                this.getE2EEPlaintextSessionStorage()?.setItem(key, value)
                this.getE2EEPlaintextLocalStorage()?.setItem(key, value)
            }
        } catch (error) {
            if (WKSDK.shared().config.debug) {
                console.warn("[E2EE] plaintext cache write failed", error)
            }
        }
    }

    private encodeContentPayload(content: MessageContent | any): any {
        if (!content) {
            return {}
        }
        if (typeof content.encode === "function") {
            try {
                const payload = JSON.parse(this.uint8ArrayToString(content.encode()))
                if (payload && typeof payload === "object") {
                    return payload
                }
            } catch (_error) {
                // Fallback to encodeJSON below.
            }
        }
        const payload = content.encodeJSON ? content.encodeJSON() : {}
        if (payload.type === undefined) {
            payload.type = content.contentType
        }
        if (!payload.content && (content.text || content.conversationDigest)) {
            payload.content = content.text || content.conversationDigest
        }
        if (!payload.reply && content.contentObj && content.contentObj.reply) {
            payload.reply = content.contentObj.reply
        }
        if (!payload.mention && content.contentObj && content.contentObj.mention) {
            payload.mention = content.contentObj.mention
        }
        return payload
    }

    restoreCachedE2EEPlaintext(message: Message, signalContent: MessageContent | any): MessageContent | undefined {
        for (const key of this.e2eePlaintextCacheKeys(message, signalContent)) {
            const cached = this.e2eePlaintextMemoryCache.get(key) || this.getE2EEPlaintextSessionStorage()?.getItem(key) || this.getE2EEPlaintextLocalStorage()?.getItem(key)
            if (!cached) {
                continue
            }
            try {
                const data = JSON.parse(cached)
                const contentType = Number(data.type || signalContent.realContentType)
                const content = WKSDK.shared().getMessageContent(contentType)
                const payload = data.payload || {}
                payload.type = contentType
                content.decode(this.stringToUint8Array(JSON.stringify(payload)))
                return content
            } catch (error) {
                this.removeE2EEPlaintextCacheKey(key)
                if (WKSDK.shared().config.debug) {
                    console.warn("[E2EE] plaintext cache read failed", error)
                }
            }
        }
        return undefined
    }

    private removeE2EEPlaintextCacheKey(key: string) {
        this.e2eePlaintextMemoryCache.delete(key)
        this.getE2EEPlaintextSessionStorage()?.removeItem(key)
        this.getE2EEPlaintextLocalStorage()?.removeItem(key)
    }

    private removeE2EEPlaintextCacheKeys(message: Message, signalContent: MessageContent | any) {
        for (const key of this.e2eePlaintextCacheKeys(message, signalContent)) {
            this.removeE2EEPlaintextCacheKey(key)
        }
    }

    private markE2EEDecryptFailureIfNeeded(message: Message, signalContent: MessageContent | any, error: any): boolean {
        if (!this.isMissingSenderKeyError(error)) {
            return true
        }
        const key = this.e2eeDecryptFailureCacheKey(message, signalContent)
        if (!key) {
            return true
        }
        const now = Date.now()
        const lastFailedAt = this.e2eeDecryptFailureMemoryCache.get(key)
        this.e2eeDecryptFailureMemoryCache.set(key, now)
        return !lastFailedAt || now - lastFailedAt > this.e2eeDecryptFailureTTL
    }

    private e2eeDecryptFailureCacheKey(message: Message, signalContent: MessageContent | any): string {
        const channelID = message.channel && message.channel.channelID
        const channelType = message.channel && message.channel.channelType
        const senderDeviceId = signalContent && signalContent.senderDeviceId
        const messageID = message.messageID || message.clientMsgNo
        if (!channelID || !messageID) {
            const ciphertext = signalContent && signalContent.ciphertext
            if (!channelID || !ciphertext) {
                return ""
            }
            return `${channelID}:${channelType || ""}:${message.fromUID || ""}:${senderDeviceId || ""}:ct:${this.hashString(String(ciphertext))}`
        }
        return `${channelID}:${channelType || ""}:${message.fromUID || ""}:${senderDeviceId || ""}:mid:${messageID}`
    }

    private isMissingSenderKeyError(error: any): boolean {
        const message = error && error.message ? String(error.message) : String(error || "")
        return message.indexOf("Missing sender key") >= 0
    }

    e2eePlaintextCacheKeys(message: Message, signalContent: MessageContent | any): string[] {
        const uid = WKSDK.shared().config.uid || ""
        const deviceId = WKSDK.shared().config.e2ee?.currentOptions?.deviceId || ""
        const keys: string[] = []
        const prefix = `wk_e2ee_plaintext:${uid}:${deviceId}:`
        if (message.messageID) {
            keys.push(`${prefix}mid:${message.messageID}`)
        }
        if (message.clientMsgNo) {
            keys.push(`${prefix}cno:${message.clientMsgNo}`)
        }
        const ciphertext = signalContent && signalContent.ciphertext
        if (ciphertext) {
            keys.push(`${prefix}ct:${this.hashString(String(ciphertext))}`)
        }
        return keys
    }

    getE2EEPlaintextSessionStorage(): Storage | undefined {
        try {
            if (typeof sessionStorage !== "undefined") {
                return sessionStorage
            }
        } catch (_error) {
            return undefined
        }
        return undefined
    }

    getE2EEPlaintextLocalStorage(): Storage | undefined {
        try {
            if (typeof localStorage === "undefined") {
                return undefined
            }
            return localStorage
        } catch (_error) {
            return undefined
        }
    }

    hashString(value: string): string {
        let hash = 0
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
        }
        return String(hash >>> 0)
    }

    stringToUint8Array(str: string): Uint8Array {
        const newStr = unescape(encodeURIComponent(str))
        const arr = new Array<number>()
        for (let i = 0, j = newStr.length; i < j; ++i) {
            arr.push(newStr.charCodeAt(i))
        }
        return new Uint8Array(arr)
    }

    uint8ArrayToString(data: Uint8Array): string {
        return utf8BytesToString(data)
    }

    debugRawReceivedMessage(message: Message) {
        if (!WKSDK.shared().config.debug) {
            return
        }
        console.log("[E2EE][recv raw]", {
            channelID: message.channel && message.channel.channelID,
            channelType: message.channel && message.channel.channelType,
            fromUID: message.fromUID,
            messageID: message.messageID,
            messageSeq: message.messageSeq,
            clientMsgNo: message.clientMsgNo,
            contentType: message.contentType,
            content: this.toDebugContent(message.content),
        })
    }

    debugE2EEDecrypt(stage: string, message: Message, content: MessageContent) {
        if (!WKSDK.shared().config.debug) {
            return
        }
        console.log(`[E2EE] decrypt ${stage}`, {
            channelID: message.channel && message.channel.channelID,
            channelType: message.channel && message.channel.channelType,
            fromUID: message.fromUID,
            messageID: message.messageID,
            clientMsgNo: message.clientMsgNo,
            content: this.toDebugContent(content),
        })
    }

    debugE2EEDecryptFailure(message: Message, content: MessageContent, error: any) {
        if (!WKSDK.shared().config.debug) {
            return
        }
        console.log("[E2EE] decrypt failed detail", {
            channelID: message.channel && message.channel.channelID,
            channelType: message.channel && message.channel.channelType,
            fromUID: message.fromUID,
            messageID: message.messageID,
            clientMsgNo: message.clientMsgNo,
            error: error && error.message ? error.message : String(error),
            content: this.toDebugContent(content),
        })
    }

    toDebugContent(content: MessageContent | any) {
        if (!content) {
            return null
        }
        const data: any = {
            contentType: content.contentType,
            contentClass: content.constructor && content.constructor.name,
        }
        if (this.isSignalMessageContent(content)) {
            data.messageType = content.messageType
            data.realContentType = content.realContentType
            data.senderDeviceId = content.senderDeviceId
            data.ciphertext = content.ciphertext
            return data
        }
        if (typeof content.text === "string") {
            data.text = content.text
        }
        if (typeof content.encodeJSON === "function") {
            try {
                data.payload = content.encodeJSON()
            } catch (error) {
                data.payloadError = error && (error as any).message ? (error as any).message : String(error)
            }
        }
        return data
    }

    sendSendPacket(p: SendPacket) {
        this.sendPacketQueue.push(p)
        if(!this.sendTimer) {
            this.sendTimer = setInterval(() => {
                const sendChunks = new Array<Uint8Array>()
                let sendDataLength = 0
                let sendCount  = 0
                while (this.sendPacketQueue.length > 0) {
                    const packet = this.sendPacketQueue.shift()
                    if(packet) {
                        const packetData = WKSDK.shared().config.proto.encode(packet)
                        sendChunks.push(packetData)
                        sendDataLength += packetData.length
                    }
                    sendCount++
                    if(sendCount >= WKSDK.shared().config.sendCountOfEach) {
                        break
                    }
                }
                if(sendDataLength > 0) {
                    const sendData = new Uint8Array(sendDataLength)
                    let offset = 0
                    for (const chunk of sendChunks) {
                        sendData.set(chunk, offset)
                        offset += chunk.length
                    }
                    WKSDK.shared().connectManager.send(sendData)
                } 
            }, WKSDK.shared().config.sendFrequency)
        }
    }
    getSendPacket(content: MessageContent, channel: Channel, setting: Setting = new Setting()): SendPacket {
        const packet = new SendPacket();
        packet.setting = setting
        packet.reddot = true;
        packet.clientMsgNo = `${Guid.create().toString().replace(/-/gi, "")}3`
        packet.streamNo = setting.streamNo
        packet.clientSeq = this.getClientSeq()
        packet.fromUID = WKSDK.shared().config.uid || '';
        packet.channelID = channel.channelID;
        packet.channelType = channel.channelType
        packet.payload = content.encode()
        return packet
    }
    getSendPacketWithOptions(content: MessageContent, channel: Channel, opts: SendOptions = new SendOptions()): SendPacket {
        const setting =  opts.setting || new Setting()
        const packet = new SendPacket();
        packet.reddot = opts.reddot;
        packet.noPersist = opts.noPersist;
        packet.setting = setting
        packet.reddot = true;
        packet.clientMsgNo = `${Guid.create().toString().replace(/-/gi, "")}_${WKSDK.shared().config.clientMsgDeviceId}_3`
        packet.streamNo = setting.streamNo
        packet.clientSeq = this.getClientSeq()
        packet.fromUID = WKSDK.shared().config.uid || '';
        packet.channelID = channel.channelID;
        packet.channelType = channel.channelType
        packet.payload = content.encode()
        return packet
    }
    getClientSeq() {
        return ++this.clientSeq;
    }

    // 通知命令消息监听者
    notifyCMDListeners(message: Message) {
        if (this.cmdListeners) {
            this.cmdListeners.forEach((listener: (message: Message) => void) => {
                if (listener) {
                    listener(message);
                }
            });
        }
    }

    // 添加命令类消息监听
    addCMDListener(listener: MessageListener) {
        this.cmdListeners.push(listener);
    }
    removeCMDListener(listener: MessageListener) {
        const len = this.cmdListeners.length;
        for (let i = 0; i < len; i++) {
            if (listener === this.cmdListeners[i]) {
                this.cmdListeners.splice(i, 1)
                return
            }
        }
    }
    // 添加消息监听
    addMessageListener(listener: MessageListener) {
        this.listeners.push(listener);
    }
    // 移除消息监听
    removeMessageListener(listener: MessageListener) {
        const len = this.listeners.length;
        for (let i = 0; i < len; i++) {
            if (listener === this.listeners[i]) {
                this.listeners.splice(i, 1)
                return
            }
        }
    }
    // 通知消息监听者
    notifyMessageListeners(message: Message) {
        if (this.listeners) {
            const totalStartedAt = this.nowMs()
            this.listeners.forEach((listener: MessageListener, index: number) => {
                if (listener) {
                    const startedAt = this.nowMs()
                    listener(message);
                    const costMs = this.nowMs() - startedAt
                    if (costMs >= 100) {
                        this.warnMessageListenerSlow("消息监听器耗时过高", message, {
                            listenerIndex: index,
                            listenerName: (listener as any).name || "anonymous",
                            costMs,
                        })
                    }
                }
            });
            const totalCostMs = this.nowMs() - totalStartedAt
            if (totalCostMs >= 100) {
                this.warnMessageListenerSlow("消息监听器总耗时过高", message, {
                    listenerCount: this.listeners.length,
                    costMs: totalCostMs,
                })
            }
        }
    }

    private nowMs(): number {
        if (typeof performance !== "undefined" && typeof performance.now === "function") {
            return performance.now()
        }
        return Date.now()
    }

    private warnMessageListenerSlow(reason: string, message: Message, extra: any) {
        try {
            console.warn("[消息性能]", {
                reason,
                channelID: message.channel && message.channel.channelID,
                channelType: message.channel && message.channel.channelType,
                fromUID: message.fromUID,
                messageID: message.messageID,
                clientMsgNo: message.clientMsgNo,
                messageSeq: message.messageSeq,
                contentType: message.contentType,
                pending: (message as any).e2eePendingDecrypt === true,
                failed: (message as any).e2eeDecryptFailed === true,
                ...(extra || {}),
            })
        } catch (_error) {
            // ignore diagnostics failures
        }
    }


    // 通知消息状态改变监听者
    notifyMessageStatusListeners(sendackPacket: SendackPacket) {
        if (this.sendStatusListeners) {
            this.sendStatusListeners.forEach((listener: (ack: SendackPacket) => void) => {
                if (listener) {
                    listener(sendackPacket);
                }
            });
        }
    }
    // 消息状态改变监听
    addMessageStatusListener(listener: MessageStatusListener) {
        this.sendStatusListeners.push(listener);
    }
    removeMessageStatusListener(listener: MessageStatusListener) {
        const len = this.sendStatusListeners.length;
        for (let i = 0; i < len; i++) {
            if (listener === this.sendStatusListeners[i]) {
                this.sendStatusListeners.splice(i, 1)
                return
            }
        }
    }

    // 将发送消息队列里的消息flush出去
    flushSendingQueue() {
        if (this.sendingQueues.size <= 0) {
            return;
        }
        console.log(`flush 发送队列内的消息。数量${this.sendingQueues.size}`);
        let clientSeqArray = new Array<number>();
        this.sendingQueues.forEach((value, key) => {
            clientSeqArray.push(key);
        })
        clientSeqArray = clientSeqArray.sort();

        for (const clientSeq of clientSeqArray) {
            const sendPacket = this.sendingQueues.get(clientSeq);
            if (sendPacket) {
                console.log("重试消息---->", sendPacket)
                WKSDK.shared().connectManager.sendPacket(sendPacket);
            }
        }

    }

    deleteMessageFromSendingQueue(clientSeq: number) {
        this.sendingQueues.delete(clientSeq)
    }

}

export class SendOptions {
    setting: Setting = new Setting() // setting
    noPersist: boolean = false // 是否不存储
    reddot: boolean = true // 是否显示红点

}
