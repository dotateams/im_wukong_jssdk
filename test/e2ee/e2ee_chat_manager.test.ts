import * as assert from "assert";
import WKSDK from "../../src";
import { SendOptions } from "../../src/chat_manager";
import {
    Channel,
    ChannelInfo,
    ChannelTypeGroup,
    ChannelTypePerson,
    MediaMessageContent,
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
    try {
        (globalThis as any).localStorage?.clear?.();
        (globalThis as any).sessionStorage?.clear?.();
    } catch (_error) {
        // ignore test storage cleanup failures
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

function signalContent(messageType: string): MessageSignalContent {
    const content = new MessageSignalContent();
    content.messageType = messageType;
    content.realContentType = MessageContentType.text;
    content.senderDeviceId = "web-device-1";
    content.ciphertext = JSON.stringify({ type: messageType, payload: "ciphertext" });
    return content;
}

function decodePayload(payload: Uint8Array) {
    const encodedString = String.fromCharCode.apply(null, Array.from(payload));
    return JSON.parse(decodeURIComponent(escape(encodedString)));
}

function installStorageMock(name: "localStorage" | "sessionStorage") {
    const store = new Map<string, string>();
    (globalThis as any)[name] = {
        getItem: (key: string) => store.get(key) || null,
        setItem: (key: string, value: string) => store.set(key, String(value)),
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => Array.from(store.keys())[index] || null,
        get length() {
            return store.size;
        },
    };
    return store;
}

test("e2ee_chat_manager person channel encrypts through adapter", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    let adapterCalled = false;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            encryptMessage: async (_content, target) => {
                adapterCalled = true;
                assert.equal(target.channelType, ChannelTypePerson);
                return signalContent("signal_multi");
            },
        },
    });

    const finalContent = await sdk.chatManager.prepareContentForSend(
        new MessageText("hello"),
        channel,
    );

    assert.equal(adapterCalled, true);
    assert.ok(finalContent instanceof MessageSignalContent);
    assert.equal((finalContent as MessageSignalContent).messageType, "signal_multi");
});

test("e2ee_chat_manager group channel encrypts through adapter", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            encryptMessage: async (_content, target) => {
                assert.equal(target.channelType, ChannelTypeGroup);
                return signalContent("signal_group");
            },
        },
    });

    const finalContent = await sdk.chatManager.prepareContentForSend(
        new MessageText("hello group"),
        channel,
    );

    assert.ok(finalContent instanceof MessageSignalContent);
    assert.equal((finalContent as MessageSignalContent).messageType, "signal_group");
});

test("e2ee_chat_manager enabled channel blocks send when encryption is unavailable", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
    });

    await assert.rejects(
        () => sdk.chatManager.prepareContentForSend(new MessageText("hello"), channel),
        /encrypt/i,
    );
});

test("e2ee_chat_manager blocks media messages in enabled channels until media encryption is available", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            encryptMessage: async () => {
                throw new Error("media should be blocked before adapter encryption");
            },
        },
    });

    await assert.rejects(
        () => sdk.chatManager.prepareContentForSend(new MediaMessageContent(), channel),
        /media/i,
    );
});

test("e2ee_chat_manager sends encrypted packet while keeping local sent message plaintext", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            encryptMessage: async () => signalContent("signal_multi"),
        },
    });

    const sentPackets: any[] = [];
    const notifiedMessages: Message[] = [];
    const originalSend = sdk.chatManager.sendSendPacket;
    const originalNotify = sdk.chatManager.notifyMessageListeners;

    try {
        (sdk.chatManager as any).sendSendPacket = (packet: any) => {
            sentPackets.push(packet);
        };
        (sdk.chatManager as any).notifyMessageListeners = (message: Message) => {
            notifiedMessages.push(message);
        };

        const message = await sdk.chatManager.sendWithOptions(
            new MessageText("hello local"),
            channel,
            new SendOptions(),
        );

        assert.equal(sentPackets.length, 1);
        const packetPayload = decodePayload(sentPackets[0].payload);
        assert.equal(packetPayload.type, MessageContentType.signalMessage);
        assert.equal(packetPayload.message_type, "signal_multi");

        assert.ok(message.content instanceof MessageText);
        assert.equal((message.content as MessageText).text, "hello local");
        assert.equal(notifiedMessages.length, 1);
        assert.ok(notifiedMessages[0].content instanceof MessageText);
        assert.equal((notifiedMessages[0].content as MessageText).text, "hello local");
        const plaintextCache = (sdk.chatManager as any).e2eePlaintextMemoryCache as Map<string, string>;
        assert.ok([...plaintextCache.keys()].some((key) => key.includes("wk_e2ee_plaintext:sender:web-device-1:ct:")));
    } finally {
        (sdk.chatManager as any).sendSendPacket = originalSend;
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }
});

test("e2ee_chat_manager decrypts signal content before listeners", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const message = new Message();
    message.channel = channel;
    message.content = signalContent("signal_multi");

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async (_content, target) => {
                assert.equal(target.channelID, "receiver");
                return new MessageText("decrypted");
            },
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(message);

    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "decrypted");
});

test("e2ee_chat_manager restores repeated history ciphertext from plaintext cache", async () => {
    const sessionCache = installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const first = new Message();
    first.messageID = "msg-1";
    first.clientMsgNo = "client-1";
    first.channel = channel;
    first.fromUID = "receiver";
    first.content = signalContent("signal_multi");

    let decryptCalls = 0;
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                return new MessageText("cached plaintext");
            },
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(first);
    assert.equal(decryptCalls, 1);
    assert.equal((first.content as MessageText).text, "cached plaintext");
    (sdk.chatManager as any).e2eePlaintextMemoryCache.clear();
    assert.ok([...sessionCache.keys()].some((key) => key.includes("wk_e2ee_plaintext:sender:web-device-1:ct:")));

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("MessageCounterError: Message key not found");
            },
        },
    });

    const replay = new Message();
    replay.messageID = "msg-1";
    replay.clientMsgNo = "client-1";
    replay.channel = channel;
    replay.fromUID = "receiver";
    replay.content = signalContent("signal_multi");

    await sdk.chatManager.decryptMessageIfNeeded(replay);

    assert.ok(replay.content instanceof MessageText);
    assert.equal((replay.content as MessageText).text, "cached plaintext");
    assert.equal((replay as any).e2eeDecryptFailed, false);
});

test("e2ee_chat_manager restores self-sent ciphertext after session cache is cleared", async () => {
    const localCache = installStorageMock("localStorage");
    const sessionCache = installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const first = new Message();
    first.messageID = "msg-self-1";
    first.clientMsgNo = "client-self-1";
    first.channel = channel;
    first.fromUID = "sender";
    first.content = signalContent("signal_group");

    let decryptCalls = 0;
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                return new MessageText("self cached plaintext");
            },
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(first);
    assert.equal(decryptCalls, 1);
    assert.equal((first.content as MessageText).text, "self cached plaintext");
    assert.ok([...localCache.keys()].some((key) => key.includes("wk_e2ee_plaintext:sender:web-device-1:ct:")));

    sessionCache.clear();
    (sdk.chatManager as any).e2eePlaintextMemoryCache.clear();

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing message key");
            },
        },
    });

    const replay = new Message();
    replay.messageID = "msg-self-1";
    replay.clientMsgNo = "client-self-1";
    replay.channel = channel;
    replay.fromUID = "sender";
    replay.content = signalContent("signal_group");

    await sdk.chatManager.decryptMessageIfNeeded(replay);

    assert.ok(replay.content instanceof MessageText);
    assert.equal((replay.content as MessageText).text, "self cached plaintext");
    assert.equal((replay as any).e2eeDecryptFailed, false);
});

test("e2ee_chat_manager replaces expired persistent plaintext cache entries", async () => {
    const persistentStorage = installStorageMock("localStorage");
    const sdk = resetSdk();
    persistentStorage.set("wk_e2ee_plaintext:sender:web-device-1:cno:expired-client", JSON.stringify({
        type: MessageContentType.text,
        payload: { content: "legacy plaintext" },
        expiresAt: Date.now() - 1,
    }));
    const message = new Message();
    message.clientMsgNo = "expired-client";
    message.channel = new Channel("receiver", ChannelTypePerson);
    message.content = signalContent("signal_multi");

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => new MessageText("fresh plaintext"),
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(message);

    const refreshed = JSON.parse(persistentStorage.get("wk_e2ee_plaintext:sender:web-device-1:cno:expired-client") || "{}");
    assert.equal(refreshed.payload.content, "fresh plaintext");
    assert.ok(refreshed.expiresAt > Date.now());
    assert.equal((message.content as MessageText).text, "fresh plaintext");
});

test("e2ee_chat_manager decrypts signal-like content from another package instance", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const message = new Message();
    message.channel = channel;
    message.content = {
        contentType: MessageContentType.signalMessage,
        messageType: "signal_multi",
        realContentType: MessageContentType.text,
        senderDeviceId: "web-device-1",
        ciphertext: JSON.stringify({ type: "signal_multi", payload: "ciphertext" }),
        conversationDigest: "[Encrypted Message]",
    } as any;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async (_content, target) => {
                assert.equal(target.channelID, "receiver");
                return new MessageText("foreign decrypted");
            },
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(message);

    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "foreign decrypted");
});

test("e2ee_chat_manager decrypts synced history messages before returning them", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const signalMessage = new Message();
    signalMessage.channel = channel;
    signalMessage.fromUID = "receiver";
    signalMessage.content = signalContent("signal_multi");
    const plainMessage = new Message();
    plainMessage.channel = channel;
    plainMessage.fromUID = "receiver";
    plainMessage.content = new MessageText("already plain");

    sdk.config.provider.syncMessagesCallback = async () => [signalMessage, plainMessage];
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => new MessageText("history decrypted"),
        },
    });

    try {
        const messages = await sdk.chatManager.syncMessages(channel, {
            limit: 15,
            startMessageSeq: 0,
            endMessageSeq: 0,
            pullMode: 0,
        } as any);

        assert.ok(messages[0].content instanceof MessageText);
        assert.equal((messages[0].content as MessageText).text, "history decrypted");
        assert.ok(messages[1].content instanceof MessageText);
        assert.equal((messages[1].content as MessageText).text, "already plain");
    } finally {
        sdk.config.provider.syncMessagesCallback = undefined;
    }
});

test("e2ee_chat_manager logs signal content before and after debug decrypt", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "receiver";
    message.clientMsgNo = "debug-client-msg-no";
    message.messageID = "debug-message-id";
    message.content = signalContent("signal_multi");
    const logs: any[][] = [];
    const originalDebug = sdk.config.debug;
    const originalLog = console.log;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => new MessageText("debug decrypted"),
        },
    });

    try {
        sdk.config.debug = true;
        console.log = (...args: any[]) => {
            logs.push(args);
        };

        await sdk.chatManager.decryptMessageIfNeeded(message);
    } finally {
        sdk.config.debug = originalDebug;
        console.log = originalLog;
    }

    assert.equal(logs.length, 2);
    assert.equal(logs[0][0], "[E2EE] decrypt before");
    assert.equal(logs[1][0], "[E2EE] decrypt after");
    assert.equal(logs[0][1].content.messageType, "signal_multi");
    assert.equal(logs[1][1].content.text, "debug decrypted");
});

test("e2ee_chat_manager undecryptable signal content marks failure state", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const message = new Message();
    message.channel = channel;
    message.content = signalContent("signal_multi");
    const errors: any[][] = [];
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
    });

    try {
        console.error = (...args: any[]) => {
            errors.push(args);
        };
        await sdk.chatManager.decryptMessageIfNeeded(message);
    } finally {
        console.error = originalError;
    }

    assert.equal((message as any).e2eeDecryptFailed, true);
    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "[E2EE] 消息无法解密或无权限查看");
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "[E2EE] decrypt failed");
});

test("e2ee_chat_manager logs failed decrypt detail when debug is enabled", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const message = new Message();
    message.channel = channel;
    message.content = signalContent("signal_multi");
    const logs: any[][] = [];
    const errors: any[][] = [];
    const originalDebug = sdk.config.debug;
    const originalLog = console.log;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
    });

    try {
        sdk.config.debug = true;
        console.log = (...args: any[]) => {
            logs.push(args);
        };
        console.error = (...args: any[]) => {
            errors.push(args);
        };
        await sdk.chatManager.decryptMessageIfNeeded(message);
    } finally {
        sdk.config.debug = originalDebug;
        console.log = originalLog;
        console.error = originalError;
    }

    assert.ok(logs.some((args) => args[0] === "[E2EE] decrypt before"));
    const detail = logs.find((args) => args[0] === "[E2EE] decrypt failed detail");
    assert.ok(detail);
    assert.equal(detail[1].content.messageType, "signal_multi");
    assert.ok(detail[1].error);
    assert.equal(errors.length, 1);
});
