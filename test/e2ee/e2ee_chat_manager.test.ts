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
    MessageEncryptedMedia,
    MessageImage,
    MessageSignalContent,
    MessageText,
} from "../../src/model";
import { MessageContentType } from "../../src/const";
import { E2EEMediaCrypto } from "../../src/e2ee/e2ee_media";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

const TestFileContentType = 8;

class TestFileContent extends MediaMessageContent {
    public width: number = 0;
    public height: number = 0;
    public url: string = "";
    public name: string = "";
    public size: number = 0;

    constructor(file?: File, name?: string, size?: number) {
        super();
        this.file = file;
        this.name = name || (file && file.name) || "";
        this.size = size !== undefined ? size : ((file && (file as any).size) || 0);
    }

    public get contentType(): number {
        return TestFileContentType;
    }

    public decodeJSON(content: any) {
        this.width = content.width || 0;
        this.height = content.height || 0;
        this.url = content.url || "";
        this.remoteUrl = this.url;
        this.name = content.name || "";
        this.size = content.size || 0;
    }

    public encodeJSON() {
        return {
            width: this.width || 0,
            height: this.height || 0,
            url: this.remoteUrl || "",
            name: this.name || "",
            size: this.size || 0,
        };
    }
}

function resetSdk() {
    const sdk = WKSDK.shared();
    sdk.config.uid = "sender";
    sdk.config.e2ee.reset();
    sdk.channelManager.channelInfocacheMap = {};
    (sdk.chatManager as any).e2eePlaintextMemoryCache?.clear?.();
    (sdk.chatManager as any).e2eeDecryptFailureMemoryCache?.clear?.();
    try {
        (globalThis as any).localStorage?.clear?.();
        (globalThis as any).sessionStorage?.clear?.();
    } catch (_error) {
        // ignore test storage cleanup failures
    }
    return sdk;
}

WKSDK.shared().register(TestFileContentType, () => new TestFileContent());

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

function testFile(parts: any[], name: string, type: string): File {
    if (typeof File !== "undefined") {
        return new File(parts, name, { type });
    }
    const blob: any = new Blob(parts, { type });
    blob.name = name;
    return blob as File;
}

function installMediaProvider(store: Map<string, Blob>) {
    let index = 0;
    return {
        uploadEncryptedMedia: async (file: Blob, context: any) => {
            const url = `file/preview/chat/e2ee-${context.kind}-${++index}.bin`;
            store.set(url, file);
            return url;
        },
        fetchEncryptedMedia: async (url: string) => {
            const blob = store.get(url);
            if (!blob) {
                throw new Error(`missing encrypted blob ${url}`);
            }
            return blob;
        },
        createThumbnail: async () => new Blob(["thumb"], { type: "image/jpeg" }),
    };
}

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

async function serverEncryptedFileResponse(blob: Blob): Promise<Response> {
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(key);
    crypto.getRandomValues(nonce);
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const plaintextBase64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        cryptoKey,
        Buffer.from(plaintextBase64, "utf8"),
    ));
    const encryptedData = new Uint8Array(nonce.length + ciphertext.length);
    encryptedData.set(nonce, 0);
    encryptedData.set(ciphertext, nonce.length);
    return new Response(JSON.stringify({
        key: base64(key),
        encrypted_data: base64(encryptedData),
        total_length: encryptedData.length,
    }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

test("e2ee_chat_manager encrypts media messages in enabled channels", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: installMediaProvider(mediaStore),
        cryptoAdapter: {
            encryptMessage: async (content) => {
                assert.equal(content.contentType, MessageContentType.encryptedMedia);
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_multi");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
        },
    });

    const image = new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480);
    const finalContent = await sdk.chatManager.prepareContentForSend(image, channel);

    assert.ok(finalContent instanceof MessageSignalContent);
    assert.ok(encryptedMediaPayload);
    assert.equal(encryptedMediaPayload!.originalContentType, MessageContentType.image);
    assert.ok(encryptedMediaPayload!.original.url);
    assert.ok(encryptedMediaPayload!.original.key);
    assert.ok(encryptedMediaPayload!.thumb.url);
    assert.ok(encryptedMediaPayload!.thumb.key);
    assert.notEqual(encryptedMediaPayload!.original.key, encryptedMediaPayload!.thumb.key);
    assert.equal(mediaStore.size, 2);
});

test("e2ee_chat_manager annotates self-sent encrypted files as downloadable", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: {
            ...installMediaProvider(mediaStore),
            createThumbnail: async () => undefined,
        },
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_file");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
        },
    });

    const file = new TestFileContent(testFile(["hello file"], "credentials.json", "application/json"), "credentials.json", 10);
    const finalContent = await sdk.chatManager.prepareContentForSend(file, channel);

    assert.ok(finalContent instanceof MessageSignalContent);
    assert.ok(encryptedMediaPayload);
    assert.equal(encryptedMediaPayload!.originalContentType, TestFileContentType);
    assert.equal((file as any).file, undefined);
    assert.equal(file.remoteUrl, "");
    assert.equal(file.url, "");
    assert.equal((file as any).e2eeMedia.mediaKind, "media");
    assert.ok((file as any).e2eeMedia.original.url);
    assert.equal((file as any).e2eeMedia.original.url, encryptedMediaPayload!.original.url);
    assert.equal(mediaStore.size, 1);
});

test("e2ee_chat_manager decrypts encrypted media to displayable content", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    const provider = installMediaProvider(mediaStore);
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: provider,
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_multi");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
            decryptMessage: async () => encryptedMediaPayload!,
        },
    });

    const image = new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480);
    await sdk.chatManager.prepareContentForSend(image, channel);
    assert.ok(encryptedMediaPayload);

    const message = new Message();
    message.channel = channel;
    message.fromUID = "receiver";
    message.clientMsgNo = "media-client-no";
    message.content = signalContent("signal_multi");
    (message.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;

    await sdk.chatManager.decryptMessageIfNeeded(message);

    assert.equal(message.content.contentType, MessageContentType.image);
    assert.equal((message.content as any).e2eeMedia.mediaKind, "image");
    assert.ok(((message.content as any).url || "").indexOf("blob:") === 0);
    const originalURL = await sdk.config.e2ee.loadMediaOriginal(message.content);
    assert.ok(originalURL && originalURL.indexOf("blob:") === 0);
});

test("e2ee_chat_manager restores self-sent encrypted media history from metadata cache", async () => {
    installStorageMock("localStorage");
    installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let signalForHistory: MessageSignalContent | undefined;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: installMediaProvider(mediaStore),
        cryptoAdapter: {
            encryptMessage: async (content) => {
                assert.equal(content.contentType, MessageContentType.encryptedMedia);
                const signal = signalContent("signal_multi");
                signal.realContentType = MessageContentType.encryptedMedia;
                signalForHistory = signal;
                return signal;
            },
            decryptMessage: async () => {
                throw new Error("history should restore media from cache before decrypt");
            },
        },
    });

    const sentPackets: any[] = [];
    const originalSend = sdk.chatManager.sendSendPacket;
    try {
        (sdk.chatManager as any).sendSendPacket = (packet: any) => {
            sentPackets.push(packet);
        };

        const sent = await sdk.chatManager.sendWithOptions(
            new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480),
            channel,
            new SendOptions(),
        );

        assert.ok(signalForHistory);
        assert.equal(sentPackets.length, 1);
        assert.equal(sent.content.contentType, MessageContentType.image);

        const plaintextCache = (sdk.chatManager as any).e2eePlaintextMemoryCache as Map<string, string>;
        const cached = [...plaintextCache.values()].map((value) => JSON.parse(value));
        assert.ok(cached.some((item) => item.type === MessageContentType.encryptedMedia));
        assert.ok(cached.every((item) => !item.payload.file));
        plaintextCache.clear();

        const history = new Message();
        history.channel = channel;
        history.fromUID = "sender";
        history.clientMsgNo = sent.clientMsgNo;
        history.content = signalForHistory!;

        await sdk.chatManager.decryptMessageIfNeeded(history);

        assert.equal(history.content.contentType, MessageContentType.image);
        assert.equal((history.content as any).e2eeMedia.mediaKind, "image");
        assert.ok(((history.content as any).url || "").indexOf("blob:") === 0);
    } finally {
        (sdk.chatManager as any).sendSendPacket = originalSend;
    }
});

test("e2ee_chat_manager reports failure when invalid media cache and signal decrypt both fail", async () => {
    const localStore = installStorageMock("localStorage");
    installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    let decryptCalled = false;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalled = true;
                throw new Error("fallback signal decrypt failed");
            },
        },
    });

    const message = new Message();
    message.channel = channel;
    message.fromUID = "sender";
    message.clientMsgNo = "bad-media-cache";
    message.content = signalContent("signal_multi");
    (message.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;

    const cacheKey = (sdk.chatManager as any).e2eePlaintextCacheKeys(message, message.content)[0];
    localStore.set(cacheKey, JSON.stringify({
        type: MessageContentType.encryptedMedia,
        payload: {
            version: 1,
            media_kind: "image",
            original_content_type: MessageContentType.image,
            original: {
                url: "file/preview/chat/bad.e2ee",
            },
        },
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60000,
    }));

    await sdk.chatManager.decryptMessageIfNeeded(message);

    assert.equal(decryptCalled, true);
    assert.equal((message as any).e2eeDecryptFailed, true);
    assert.equal(message.content.contentType, MessageContentType.text);
    assert.equal(localStore.has(cacheKey), false);
});

test("e2ee_chat_manager falls back to signal decrypt when cached encrypted media is invalid", async () => {
    const localStore = installStorageMock("localStorage");
    installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;
    let decryptCalled = false;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: installMediaProvider(mediaStore),
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_multi");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
            decryptMessage: async () => {
                decryptCalled = true;
                return encryptedMediaPayload!;
            },
        },
    });

    await sdk.chatManager.prepareContentForSend(
        new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480),
        channel,
    );
    assert.ok(encryptedMediaPayload);

    const message = new Message();
    message.channel = channel;
    message.fromUID = "receiver";
    message.clientMsgNo = "bad-media-cache-fallback";
    message.content = signalContent("signal_multi");
    (message.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;

    const cacheKey = (sdk.chatManager as any).e2eePlaintextCacheKeys(message, message.content)[0];
    localStore.set(cacheKey, JSON.stringify({
        type: MessageContentType.encryptedMedia,
        payload: {
            version: 1,
            media_kind: "image",
            original_content_type: MessageContentType.image,
            original: {
                url: "file/preview/chat/bad.e2ee",
            },
        },
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60000,
    }));

    await sdk.chatManager.decryptMessageIfNeeded(message);

    assert.equal(decryptCalled, true);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal(message.content.contentType, MessageContentType.image);
    assert.ok(((message.content as any).url || "").indexOf("blob:") === 0);
    assert.equal(localStore.has(cacheKey), false);
});

test("e2ee_chat_manager suppresses repeated missing sender key errors for the same history message", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
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

    const oldError = console.error;
    const errors: any[] = [];
    try {
        console.error = (...args: any[]) => {
            errors.push(args);
        };

        for (let i = 0; i < 2; i++) {
            const message = new Message();
            message.channel = channel;
            message.fromUID = "receiver";
            message.messageID = "history-missing-key-1";
            message.content = signalContent("signal_group");
            await sdk.chatManager.decryptMessageIfNeeded(message);

            assert.equal((message as any).e2eeDecryptFailed, true);
            assert.equal(message.content.contentType, MessageContentType.text);
            assert.ok((message.content as MessageText).text.indexOf("群密钥") >= 0);
        }
    } finally {
        console.error = oldError;
    }

    assert.equal(errors.length, 0);
});

test("e2ee_media unwraps server encrypted file responses before media decrypt", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    const provider = installMediaProvider(mediaStore);
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: provider,
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                return signalContent("signal_multi");
            },
        },
    });

    const image = new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480);
    await sdk.chatManager.prepareContentForSend(image, channel);
    assert.ok(encryptedMediaPayload);

    for (const part of [encryptedMediaPayload!.original, encryptedMediaPayload!.thumb]) {
        const absoluteURL = `http://127.0.0.1/${part.url}`;
        mediaStore.set(absoluteURL, mediaStore.get(part.url)!);
        part.url = absoluteURL;
    }

    const oldFetch = (globalThis as any).fetch;
    try {
        (globalThis as any).fetch = async (url: string) => {
            const blob = mediaStore.get(url);
            if (!blob) {
                throw new Error(`unexpected fetch ${url}`);
            }
            return serverEncryptedFileResponse(blob);
        };

        const restored = await new E2EEMediaCrypto().restoreContent(encryptedMediaPayload!);
        assert.equal(restored.contentType, MessageContentType.image);
        assert.equal((restored as any).e2eeMedia.mediaKind, "image");
        assert.ok(((restored as any).url || "").indexOf("blob:") === 0);
    } finally {
        (globalThis as any).fetch = oldFetch;
    }
});

test("e2ee_media restores file metadata without fetching original until download", async () => {
    const channel = new Channel("receiver", ChannelTypePerson);
    const mediaStore = new Map<string, Blob>();
    let fetchCount = 0;
    const provider = {
        uploadEncryptedMedia: async (file: Blob, context: any) => {
            const url = `file/preview/chat/e2ee-${context.kind}.bin`;
            mediaStore.set(url, file);
            return url;
        },
        fetchEncryptedMedia: async (url: string) => {
            fetchCount++;
            const blob = mediaStore.get(url);
            if (!blob) {
                throw new Error(`missing encrypted blob ${url}`);
            }
            return blob;
        },
        createThumbnail: async () => undefined,
    };
    const crypto = new E2EEMediaCrypto({ provider } as any);
    const source = new TestFileContent(
        testFile(["large file body"], "credentials.json", "application/json"),
        "credentials.json",
        15,
    );

    const encrypted = await crypto.encryptContent(source, channel);
    assert.equal(encrypted.originalContentType, TestFileContentType);
    assert.equal(encrypted.thumb, undefined);

    const restored = await crypto.restoreContent(encrypted);
    assert.equal(fetchCount, 0);
    assert.equal(restored.contentType, TestFileContentType);
    assert.equal((restored as TestFileContent).name, "credentials.json");
    assert.equal((restored as TestFileContent).size, 15);
    assert.equal((restored as TestFileContent).url, "");
    assert.ok((restored as any).e2eeMedia.original);

    const originalURL = await crypto.loadOriginal(restored);
    assert.ok((originalURL || "").indexOf("blob:") === 0);
    assert.equal(fetchCount, 1);

    const cachedURL = await crypto.loadOriginal(restored);
    assert.equal(cachedURL, originalURL);
    assert.equal(fetchCount, 1);
});

test("e2ee_media reuses cached decrypted media thumbnails", async () => {
    installStorageMock("localStorage");
    const channel = new Channel("receiver", ChannelTypePerson);
    const mediaStore = new Map<string, Blob>();
    let fetchCount = 0;
    const provider = {
        uploadEncryptedMedia: async (file: Blob, context: any) => {
            const url = `file/preview/chat/e2ee-${context.kind}.bin`;
            mediaStore.set(url, file);
            return url;
        },
        fetchEncryptedMedia: async (url: string) => {
            fetchCount++;
            const blob = mediaStore.get(url);
            if (!blob) {
                throw new Error(`missing encrypted blob ${url}`);
            }
            return blob;
        },
        createThumbnail: async (blob: Blob) => blob,
    };
    const crypto = new E2EEMediaCrypto({ provider } as any);
    const encrypted = await crypto.encryptContent(
        new MessageImage(testFile(["thumb body"], "thumb.png", "image/png"), 16, 16),
        channel,
    );

    const first = await crypto.restoreContent(encrypted);
    assert.ok(((first as any).url || "").indexOf("blob:") === 0);
    assert.equal(fetchCount, 1);

    const second = await crypto.restoreContent(encrypted);
    assert.ok(((second as any).url || "").indexOf("blob:") === 0);
    assert.equal(fetchCount, 1);
});

test("e2ee_media default upload sends api auth headers", async () => {
    const channel = new Channel("receiver", ChannelTypePerson);
    const captured: any[] = [];
    const oldFetch = (globalThis as any).fetch;
    try {
        (globalThis as any).fetch = async (_url: string, options: any) => {
            captured.push(options);
            return new Response(JSON.stringify({ path: "file/preview/chat/e2ee-original.bin" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };

        const crypto = new E2EEMediaCrypto({
            apiClient: {
                config: {
                    tokenCallback: () => "token-from-callback",
                },
                get: async (path: string) => {
                    assert.ok(path.indexOf("file/upload?") === 0);
                    return { url: "http://127.0.0.1/upload" };
                },
            } as any,
        });

        const encrypted = await crypto.encryptContent(
            new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480),
            channel,
        );

        assert.ok(encrypted.original.url);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].method, "POST");
        assert.equal(captured[0].headers.token, "token-from-callback");
        assert.equal(captured[0].headers["bb-encrypt"], "");
    } finally {
        (globalThis as any).fetch = oldFetch;
    }
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

test("e2ee_chat_manager does not expire persistent plaintext cache entries", async () => {
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
            decryptMessage: async () => {
                throw new Error("persistent plaintext cache should be used before decrypt");
            },
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(message);

    const cached = JSON.parse(persistentStorage.get("wk_e2ee_plaintext:sender:web-device-1:cno:expired-client") || "{}");
    assert.equal(cached.payload.content, "legacy plaintext");
    assert.equal((message.content as MessageText).text, "legacy plaintext");
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

test("e2ee_chat_manager decrypts synced group history by message sequence without reordering result", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const newer = new Message();
    newer.messageID = "group-msg-2";
    newer.clientMsgNo = "group-client-2";
    newer.messageSeq = 2;
    newer.channel = channel;
    newer.fromUID = "alice";
    newer.content = signalContent("signal_group");
    newer.content.ciphertext = JSON.stringify({ msg_index: 1 });

    const older = new Message();
    older.messageID = "group-msg-1";
    older.clientMsgNo = "group-client-1";
    older.messageSeq = 1;
    older.channel = channel;
    older.fromUID = "alice";
    older.content = signalContent("signal_group");
    older.content.ciphertext = JSON.stringify({ msg_index: 0 });

    let nextIndex = 0;
    const decryptOrder: number[] = [];
    sdk.config.provider.syncMessagesCallback = async () => [newer, older];
    await sdk.config.initE2EE({
        uid: "bob",
        deviceId: "bob-web",
        cryptoAdapter: {
            decryptMessage: async (content) => {
                const index = JSON.parse((content as MessageSignalContent).ciphertext).msg_index;
                decryptOrder.push(index);
                if (index < nextIndex) {
                    throw new Error("Missing message key");
                }
                nextIndex = index + 1;
                return new MessageText(`history ${index}`);
            },
        },
    });

    try {
        const messages = await sdk.chatManager.syncMessages(channel, {
            limit: 15,
            startMessageSeq: 0,
            endMessageSeq: 0,
            pullMode: 0,
        } as any);

        assert.strictEqual(messages[0], newer);
        assert.strictEqual(messages[1], older);
        assert.deepEqual(decryptOrder, [0, 1]);
        assert.equal((older.content as MessageText).text, "history 0");
        assert.equal((newer.content as MessageText).text, "history 1");
        assert.equal((older as any).e2eeDecryptFailed, false);
        assert.equal((newer as any).e2eeDecryptFailed, false);
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

test("e2ee_chat_manager realtime signal content recovers and retries decrypt once", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    let recoverCalls = 0;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (decryptCalls === 1) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("recovered realtime");
            },
            recoverDecryptFailure: async (_content: any, target: Channel, context: any) => {
                recoverCalls++;
                assert.equal(target.channelID, "group-1");
                assert.equal(context.fromUID, "member-1");
                assert.equal(context.error.message, "Missing sender key");
                return true;
            },
        } as any,
    });

    await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true } as any);

    assert.equal(decryptCalls, 2);
    assert.equal(recoverCalls, 1);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal((message.content as MessageText).text, "recovered realtime");
});

test("e2ee_chat_manager history signal content does not trigger strong recovery", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.content = signalContent("signal_group");
    let recoverCalls = 0;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing sender key");
            },
            recoverDecryptFailure: async () => {
                recoverCalls++;
                return true;
            },
        } as any,
    });

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message);
    } finally {
        console.error = originalError;
    }

    assert.equal(recoverCalls, 0);
    assert.equal((message as any).e2eeDecryptFailed, true);
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
