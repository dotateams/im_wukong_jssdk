import * as assert from "assert";
import WKSDK from "../../src";
import {
    Channel,
    ChannelInfo,
    ChannelTypeGroup,
    CMDContent,
    Message,
    MessageSignalContent,
    MessageText,
} from "../../src/model";
import { MessageContentType } from "../../src/const";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function resetSdk() {
    const sdk = WKSDK.shared();
    sdk.config.uid = "sender";
    sdk.config.e2ee.reset();
    sdk.channelManager.channelInfocacheMap = {};
    (sdk.chatManager as any).e2eePlaintextMemoryCache?.clear?.();
    (sdk.chatManager as any).e2eeDecryptFailureMemoryCache?.clear?.();
    (sdk.chatManager as any).pendingRealtimeE2EEDecrypts?.clear?.();
    (sdk.chatManager as any).pendingRealtimeE2EETimers?.clear?.();
    (sdk.chatManager as any).failedGroupE2EEDecrypts?.clear?.();
    (sdk.chatManager as any).failedGroupE2EERetryTimers?.forEach?.((timer: any) => clearTimeout(timer));
    (sdk.chatManager as any).failedGroupE2EERetryTimers?.clear?.();
    (sdk.chatManager as any).failedGroupE2EERetryAttempts?.clear?.();
    try {
        (globalThis as any).localStorage?.clear?.();
        (globalThis as any).sessionStorage?.clear?.();
    } catch (_error) {
        // ignore
    }
    return sdk;
}

function cacheChannelInfo(channel: Channel, isE2e: boolean) {
    const sdk = WKSDK.shared();
    const info = new ChannelInfo();
    info.channel = channel;
    info.isE2e = isE2e;
    if (isE2e) {
        info.e2eEnabledAt = 1710000000;
    }
    sdk.channelManager.setChannleInfoForCache(info);
}

function groupSignalContent(): MessageSignalContent {
    const content = new MessageSignalContent();
    content.messageType = "signal_group";
    content.realContentType = MessageContentType.text;
    content.senderDeviceId = "sender-device-1";
    content.ciphertext = JSON.stringify({ type: "signal_group", payload: "ciphertext" });
    return content;
}

function newGroupMessage(channel: Channel, messageID: string): Message {
    const message = new Message();
    message.channel = channel;
    message.fromUID = "peer";
    message.messageID = messageID;
    message.clientMsgNo = messageID;
    message.content = groupSignalContent();
    return message;
}

function devicesChangedCMD(channel: Channel): Message {
    const message = new Message();
    message.channel = channel;
    message.fromUID = "peer";
    const cmd = new CMDContent();
    cmd.cmd = "e2eeDevicesChanged";
    cmd.param = { group_id: channel.channelID, channel_type: channel.channelType, changed_uid: "newbie", reason: "device_register" };
    message.content = cmd;
    return message;
}

test("e2ee group self-heal: missing-sender-key realtime message is tracked as failed", async () => {
    const sdk = resetSdk();
    const channel = new Channel("g-heal-1", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing sender key");
            },
        },
    });

    const message = newGroupMessage(channel, "heal-msg-1");
    await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true });

    // 允许实时重试链尝试后仍失败并终态登记。
    await new Promise((resolve) => setTimeout(resolve, 50));

    const tracked = (sdk.chatManager as any).failedGroupE2EEDecrypts as Map<string, any[]>;
    let total = 0;
    tracked.forEach((list) => { total += list.length; });
    assert.ok(total >= 1, `expected failed message tracked, got ${total}`);
});

test("e2ee group self-heal: devices-changed CMD re-decrypts previously failed message without refresh", async () => {
    const sdk = resetSdk();
    const channel = new Channel("g-heal-2", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    let keyReady = false; // 仅当“信封到达”后置真；模拟真实缺 key -> 补拉成功的过程。
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                if (!keyReady) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("healed plaintext");
            },
            // 恢复只反映当前是否已拿到 key：初始阶段一直失败，直到收到 devices-changed 后测试置 keyReady。
            recoverDecryptFailure: async () => keyReady,
        },
    });

    const message = newGroupMessage(channel, "heal-msg-2");
    await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((message as any).e2eeDecryptFailed, true);

    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    (sdk.chatManager as any).notifyMessageListeners = (m: Message) => { notified.push(m); };
    try {
        // 模拟“信封已补拉到”：现在解密可以成功。
        keyReady = true;
        // 模拟服务端下发 e2eeDevicesChanged。
        const consumed = (sdk.chatManager as any).handleE2EEControlCMD(devicesChangedCMD(channel));
        assert.equal(consumed, true, "control CMD should be consumed internally");
        await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.ok(message.content instanceof MessageText, "message should be re-decrypted in place");
    assert.equal((message.content as MessageText).text, "healed plaintext");
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.ok(notified.some((m) => m.messageID === "heal-msg-2"), "listeners should be notified after heal");

    const tracked = (sdk.chatManager as any).failedGroupE2EEDecrypts as Map<string, any[]>;
    let total = 0;
    tracked.forEach((list) => { total += list.length; });
    assert.equal(total, 0, "healed entry should be removed from registry");
});

test("e2ee group self-heal: terminal failed message retries without waiting for control CMD", async () => {
    const sdk = resetSdk();
    const channel = new Channel("g-heal-auto", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    let keyReady = false;
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                if (!keyReady) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("auto healed plaintext");
            },
            recoverDecryptFailure: async () => keyReady,
        },
    });

    const message = newGroupMessage(channel, "heal-auto-msg-1");
    const signalContent = message.content as MessageSignalContent;
    const chatManager = sdk.chatManager as any;
    chatManager.failedGroupE2EERetryDelays = [20];
    chatManager.trackFailedGroupE2EEDecrypt(message, signalContent, new Error("Missing sender key"));

    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    (sdk.chatManager as any).notifyMessageListeners = (m: Message) => { notified.push(m); };
    try {
        keyReady = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.ok(message.content instanceof MessageText, "message should be re-decrypted by background retry");
    assert.equal((message.content as MessageText).text, "auto healed plaintext");
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.ok(notified.some((m) => m.messageID === "heal-auto-msg-1"), "listeners should be notified after background heal");
});

test("e2ee group self-heal: registry enforces per-channel cap", async () => {
    const sdk = resetSdk();
    const channel = new Channel("g-heal-3", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing sender key");
            },
        },
    });

    const perChannelCap = (sdk.chatManager as any).failedGroupE2EEMaxPerChannel as number;
    for (let i = 0; i < perChannelCap + 20; i++) {
        const message = newGroupMessage(channel, `cap-msg-${i}`);
        // 直接走终态失败登记（非实时，避免重试链干扰计数）。
        await sdk.chatManager.decryptMessageIfNeeded(message);
    }

    const tracked = (sdk.chatManager as any).failedGroupE2EEDecrypts as Map<string, any[]>;
    const channelKey = [channel.channelID, channel.channelType].join(":");
    const list = tracked.get(channelKey) || [];
    assert.ok(list.length <= perChannelCap, `per-channel cap exceeded: ${list.length} > ${perChannelCap}`);
});

test("e2ee group self-heal: control CMD dedup does not pass through to business cmd listeners", async () => {
    const sdk = resetSdk();
    const channel = new Channel("g-heal-4", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => new MessageText("noop"),
        },
    });

    const consumed = (sdk.chatManager as any).handleE2EEControlCMD(devicesChangedCMD(channel));
    assert.equal(consumed, true);

    // 普通业务 CMD 不应被消费。
    const business = new Message();
    business.channel = channel;
    const cmd = new CMDContent();
    cmd.cmd = "messageRevoke";
    cmd.param = {};
    business.content = cmd;
    const consumedBusiness = (sdk.chatManager as any).handleE2EEControlCMD(business);
    assert.equal(consumedBusiness, false);
});
