import { MessageContentType } from "./const";
import { Guid } from "./guid";
import WKSDK from "./index";
import { Channel, ChannelTypePerson, MediaMessageContent, Message, MessageContent, SyncOptions, MessageSignalContent, MessageText } from "./model";
import { Packet, RecvackPacket, RecvPacket, SendackPacket, SendPacket, Setting } from "./proto";
import { Task, MessageTask, TaskStatus } from "./task";
import { Md5 } from "md5-typescript";
import { SecurityManager } from "./security";

export type MessageListener = ((message: Message) => void);
export type MessageStatusListener = ((p: SendackPacket) => void);

export class ChatManager {
    cmdListeners: ((message: Message) => void)[] = new Array(); // 命令类消息监听
    listeners: MessageListener[] = new Array(); // 收取消息监听
    sendingQueues: Map<number, SendPacket> = new Map(); // 发送中的消息
    sendPacketQueue: Packet[] = [] // 发送队列
    sendTimer: any // 发送定时器
    sendStatusListeners: MessageStatusListener[] = new Array(); // 消息状态监听
    clientSeq: number = 0
    private e2eePlaintextMemoryCache: Map<string, string> = new Map()
    private e2eePlaintextSessionTTL: number = 12 * 60 * 60 * 1000
    private e2eeDecryptFailureMemoryCache: Map<string, number> = new Map()
    private e2eeDecryptFailureTTL: number = 10 * 60 * 1000

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
            await this.decryptMessageIfNeeded(message)
            this.sendRecvackPacket(recvPacket);
            if (message.contentType === MessageContentType.cmd) { // 命令类消息分流处理
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

    async decryptMessageIfNeeded(message: Message): Promise<void> {
        if (!this.isSignalMessageContent(message.content)) {
            return
        }
        const signalContent = message.content
        const cachedContent = this.restoreCachedE2EEPlaintext(message, signalContent)
        if (cachedContent) {
            try {
                message.content = await WKSDK.shared().config.e2ee.restoreCachedPlaintext(cachedContent)
                ;(message as any).e2eeDecryptFailed = false
                this.debugE2EEDecrypt("cache", message, message.content)
                return
            } catch (error) {
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
        if (this.isRecentE2EEDecryptFailure(message, signalContent)) {
            ;(message as any).e2eeDecryptFailed = true
            ;(message as any).e2eeDecryptError = new Error("Missing sender key")
            message.content = this.buildE2EEDecryptFailureContent((message as any).e2eeDecryptError)
            return
        }
        try {
            message.content = await WKSDK.shared().config.e2ee.decryptMessage(message.content, message.channel, {
                message,
                fromUID: message.fromUID,
                senderDeviceId: signalContent.senderDeviceId,
            })
            this.cacheE2EEPlaintext(message, signalContent, message.content)
            this.debugE2EEDecrypt("after", message, message.content)
            ;(message as any).e2eeDecryptFailed = false
        } catch (error) {
            ;(message as any).e2eeDecryptFailed = true
            ;(message as any).e2eeDecryptError = error
            this.debugE2EEDecryptFailure(message, message.content, error)
            const shouldLog = this.markE2EEDecryptFailureIfNeeded(message, message.content, error)
            if (shouldLog) {
                console.error("[E2EE] decrypt failed", {
                    channelID: message.channel && message.channel.channelID,
                    channelType: message.channel && message.channel.channelType,
                    fromUID: message.fromUID,
                    senderDeviceId: message.content.senderDeviceId,
                    messageID: message.messageID,
                    clientMsgNo: message.clientMsgNo,
                }, error)
            }
            message.content = this.buildE2EEDecryptFailureContent(error)
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

    buildE2EEDecryptFailureContent(error: any): MessageText {
        if (this.isMissingSenderKeyError(error)) {
            return new MessageText("[E2EE] 该历史消息缺少群密钥，无法在当前设备解密")
        }
        return new MessageText("[E2EE] 消息无法解密或无权限查看")
    }

    isSignalMessageContent(content: MessageContent | any): boolean {
        return content instanceof MessageSignalContent || (content && content.contentType === MessageContentType.signalMessage)
    }

    cacheE2EEPlaintext(message: Message, signalContent: MessageContent | any, plaintextContent: MessageContent) {
        if (!plaintextContent) {
            return
        }
        if (WKSDK.shared().config.e2ee && !WKSDK.shared().config.e2ee.shouldCachePlaintext(plaintextContent)) {
            return
        }
        const keys = this.e2eePlaintextCacheKeys(message, signalContent)
        if (keys.length === 0) {
            return
        }
        try {
            const payload = plaintextContent.encodeJSON ? plaintextContent.encodeJSON() : {}
            const now = Date.now()
            const value = JSON.stringify({
                type: plaintextContent.contentType,
                payload,
                cachedAt: now,
                expiresAt: now + this.e2eePlaintextSessionTTL,
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

    restoreCachedE2EEPlaintext(message: Message, signalContent: MessageContent | any): MessageContent | undefined {
        for (const key of this.e2eePlaintextCacheKeys(message, signalContent)) {
            const cached = this.e2eePlaintextMemoryCache.get(key) || this.getE2EEPlaintextSessionStorage()?.getItem(key) || this.getE2EEPlaintextLocalStorage()?.getItem(key)
            if (!cached) {
                continue
            }
            try {
                const data = JSON.parse(cached)
                if (data.expiresAt && Number(data.expiresAt) < Date.now()) {
                    this.removeE2EEPlaintextCacheKey(key)
                    continue
                }
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

    private isRecentE2EEDecryptFailure(message: Message, signalContent: MessageContent | any): boolean {
        const key = this.e2eeDecryptFailureCacheKey(message, signalContent)
        if (!key) {
            return false
        }
        const failedAt = this.e2eeDecryptFailureMemoryCache.get(key)
        if (!failedAt) {
            return false
        }
        if (Date.now() - failedAt > this.e2eeDecryptFailureTTL) {
            this.e2eeDecryptFailureMemoryCache.delete(key)
            return false
        }
        return true
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
            this.listeners.forEach((listener: MessageListener) => {
                if (listener) {
                    listener(message);
                }
            });
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
