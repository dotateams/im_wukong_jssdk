import * as assert from "assert";
import WKSDK from "../../src";
import { SendOptions } from "../../src/chat_manager";
import { SendackPacket } from "../../src/proto";
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
    CMDContent,
    Reply,
} from "../../src/model";
import { MessageContentType } from "../../src/const";
import { E2EE_MAX_INLINE_DECRYPT_BYTES, E2EEMediaCrypto } from "../../src/e2ee/e2ee_media";

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
    for (const timer of ((sdk.chatManager as any).pendingRealtimeE2EETimers?.values?.() || [])) {
        clearTimeout(timer);
    }
    (sdk.chatManager as any).pendingRealtimeE2EEDecrypts?.clear?.();
    (sdk.chatManager as any).pendingRealtimeE2EETimers?.clear?.();
    (sdk.chatManager as any).failedGroupE2EEDecrypts?.clear?.();
    (sdk.chatManager as any).realtimeE2EERetryDelays = [300, 800, 1500, 3000];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 5;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 30 * 1000;
    (sdk.chatManager as any).pendingRealtimeE2EERetryDelays = [5000, 15000, 30000, 60000, 120000];
    (sdk.chatManager as any).pendingRealtimeE2EEMaxTTL = 5 * 60 * 1000;
    (sdk.chatManager as any).pendingRealtimeE2EEMaxTotal = 2000;
    (sdk.chatManager as any).pendingRealtimeE2EEMaxPerGroup = 200;
    try {
        (globalThis as any).localStorage?.clear?.();
        (globalThis as any).sessionStorage?.clear?.();
    } catch (_error) {
        // ignore test storage cleanup failures
    }
    return sdk;
}

WKSDK.shared().register(TestFileContentType, () => new TestFileContent());

async function waitFor(assertion: () => void, timeoutMs: number = 1000) {
    const deadline = Date.now() + timeoutMs;
    let lastError: any;
    while (Date.now() <= deadline) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    assertion();
    if (lastError) {
        throw lastError;
    }
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

test("e2ee media creates reusable forward descriptors without reuploading", async () => {
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
                encryptedMediaPayload = content as MessageEncryptedMedia;
                return signalContent("signal_media");
            },
        },
    });

    const image = new MessageImage(testFile(["forward image"], "forward.png", "image/png"), 320, 240);
    await sdk.chatManager.prepareContentForSend(image, channel);
    assert.ok(encryptedMediaPayload);

    const reusable = sdk.config.e2ee.prepareReusableMediaForwardContent(image) as MessageEncryptedMedia;

    assert.ok(reusable instanceof MessageEncryptedMedia);
    assert.notStrictEqual(reusable, encryptedMediaPayload);
    assert.notStrictEqual(reusable.original, encryptedMediaPayload!.original);
    assert.equal(reusable.original.url, encryptedMediaPayload!.original.url);
    assert.equal(reusable.original.key, encryptedMediaPayload!.original.key);
    assert.equal(reusable.thumb.url, encryptedMediaPayload!.thumb.url);
    assert.equal(reusable.thumb.key, encryptedMediaPayload!.thumb.key);
    assert.equal(mediaStore.size, 2);
});

test("e2ee media metadata includes plaintext file md5 for single and chunked uploads", async () => {
    const channel = new Channel("group-1", ChannelTypeGroup);
    const singleCrypto = new E2EEMediaCrypto({
        provider: installMediaProvider(new Map<string, Blob>()),
    });
    const singleFile = testFile(["hello-md5"], "hello.txt", "text/plain");
    const single = await singleCrypto.encryptContent(new TestFileContent(singleFile), channel);

    assert.equal(single.original.file_md5, "e9820012060b19cead6148900edf4a32");

    const chunkedCrypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-md5" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => ({
                url: `chunk-${context.chunkIndex}`,
                size: blob.size,
            }),
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 4,
        chunkSize: 3,
    });
    const chunkedFile = new File(["hello-md5"], "chunked.txt", { type: "text/plain" });
    const chunked = await chunkedCrypto.encryptContent(new TestFileContent(chunkedFile), channel);

    assert.equal(chunked.original.mode, "chunked");
    assert.equal(chunked.original.file_md5, "e9820012060b19cead6148900edf4a32");
});

test("e2ee media md5 is computed incrementally for chunked uploads", async () => {
    const channel = new Channel("group-1", ChannelTypeGroup);
    const chunkedCrypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-md5-incremental" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => ({
                url: `chunk-${context.chunkIndex}`,
                size: blob.size,
            }),
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 4,
        chunkSize: 3,
    });
    const chunkedFile = new File(["hello-md5"], "chunked.txt", { type: "text/plain" });
    (chunkedFile as any).arrayBuffer = async () => {
        throw new Error("full-file arrayBuffer should not be used for chunked md5");
    };

    const chunked = await chunkedCrypto.encryptContent(new TestFileContent(chunkedFile), channel);

    assert.equal(chunked.original.mode, "chunked");
    assert.equal(chunked.original.file_md5, "e9820012060b19cead6148900edf4a32");
});

test("e2ee media forwardability reports typed reasons", async () => {
    const crypto = new E2EEMediaCrypto();

    assert.deepEqual(crypto.canForwardE2EEMedia(undefined as any), { ok: false, reason: "missing-media" });
    assert.deepEqual(crypto.canForwardE2EEMedia({ e2eeMedia: { original: { key: "k" } } } as any), { ok: false, reason: "missing-object" });
    assert.deepEqual(crypto.canForwardE2EEMedia({ e2eeMedia: { original: { url: "u", key: "k", nonce: "n" } } } as any), { ok: false, reason: "missing-hash" });
    assert.deepEqual(crypto.canForwardE2EEMedia({
        e2eeMedia: {
            original: {
                mode: "chunked",
                chunks: [
                    { index: 0, url: "u", key: "k", nonce: "n", sha256: "s" },
                ],
            },
        },
    } as any), { ok: true });
});

test("e2ee media exposes decrypted original blob for plaintext forward fallback", async () => {
    const channel = new Channel("group-1", ChannelTypeGroup);
    const mediaStore = new Map<string, Blob>();
    const crypto = new E2EEMediaCrypto({
        provider: installMediaProvider(mediaStore),
    });
    const file = testFile(["plain fallback"], "fallback.txt", "text/plain");
    const encrypted = await crypto.encryptContent(new TestFileContent(file), channel);
    const blob = await crypto.loadOriginalBlob({ e2eeMedia: encrypted } as any);

    assert.ok(blob);
    assert.equal(await blob!.text(), "plain fallback");
});

test("e2ee_chat_manager rejects oversized encrypted media inline downloads", async () => {
    let fetchCalled = false;
    const media = new E2EEMediaCrypto({
        mediaProvider: {
            fetchEncryptedMedia: async () => {
                fetchCalled = true;
                return new Blob(["should not fetch"]);
            },
        },
    });
    const content: any = {
        e2eeMedia: {
            original: {
                url: "chat/2/group/large.zip.e2ee",
                key: "key",
                nonce: "nonce",
                sha256: "sha",
                size: E2EE_MAX_INLINE_DECRYPT_BYTES + 1,
            },
        },
    };

    await assert.rejects(
        () => media.loadOriginal(content),
        /too large for inline decrypt/,
    );
    assert.equal(fetchCalled, false);
});

test("e2ee media encrypts oversized files as chunked v2 manifests", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    cacheChannelInfo(channel, true);
    const uploadedChunks: Array<{ blob: Blob; context: any }> = [];
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        apiClient: {
            post: async () => ({ session_id: "session-1" }),
        },
        cryptoAdapter: {
            encryptMessage: async (content) => content,
        },
        mediaProvider: {
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => {
                uploadedChunks.push({ blob, context });
                return {
                    url: `file/preview/chat/chunks/${context.sessionId}/${context.chunkIndex}.e2ee`,
                    size: blob.size,
                };
            },
            completeEncryptedMediaUpload: async (_context: any) => {
                return { ok: true };
            },
        } as any,
        mediaOptions: { chunkThresholdBytes: 8, chunkSize: 4 } as any,
    });

    const file = new File([
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8, 9]),
    ], "large.zip", { type: "application/zip" });
    const finalContent = await sdk.chatManager.prepareContentForSend(new TestFileContent(file), channel) as any;
    const encrypted = finalContent.e2eePlaintextContent as MessageEncryptedMedia;

    assert.strictEqual(encrypted.version, 2);
    assert.strictEqual(encrypted.original.mode, "chunked");
    assert.strictEqual(encrypted.original.chunk_size, 4);
    assert.ok(encrypted.original.chunks.length > 1);
    assert.strictEqual(encrypted.original.size, file.size);
    assert.strictEqual(typeof encrypted.original.sha256, "string");
    assert.ok(encrypted.original.sha256.length > 0);
    assert.strictEqual(encrypted.original.chunk_count, encrypted.original.chunks.length);
    assert.strictEqual(uploadedChunks.length, encrypted.original.chunks.length);
    assert.strictEqual(uploadedChunks[0].context.sessionId, "session-1");
});

test("e2ee media downloads chunked v2 manifests without inline decrypt size limits", async () => {
    resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const uploaded = new Map<string, Blob>();
    const crypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-1" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => {
                const url = `chunk-${context.chunkIndex}`;
                uploaded.set(url, blob);
                return { url, size: blob.size };
            },
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 8,
        chunkSize: 4,
    });
    const file = new File([
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8, 9]),
    ], "large.bin", { type: "application/octet-stream" });
    const encrypted = await crypto.encryptContent(new TestFileContent(file), channel);
    const downloadCrypto = new E2EEMediaCrypto({
        provider: {
            fetchEncryptedMedia: async (url: string) => {
                const found = uploaded.get(url);
                if (!found) {
                    throw new Error(`missing ${url}`);
                }
                return found;
            },
        },
    });

    const restoredUrl = await downloadCrypto.loadOriginal({ e2eeMedia: encrypted });

    assert.ok(restoredUrl);
});

test("e2ee media loadOriginal reports chunked download progress", async () => {
    resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const uploaded = new Map<string, Blob>();
    const crypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-1" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => {
                const url = `chunk-${context.chunkIndex}`;
                uploaded.set(url, blob);
                return { url, size: blob.size };
            },
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 8,
        chunkSize: 4,
    });
    const file = new File([
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8, 9]),
    ], "large.bin", { type: "application/octet-stream" });
    const encrypted = await crypto.encryptContent(new TestFileContent(file), channel);
    const progressEvents: any[] = [];
    const downloadCrypto = new E2EEMediaCrypto({
        provider: {
            fetchEncryptedMedia: async (url: string, context?: any) => {
                const found = uploaded.get(url);
                if (!found) {
                    throw new Error(`missing ${url}`);
                }
                context?.onDownloadProgress?.({ loaded: Math.ceil(found.size / 2), total: found.size });
                context?.onDownloadProgress?.({ loaded: found.size, total: found.size });
                return found;
            },
        },
    });

    const restoredUrl = await (downloadCrypto as any).loadOriginal({ e2eeMedia: encrypted }, {
        onProgress: (progress: any) => progressEvents.push(progress),
    });

    assert.ok(restoredUrl);
    assert.ok(progressEvents.some((progress) => progress.phase === "downloading"));
    assert.ok(progressEvents.some((progress) => progress.percent > 0 && progress.percent < 100));
    assert.strictEqual(progressEvents[progressEvents.length - 1].percent, 100);
});

test("e2ee media rejects chunked manifests with missing duplicate or non-contiguous chunks", async () => {
    resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const uploaded = new Map<string, Blob>();
    const crypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-1" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => {
                const url = `chunk-${context.chunkIndex}`;
                uploaded.set(url, blob);
                return { url, size: blob.size };
            },
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 8,
        chunkSize: 4,
    });
    const encrypted = await crypto.encryptContent(new TestFileContent(new File([
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8, 9]),
    ], "large.bin", { type: "application/octet-stream" })), channel) as any;
    const downloadCrypto = new E2EEMediaCrypto({
        provider: {
            fetchEncryptedMedia: async (url: string) => {
                const found = uploaded.get(url);
                if (!found) {
                    throw new Error(`missing ${url}`);
                }
                return found;
            },
        },
    });

    const missing = JSON.parse(JSON.stringify(encrypted));
    missing.original.chunks = missing.original.chunks.slice(0, -1);
    await assert.rejects(() => downloadCrypto.loadOriginalBlob({ e2eeMedia: missing } as any), /chunk/i);

    const duplicate = JSON.parse(JSON.stringify(encrypted));
    duplicate.original.chunks[1].index = duplicate.original.chunks[0].index;
    await assert.rejects(() => downloadCrypto.loadOriginalBlob({ e2eeMedia: duplicate } as any), /index|duplicate|chunk/i);

    const overlap = JSON.parse(JSON.stringify(encrypted));
    overlap.original.chunks[1].offset = overlap.original.chunks[0].offset;
    await assert.rejects(() => downloadCrypto.loadOriginalBlob({ e2eeMedia: overlap } as any), /offset|chunk/i);
});

test("e2ee media rejects chunked manifests when whole-file sha256 mismatches", async () => {
    resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const uploaded = new Map<string, Blob>();
    const crypto = new E2EEMediaCrypto({
        provider: {
            createEncryptedMediaUploadSession: async () => ({ session_id: "session-1" }),
            uploadEncryptedMediaChunk: async (blob: Blob, context: any) => {
                const url = `chunk-${context.chunkIndex}`;
                uploaded.set(url, blob);
                return { url, size: blob.size };
            },
            completeEncryptedMediaUpload: async () => ({ ok: true }),
        } as any,
        chunkThresholdBytes: 8,
        chunkSize: 4,
    });
    const encrypted = await crypto.encryptContent(new TestFileContent(new File([
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8, 9]),
    ], "large.bin", { type: "application/octet-stream" })), channel) as any;
    encrypted.original.sha256 = "0".repeat(64);
    const downloadCrypto = new E2EEMediaCrypto({
        provider: {
            fetchEncryptedMedia: async (url: string) => uploaded.get(url)!,
        },
    });

    await assert.rejects(() => downloadCrypto.loadOriginalBlob({ e2eeMedia: encrypted } as any), /hash mismatch/i);
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

test("e2ee_chat_manager restores received person encrypted media from cache without reusing signal message keys", async () => {
    installStorageMock("localStorage");
    installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let fetchCount = 0;
    const provider = {
        ...installMediaProvider(mediaStore),
        fetchEncryptedMedia: async (url: string) => {
            fetchCount++;
            const blob = mediaStore.get(url);
            if (!blob) {
                throw new Error(`missing encrypted blob ${url}`);
            }
            return blob;
        },
    };
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;
    let decryptCalls = 0;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: provider,
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_person_media");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
            decryptMessage: async () => {
                decryptCalls += 1;
                if (decryptCalls > 1) {
                    throw new Error("person signal message key was reused");
                }
                return encryptedMediaPayload!;
            },
        },
    });

    const image = new MessageImage(testFile(["hello image"], "hello.png", "image/png"), 640, 480);
    await sdk.chatManager.prepareContentForSend(image, channel);
    assert.ok(encryptedMediaPayload);

    const realtime = new Message();
    realtime.channel = channel;
    realtime.fromUID = "receiver";
    realtime.clientMsgNo = "person-media-client-no";
    realtime.messageID = "person-media-message-id";
    realtime.content = signalContent("signal_person_media");
    (realtime.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;

    await sdk.chatManager.decryptMessageIfNeeded(realtime, { realtime: true });

    assert.equal(realtime.content.contentType, MessageContentType.image);

    const history = new Message();
    history.channel = channel;
    history.fromUID = "receiver";
    history.clientMsgNo = realtime.clientMsgNo;
    history.messageID = realtime.messageID;
    history.content = signalContent("signal_person_media");
    (history.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;

    await sdk.chatManager.decryptMessageIfNeeded(history);

    assert.equal(decryptCalls, 1);
    assert.equal(fetchCount, 1);
    assert.equal(history.content.contentType, MessageContentType.image);
    assert.equal((history.content as any).e2eeMedia.mediaKind, "image");
});

test("e2ee_chat_manager keeps group media out of plaintext cache without changing thumbnail cache", async () => {
    installStorageMock("localStorage");
    installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    let fetchCount = 0;
    const provider = {
        ...installMediaProvider(mediaStore),
        fetchEncryptedMedia: async (url: string) => {
            fetchCount++;
            const blob = mediaStore.get(url);
            if (!blob) {
                throw new Error(`missing encrypted blob ${url}`);
            }
            return blob;
        },
    };
    let encryptedMediaPayload: MessageEncryptedMedia | undefined;
    let decryptCalls = 0;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: provider,
        cryptoAdapter: {
            encryptMessage: async (content) => {
                encryptedMediaPayload = content as MessageEncryptedMedia;
                const signal = signalContent("signal_group_media");
                signal.realContentType = MessageContentType.encryptedMedia;
                return signal;
            },
            decryptMessage: async () => {
                decryptCalls++;
                return encryptedMediaPayload!;
            },
        },
    });

    const image = new MessageImage(testFile(["hello group image"], "group.png", "image/png"), 640, 480);
    await sdk.chatManager.prepareContentForSend(image, channel);
    assert.ok(encryptedMediaPayload);

    for (const clientMsgNo of ["group-media-1", "group-media-2"]) {
        const message = new Message();
        message.channel = channel;
        message.fromUID = "receiver";
        message.clientMsgNo = clientMsgNo;
        message.content = signalContent("signal_group_media");
        (message.content as MessageSignalContent).realContentType = MessageContentType.encryptedMedia;
        await sdk.chatManager.decryptMessageIfNeeded(message);
        assert.equal(message.content.contentType, MessageContentType.image);
    }

    assert.equal(decryptCalls, 2);
    assert.equal(fetchCount, 1);
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
    assert.equal(localStore.has(cacheKey), true);
    const refreshedCache = JSON.parse(localStore.get(cacheKey)!);
    assert.equal(refreshedCache.type, MessageContentType.encryptedMedia);
    assert.equal(refreshedCache.payload.original.url, encryptedMediaPayload!.original.url);
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
            assert.equal((message.content as MessageText).text, "消息无法解密");
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

test("e2ee_media unwraps provider json encrypted file responses before save", async () => {
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    cacheChannelInfo(channel, true);
    const mediaStore = new Map<string, Blob>();
    const provider = installMediaProvider(mediaStore);

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        mediaProvider: provider,
        cryptoAdapter: {
            encryptMessage: async (content) => content,
        },
    });

    const encrypted = await sdk.config.e2ee.encryptMediaMessage(
        new TestFileContent(testFile(["small secret body"], "small.txt", "text/plain"), "small.txt", 17),
        channel,
    ) as any;
    const media = encrypted.e2eePlaintextContent as MessageEncryptedMedia;
    const sourceBlob = mediaStore.get(media.original.url)!;
    assert.ok(sourceBlob);

    const saved: Blob[] = [];
    const oldPicker = (globalThis as any).showSaveFilePicker;
    try {
        (globalThis as any).showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (blob: Blob) => {
                    saved.push(blob);
                },
                close: async () => undefined,
                abort: async () => undefined,
            }),
        });
        const crypto = new E2EEMediaCrypto({
            provider: {
                fetchEncryptedMedia: async (_url: string, context?: any) => {
                    context?.onDownloadProgress?.({ loaded: sourceBlob.size, total: sourceBlob.size });
                    return (await serverEncryptedFileResponse(sourceBlob)).blob();
                },
            },
        } as any);
        const ok = await crypto.saveOriginal({ e2eeMedia: media, name: "small.txt" } as any, "small.txt", {
            onProgress: () => undefined,
        });
        assert.equal(ok, true);
        assert.equal(saved.length, 1);
        assert.equal(await saved[0].text(), "small secret body");
    } finally {
        (globalThis as any).showSaveFilePicker = oldPicker;
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
    const notifiedTexts: string[] = [];
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

test("e2ee_chat_manager defers realtime group decrypt so UI gets a pending message first", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "peer";
    message.clientMsgNo = "client-1";
    message.messageID = "message-1";
    message.content = signalContent("signal_group");

    let releaseDecrypt: (() => void) | undefined;
    const decryptStarted = new Promise<void>((resolve) => {
        releaseDecrypt = resolve;
    });
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                await decryptStarted;
                return new MessageText("decrypted realtime");
            },
        },
    });

    const notifiedMessages: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;

    try {
        (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
            notifiedMessages.push(item);
        };

        const deferred = (sdk.chatManager as any).deferRealtimeE2EEDecryptIfNeed(message);

        assert.equal(deferred, true);
        assert.equal(notifiedMessages.length, 1);
        assert.equal((notifiedMessages[0].content as MessageText).text, "消息解密中...");
        assert.equal((notifiedMessages[0] as any).e2eePendingDecrypt, true);

        releaseDecrypt!();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(notifiedMessages.length, 2);
        assert.ok(notifiedMessages[1].content instanceof MessageText);
        assert.equal((notifiedMessages[1].content as MessageText).text, "decrypted realtime");
        assert.equal((notifiedMessages[1] as any).e2eePendingDecrypt, false);
        assert.equal((notifiedMessages[1] as any).e2eeDecryptFailed, false);
    } finally {
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }
});

test("e2ee_chat_manager keeps realtime group decrypt order while sender key is pending", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const makeMessage = (id: string, seq: number, payload: string) => {
        const message = new Message();
        message.channel = channel;
        message.fromUID = "peer";
        message.clientMsgNo = `client-${id}`;
        message.messageID = `message-${id}`;
        message.messageSeq = seq;
        const content = signalContent("signal_group");
        content.ciphertext = JSON.stringify({ type: "signal_group", payload });
        message.content = content;
        return message;
    };
    const first = makeMessage("1", 10, "first plaintext");
    const second = makeMessage("2", 11, "second plaintext");
    let allowDecrypt = false;
    const decryptPayloads: string[] = [];

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async (content: any) => {
                const payload = JSON.parse(content.ciphertext).payload;
                decryptPayloads.push(payload);
                if (!allowDecrypt) {
                    throw new Error("Missing sender key");
                }
                return new MessageText(payload);
            },
            recoverDecryptFailure: async () => false,
        },
    });
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 1;
    (sdk.chatManager as any).pendingRealtimeE2EERetryDelays = [60000];

    const notifiedTexts: string[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;

    try {
        (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
            if (item.content instanceof MessageText) {
                notifiedTexts.push((item.content as MessageText).text);
            }
        };

        assert.equal((sdk.chatManager as any).deferRealtimeE2EEDecryptIfNeed(first), true);
        await waitFor(() => {
            assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 1);
        });

        assert.equal((sdk.chatManager as any).deferRealtimeE2EEDecryptIfNeed(second), true);
        await waitFor(() => {
            assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 2);
        });

        assert.equal(decryptPayloads.includes("second plaintext"), false);

        allowDecrypt = true;
        const recovered = await (sdk.chatManager as any).retryPendingE2EEDecrypts();

        assert.equal(recovered, 2);
        assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 0);
        assert.deepEqual(
            notifiedTexts.filter((text) => text === "first plaintext" || text === "second plaintext"),
            ["first plaintext", "second plaintext"],
        );
    } finally {
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }
});

test("e2ee_chat_manager drains pending sender-key repairs after group send ack", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const e2ee = sdk.config.e2ee as any;
    const originalPrepare = e2ee.prepareGroupSend;
    const originalInvalidate = e2ee.invalidateGroupRepairRequestCache;
    const calls: string[] = [];
    const packet = sdk.chatManager.getSendPacketWithOptions(new MessageText("hello"), channel, new SendOptions());
    const ack = new SendackPacket();
    ack.clientSeq = packet.clientSeq;
    ack.reasonCode = 1;
    (sdk.chatManager as any).sendingQueues.set(packet.clientSeq, packet);
    (sdk.chatManager as any).e2eePostSendRepairDelayMs = 10;

    try {
        e2ee.invalidateGroupRepairRequestCache = (item: Channel) => {
            calls.push(`invalidate:${item.channelID}:${item.channelType}`);
        };
        e2ee.prepareGroupSend = async (item: Channel) => {
            calls.push(`prepare:${item.channelID}:${item.channelType}`);
        };

        await sdk.chatManager.onPacket(ack);
        await waitFor(() => {
            assert.deepEqual(calls, [
                "invalidate:group-1:2",
                "prepare:group-1:2",
            ]);
        }, 500);
    } finally {
        e2ee.prepareGroupSend = originalPrepare;
        e2ee.invalidateGroupRepairRequestCache = originalInvalidate;
        (sdk.chatManager as any).e2eePostSendRepairDelayMs = 2500;
    }
});

test("e2ee_chat_manager only prints realtime step logs when explicit trace is enabled", async () => {
    const sdk = resetSdk();
    sdk.config.debug = false;
    (sdk.config as any).e2eeTrace = false;
    const originalInfo = console.info;
    const logs: any[] = [];
    const message = new Message();
    message.channel = new Channel("group-1", ChannelTypeGroup);
    message.fromUID = "peer";
    const content = signalContent("signal_group");
    content.senderDeviceId = "peer-web";

    try {
        console.info = (...args: any[]) => {
            logs.push(args);
        };
        (sdk.chatManager as any).logRealtimeE2EEStep("收到实时消息", message, content);
        sdk.config.debug = true;
        (sdk.config as any).e2eeTrace = false;
        (sdk.chatManager as any).logRealtimeE2EEStep("收到实时消息", message, content);
        (sdk.config as any).e2eeTrace = true;
        (sdk.chatManager as any).logRealtimeE2EEStep("收到实时消息", message, content);
    } finally {
        console.info = originalInfo;
        sdk.config.debug = false;
        delete (sdk.config as any).e2eeTrace;
    }

    assert.equal(logs.length, 1);
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

test("e2ee_chat_manager plaintext cache preserves reply metadata", async () => {
    const sessionCache = installStorageMock("sessionStorage");
    const sdk = resetSdk();
    const channel = new Channel("receiver", ChannelTypePerson);
    const reply = new Reply();
    reply.messageID = "quoted-message";
    reply.messageSeq = 42;
    reply.fromUID = "quoted-user";
    reply.fromName = "Quoted User";
    reply.content = new MessageText("quoted text");
    const decrypted = new MessageText("answer text");
    decrypted.reply = reply;

    const first = new Message();
    first.messageID = "reply-msg-1";
    first.clientMsgNo = "reply-client-1";
    first.channel = channel;
    first.fromUID = "receiver";
    first.content = signalContent("signal_multi");

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => decrypted,
        },
    });

    await sdk.chatManager.decryptMessageIfNeeded(first);
    assert.equal((first.content as MessageText).reply?.fromName, "Quoted User");
    (sdk.chatManager as any).e2eePlaintextMemoryCache.clear();
    assert.ok([...sessionCache.keys()].some((key) => key.includes("wk_e2ee_plaintext:sender:web-device-1:ct:")));

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("plaintext cache should be used");
            },
        },
    });

    const replay = new Message();
    replay.messageID = "reply-msg-1";
    replay.clientMsgNo = "reply-client-1";
    replay.channel = channel;
    replay.fromUID = "receiver";
    replay.content = signalContent("signal_multi");

    await sdk.chatManager.decryptMessageIfNeeded(replay);

    const restored = replay.content as MessageText;
    assert.equal(restored.text, "answer text");
    assert.equal(restored.reply?.messageID, "quoted-message");
    assert.equal(restored.reply?.fromName, "Quoted User");
    assert.equal((restored.reply?.content as MessageText).text, "quoted text");
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
    assert.equal((message.content as MessageText).text, "消息无法解密");
    assert.equal((message.content as any).e2eeDecryptState, "failed");
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

test("e2ee_chat_manager realtime recoverable failures stay pending and retry before final failure", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 8;
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    let recoverCalls = 0;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (decryptCalls < 3) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("queued realtime recovered");
            },
            recoverDecryptFailure: async () => {
                recoverCalls++;
                return false;
            },
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 4;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 1000;

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true } as any);
    } finally {
        console.error = originalError;
    }

    assert.equal(decryptCalls, 3);
    assert.equal(recoverCalls, 2);
    assert.equal((message as any).e2eePendingDecrypt, false);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal((message.content as MessageText).text, "queued realtime recovered");
});

test("e2ee_chat_manager realtime recoverable failures become final after retry limit", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 9;
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                throw new Error("Missing sender key");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 3;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 1000;

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true } as any);
    } finally {
        console.error = originalError;
    }

    assert.equal(decryptCalls, 3);
    assert.equal((message as any).e2eePendingDecrypt, false);
    assert.equal((message as any).e2eeDecryptFailed, true);
    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "消息无法解密");
    assert.equal((message.content as any).e2eeDecryptState, "failed");
});

test("e2ee_chat_manager recoverable realtime group failures show user friendly decrypting placeholder", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 10;
    message.content = signalContent("signal_group");

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing sender key");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [10000];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 1;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 60000;

    await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true } as any);

    assert.equal((message as any).e2eePendingDecrypt, true);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "消息解密中...");
    assert.equal((message.content as any).e2eeDecryptState, "pending");
    assert.equal((message.content as MessageText).text.includes("E2EE"), false);
});

test("e2ee_chat_manager final decrypt failures hide technical E2EE wording", () => {
    const sdk = resetSdk();
    const finalContent = sdk.chatManager.buildE2EEDecryptFailureContent(new Error("Missing sender key"), { realtime: false } as any);
    const genericContent = sdk.chatManager.buildE2EEDecryptFailureContent(new Error("bad ciphertext"), {} as any);

    assert.equal(finalContent.text, "消息无法解密");
    assert.equal(genericContent.text, "消息无法解密");
    assert.equal(finalContent.text.includes("E2EE"), false);
    assert.equal(genericContent.text.includes("E2EE"), false);
    assert.equal((finalContent as any).e2eeDecryptState, "failed");
});

test("e2ee_chat_manager realtime deferred retry delivers skeleton before background recovery", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 10;
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    let recoverCalls = 0;
    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (decryptCalls < 3) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("background recovered");
            },
            recoverDecryptFailure: async () => {
                recoverCalls++;
                return false;
            },
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 4;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 1000;
    (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
        notified.push(item);
    };

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true } as any);
        assert.equal(decryptCalls, 1);
        assert.equal((message as any).e2eePendingDecrypt, true);
        assert.equal((message.content as MessageText).text, "消息解密中...");
        assert.equal((message.content as any).e2eeDecryptState, "pending");
        await waitFor(() => assert.equal((message.content as MessageText).text, "background recovered"));
    } finally {
        console.error = originalError;
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.equal(decryptCalls, 3);
    assert.equal(recoverCalls, 2);
    assert.ok(notified.length >= 1);
    assert.equal(notified[notified.length - 1], message);
    assert.equal(notified[0], message);
    assert.equal((message as any).e2eePendingDecrypt, false);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal((message.content as MessageText).text, "background recovered");
});

test("e2ee_chat_manager realtime deferred final failure does not use history wording", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 11;
    message.content = signalContent("signal_group");
    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new Error("Missing sender key");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 2;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 1000;
    (sdk.chatManager as any).pendingRealtimeE2EEMaxTTL = 1;
    (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
        notified.push(item);
    };

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true } as any);
        assert.equal((message as any).e2eePendingDecrypt, true);
        await waitFor(() => assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 1));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (sdk.chatManager as any).retryPendingE2EEDecrypts();
        await waitFor(() => assert.equal((message as any).e2eeDecryptFailed, true));
    } finally {
        console.error = originalError;
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.ok(notified.length >= 1);
    assert.equal(notified[notified.length - 1], message);
    assert.equal((message as any).e2eePendingDecrypt, false);
    assert.equal((message as any).e2eeDecryptFailed, true);
    assert.ok(message.content instanceof MessageText);
    assert.equal((message.content as MessageText).text, "消息无法解密");
    assert.equal((message.content as any).e2eeDecryptState, "failed");
});

test("e2ee_chat_manager retries pending realtime group decrypt after sender key arrives late", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 12;
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    let keyReady = false;
    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (!keyReady) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("late key recovered");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 2;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 1000;
    (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
        notified.push(item);
    };

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true } as any);
        await waitFor(() => assert.equal((message as any).e2eePendingDecrypt, true));
        await waitFor(() => assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 1));

        keyReady = true;
        const recovered = await (sdk.chatManager as any).retryPendingE2EEDecrypts();
        assert.equal(recovered, 1);
    } finally {
        console.error = originalError;
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.ok(decryptCalls >= 3);
    assert.equal((message as any).e2eePendingDecrypt, false);
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal((message.content as MessageText).text, "late key recovered");
    assert.equal(notified[notified.length - 1], message);
});

test("e2ee_chat_manager retries pending realtime group decrypt immediately after group distribution command", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 13;
    message.content = signalContent("signal_group");
    const distribution = new Message();
    distribution.channel = channel;
    distribution.fromUID = "member-1";
    distribution.messageSeq = 14;
    distribution.content = signalContent("signal_group_distribution");
    let keyReady = false;
    let decryptCalls = 0;
    const notified: Message[] = [];
    const originalNotify = sdk.chatManager.notifyMessageListeners;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async (content: MessageSignalContent) => {
                if (content.messageType === "signal_group_distribution") {
                    keyReady = true;
                    const cmd = new CMDContent();
                    cmd.cmd = "signal_group_distribution";
                    cmd.param = { group_id: "group-1" };
                    return cmd;
                }
                decryptCalls++;
                if (!keyReady) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("distribution woke pending message");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [10000];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 1;
    (sdk.chatManager as any).realtimeE2EEPendingTTL = 60000;
    (sdk.chatManager as any).notifyMessageListeners = (item: Message) => {
        notified.push(item);
    };

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true, deferRecoverable: true } as any);
        await waitFor(() => assert.equal((message as any).e2eePendingDecrypt, true));
        await waitFor(() => assert.equal((sdk.chatManager as any).pendingRealtimeE2EEDecrypts.size, 1));

        await sdk.chatManager.decryptMessageIfNeeded(distribution, { realtime: true } as any);
    } finally {
        console.error = originalError;
        (sdk.chatManager as any).notifyMessageListeners = originalNotify;
    }

    assert.equal((message.content as MessageText).text, "distribution woke pending message");
    assert.equal((message as any).e2eeDecryptFailed, false);
    assert.equal(notified[notified.length - 1], message);
    assert.ok(decryptCalls >= 2);
});

test("e2ee_chat_manager operation errors outside ready window do not retry", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageSeq = 11;
    message.content = signalContent("signal_group");
    let decryptCalls = 0;
    let recoverCalls = 0;
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                throw new DOMException("operation failed", "OperationError");
            },
            recoverDecryptFailure: async () => {
                recoverCalls++;
                return true;
            },
        } as any,
    });
    Object.defineProperty(sdk.config.e2ee as any, "readyAt", {
        configurable: true,
        get: () => Date.now() - 60_000,
    });
    (sdk.chatManager as any).realtimeE2EERetryDelays = [1, 1, 1];
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 4;

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { realtime: true } as any);
    } finally {
        console.error = originalError;
        delete (sdk.config.e2ee as any).readyAt;
    }

    assert.equal(decryptCalls, 1);
    assert.equal(recoverCalls, 0);
    assert.equal((message as any).e2eeDecryptFailed, true);
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

test("e2ee_chat_manager recoverable synced group message triggers sender key repair", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.content = signalContent("signal_group");
    let recoverCalls = 0;
    let decryptCalls = 0;

    await sdk.config.initE2EE({
        uid: "receiver",
        deviceId: "receiver-web",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (decryptCalls === 1) {
                    throw new Error("Missing sender key");
                }
                return new MessageText("synced recovered");
            },
            recoverDecryptFailure: async (_content: any, _channel: any, context: any) => {
                recoverCalls++;
                assert.equal(context.realtime, true);
                assert.equal(context.fromUID, "member-1");
                return true;
            },
        } as any,
    });

    await sdk.chatManager.decryptMessageIfNeeded(message, { recoverableSync: true } as any);

    assert.equal(recoverCalls, 1);
    assert.equal((message.content as MessageText).text, "synced recovered");
    assert.equal((message as any).e2eeDecryptFailed, false);
});

test("e2ee_chat_manager recoverable synced group OperationError triggers sender key repair", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.content = signalContent("signal_group");
    let recoverCalls = 0;
    let decryptCalls = 0;

    await sdk.config.initE2EE({
        uid: "receiver",
        deviceId: "receiver-web",
        cryptoAdapter: {
            decryptMessage: async () => {
                decryptCalls++;
                if (decryptCalls === 1) {
                    throw new DOMException("operation failed", "OperationError");
                }
                return new MessageText("operation recovered");
            },
            recoverDecryptFailure: async (_content: any, _channel: any, context: any) => {
                recoverCalls++;
                assert.equal(context.realtime, true);
                assert.equal(context.fromUID, "member-1");
                return true;
            },
        } as any,
    });

    await sdk.chatManager.decryptMessageIfNeeded(message, { recoverableSync: true } as any);

    assert.equal(recoverCalls, 1);
    assert.equal((message.content as MessageText).text, "operation recovered");
    assert.equal((message as any).e2eeDecryptFailed, false);
});

test("e2ee_chat_manager keeps recoverable synced group OperationError in failed retry queue", async () => {
    const sdk = resetSdk();
    const channel = new Channel("group-1", ChannelTypeGroup);
    const message = new Message();
    message.channel = channel;
    message.fromUID = "member-1";
    message.messageID = "m-op-1" as any;
    message.content = signalContent("signal_group");
    const originalError = console.error;

    await sdk.config.initE2EE({
        uid: "receiver",
        deviceId: "receiver-web",
        cryptoAdapter: {
            decryptMessage: async () => {
                throw new DOMException("operation failed", "OperationError");
            },
            recoverDecryptFailure: async () => false,
        } as any,
    });
    (sdk.chatManager as any).realtimeE2EEMaxAttempts = 1;

    try {
        console.error = () => undefined;
        await sdk.chatManager.decryptMessageIfNeeded(message, { recoverableSync: true } as any);
    } finally {
        console.error = originalError;
    }

    const failed = (sdk.chatManager as any).failedGroupE2EEDecrypts;
    assert.equal((message as any).e2eeDecryptFailed, true);
    assert.equal(failed.size, 1);
    assert.equal(failed.get("group-1:2").length, 1);
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
