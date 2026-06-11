import * as assert from "assert";
import WKSDK from "../../src";
import { Channel, ChannelTypeGroup, ChannelTypePerson, MessageSignalContent, MessageText } from "../../src/model";
import { MessageContentType } from "../../src/const";
import { SignalE2EEAdapter } from "../../src/e2ee";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function resetSdk() {
    const sdk = WKSDK.shared();
    sdk.config.uid = "alice";
    sdk.config.e2ee.reset();
    return sdk;
}

test("signal adapter encrypts person messages for every active remote device", async () => {
    resetSdk();
    const calls: Array<{ uid: string; deviceId: string; plaintext: string }> = [];
    const adapter = new SignalE2EEAdapter({
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async (uid: string) => [
                { uid, device_id: "bob-web" },
                { uid, deviceId: "bob-phone" },
            ],
            encryptMessage: async (uid: string, deviceId: string, plaintext: string) => {
                calls.push({ uid, deviceId, plaintext });
                return { type: 3, body: `cipher:${deviceId}` };
            },
            decryptMessage: async () => {
                throw new Error("not used");
            },
        },
    });

    const encrypted = await adapter.encryptMessage(new MessageText("hello bob"), new Channel("bob", ChannelTypePerson));

    assert.ok(encrypted instanceof MessageSignalContent);
    assert.equal(encrypted.messageType, "signal_multi");
    assert.equal(encrypted.realContentType, MessageContentType.text);
    assert.equal(encrypted.senderDeviceId, "alice-web");
    assert.deepEqual(calls.map((call) => call.deviceId), ["bob-web", "bob-phone"]);
    assert.ok(calls[0].plaintext.includes("hello bob"));
    assert.ok(!encrypted.ciphertext.includes("hello bob"));
});

test("signal adapter encrypts person messages for sender companion devices", async () => {
    resetSdk();
    const calls: Array<{ uid: string; deviceId: string }> = [];
    const adapter = new SignalE2EEAdapter({
        localUid: "alice",
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async (uid: string) => {
                if (uid === "bob") {
                    return [{ uid, device_id: "bob-web" }];
                }
                if (uid === "alice") {
                    return [
                        { uid, device_id: "alice-web" },
                        { uid, device_id: "alice-phone" },
                    ];
                }
                return [];
            },
            encryptMessage: async (uid: string, deviceId: string) => {
                calls.push({ uid, deviceId });
                return { type: 3, body: `cipher:${uid}:${deviceId}` };
            },
            decryptMessage: async () => {
                throw new Error("not used");
            },
        },
    });

    await adapter.encryptMessage(new MessageText("hello bob"), new Channel("bob", ChannelTypePerson));

    assert.deepEqual(calls, [
        { uid: "bob", deviceId: "bob-web" },
        { uid: "alice", deviceId: "alice-web" },
        { uid: "alice", deviceId: "alice-phone" },
    ]);
});

test("signal adapter encrypts group messages as signal_group content", async () => {
    resetSdk();
    const adapter = new SignalE2EEAdapter({
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async () => [],
            encryptMessage: async () => {
                throw new Error("not used");
            },
            decryptMessage: async () => {
                throw new Error("not used");
            },
            encryptGroupMessage: async (groupId: string, plaintext: string) => ({
                type: "signal_group",
                group_id: groupId,
                body: `group-cipher:${plaintext.length}`,
            }),
        },
    });

    const encrypted = await adapter.encryptMessage(new MessageText("hello group"), new Channel("group-1", ChannelTypeGroup));

    assert.ok(encrypted instanceof MessageSignalContent);
    assert.equal(encrypted.messageType, "signal_group");
    assert.equal(encrypted.realContentType, MessageContentType.text);
    assert.ok(encrypted.ciphertext.includes("group-1"));
    assert.ok(!encrypted.ciphertext.includes("hello group"));
});

test("signal adapter unwraps real group encrypt result body", async () => {
    resetSdk();
    const adapter = new SignalE2EEAdapter({
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async () => [],
            encryptMessage: async () => {
                throw new Error("not used");
            },
            decryptMessage: async () => {
                throw new Error("not used");
            },
            encryptGroupMessage: async (groupId: string) => ({
                type: 0,
                body: JSON.stringify({
                    type: "signal_group",
                    group_id: groupId,
                    body: "cipher-body",
                }),
            }),
        },
    });

    const encrypted = await adapter.encryptMessage(
        new MessageText("hello group"),
        new Channel("group-real", ChannelTypeGroup),
    ) as MessageSignalContent;
    const payload = JSON.parse(encrypted.ciphertext);

    assert.equal(encrypted.messageType, "signal_group");
    assert.equal(payload.type, "signal_group");
    assert.equal(payload.group_id, "group-real");
    assert.equal(payload.body, "cipher-body");
});

test("signal adapter decrypts signal content back to original message content", async () => {
    resetSdk();
    const signal = new MessageSignalContent();
    signal.messageType = "signal_multi";
    signal.realContentType = MessageContentType.text;
    signal.senderDeviceId = "bob-web";
    signal.ciphertext = JSON.stringify({
        type: "signal_multi",
        ciphertexts: [{ device_id: "alice-web", type: 3, body: "cipher" }],
    });

    const adapter = new SignalE2EEAdapter({
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async () => [],
            encryptMessage: async () => {
                throw new Error("not used");
            },
            decryptMessage: async (uid: string, deviceId: string, messageType: any, ciphertext: any) => {
                assert.equal(uid, "bob");
                assert.equal(deviceId, "bob-web");
                assert.equal(messageType, "signal_multi");
                assert.equal(ciphertext, signal.ciphertext);
                return JSON.stringify({ type: MessageContentType.text, content: "opened" });
            },
        },
    });

    const decrypted = await adapter.decryptMessage(signal, new Channel("bob", ChannelTypePerson));

    assert.ok(decrypted instanceof MessageText);
    assert.equal((decrypted as MessageText).text, "opened");
});

test("signal adapter decrypts signal-like content from another package instance", async () => {
    resetSdk();
    const signal = {
        contentType: MessageContentType.signalMessage,
        messageType: "signal_multi",
        realContentType: MessageContentType.text,
        senderDeviceId: "bob-web",
        ciphertext: JSON.stringify({
            type: "signal_multi",
            ciphertexts: [{ device_id: "alice-web", type: 3, body: "cipher" }],
        }),
    } as any;

    const adapter = new SignalE2EEAdapter({
        localDeviceId: "alice-web",
        signalManager: {
            deviceId: "alice-web",
            getRemoteDevices: async () => [],
            encryptMessage: async () => {
                throw new Error("not used");
            },
            decryptMessage: async (uid: string, deviceId: string, messageType: any, ciphertext: any) => {
                assert.equal(uid, "bob");
                assert.equal(deviceId, "bob-web");
                assert.equal(messageType, "signal_multi");
                assert.equal(ciphertext, signal.ciphertext);
                return JSON.stringify({ type: MessageContentType.text, content: "opened foreign" });
            },
        },
    });

    const decrypted = await adapter.decryptMessage(signal, new Channel("bob", ChannelTypePerson));

    assert.ok(decrypted instanceof MessageText);
    assert.equal((decrypted as MessageText).text, "opened foreign");
});

test("signal adapter decrypts person messages with sender uid from context", async () => {
    resetSdk();
    const signal = new MessageSignalContent();
    signal.messageType = "signal_multi";
    signal.realContentType = MessageContentType.text;
    signal.senderDeviceId = "alice-web";
    signal.ciphertext = JSON.stringify({
        type: "signal_multi",
        ciphertexts: [{ device_id: "alice-phone", type: 3, body: "cipher" }],
    });

    const adapter = new SignalE2EEAdapter({
        localUid: "alice",
        localDeviceId: "alice-phone",
        signalManager: {
            deviceId: "alice-phone",
            getRemoteDevices: async () => [],
            encryptMessage: async () => {
                throw new Error("not used");
            },
            decryptMessage: async (uid: string, deviceId: string) => {
                assert.equal(uid, "alice");
                assert.equal(deviceId, "alice-web");
                return JSON.stringify({ type: MessageContentType.text, content: "synced" });
            },
        },
    });

    const decrypted = await adapter.decryptMessage(
        signal,
        new Channel("bob", ChannelTypePerson),
        { fromUID: "alice", senderDeviceId: "alice-web" },
    );

    assert.ok(decrypted instanceof MessageText);
    assert.equal((decrypted as MessageText).text, "synced");
});
