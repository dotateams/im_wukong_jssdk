import * as assert from "assert";
import { SignalProtocolManager } from "../../src/signal/SignalProtocolManager";
import { GroupManager } from "../../src/signal/managers/GroupManager";
import { SenderKeyRecord } from "../../src/signal/models/SenderKeyRecord";
import { SenderKeyState } from "../../src/signal/models/SenderKeyState";
import { SenderKeyDistributionMessage } from "../../src/signal/models/SenderKeyDistributionMessage";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

test("signal protocol manager uses injected production device identity", () => {
    const manager = new SignalProtocolManager("alice", {}, {
        deviceId: "prod-web-device",
        deviceName: "Chrome Stable",
    });

    assert.equal(manager.deviceId, "prod-web-device");
    assert.equal(manager.deviceName, "Chrome Stable");
});

test("signal protocol manager clears stale sessions once per local device", async () => {
    const originalLocalStorage = (global as any).localStorage;
    const values = new Map<string, string>();
    (global as any).localStorage = {
        getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };

    let clearedSessions = 0;
    let clearedCache = 0;
    const manager: any = Object.create(SignalProtocolManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "web-1";
    manager.store = {
        clearSessions: async () => {
            clearedSessions++;
        },
    };
    manager.sessionManager = {
        clearSessionCache: () => {
            clearedCache++;
        },
    };

    try {
        await manager.applySessionCompatibilityMigration();
        await manager.applySessionCompatibilityMigration();
    } finally {
        (global as any).localStorage = originalLocalStorage;
    }

    assert.equal(clearedSessions, 1);
    assert.equal(clearedCache, 1);
});

test("signal protocol manager returns keyId fields for session bundle building", async () => {
    const manager: any = Object.create(SignalProtocolManager.prototype);
    manager.keyBundleDirectory = {
        getDeviceKeyBundle: async () => ({
            uid: "bob",
            deviceId: "bob-web",
            identityKey: "identity-key",
            registrationId: 11,
            signedPrekey: {
                keyId: 9,
                publicKey: "signed-public",
                signature: "signed-signature",
            },
            prekey: {
                keyId: 77,
                publicKey: "prekey-public",
            },
            protocolVersion: 1,
        }),
    };

    const bundle = await manager.getRemoteKeyBundle("bob", "bob-web");

    assert.equal(bundle.signedPrekey.keyId, 9);
    assert.equal(bundle.signedPrekey.keyID, undefined);
    assert.equal(bundle.prekey.keyId, 77);
    assert.equal(bundle.prekey.keyID, undefined);
});

test("group manager uploads sender-key envelopes for early messages without inline distribution", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    manager.senderKeyDistributionRetryWindow = 3;

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 0,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });

    let uploads = 0;
    manager.parent = {
        encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
            iv: `iv-${msgIndex}`,
            body: `body-${msgIndex}`,
            mac: `mac-${msgIndex}`,
            tag: `tag-${msgIndex}`,
            enc: "aes-256-gcm",
        }),
        signGroupPayload: async () => "signature",
        uploadGroupSenderKeyEnvelopes: async () => {
            uploads++;
        },
    };
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => record;
    manager.saveSenderKeyRecord = async () => undefined;
    manager.buildDistributionPayloadForRecord = async () => ({
        key_id: 9,
        distribution: { type: "signal_multi", ciphertexts: [{ uid: "bob", device_id: "bob-web", body: "key" }] },
        member_hash: "members-v2",
        kdf_ver: "v2",
    });

    const members = [{ uid: "alice" }, { uid: "bob", devices: ["bob-web"] }];
    const bodies: any[] = [];
    for (let i = 0; i < 4; i++) {
        const encrypted = await manager.encryptGroupMessage("group-1", `hello-${i}`, members, "members-v2");
        bodies.push(JSON.parse(encrypted.body));
    }

    assert.equal(bodies[0].msg_index, 0);
    assert.equal(bodies[0].distribution, undefined);
    assert.equal(bodies[1].msg_index, 1);
    assert.equal(bodies[1].distribution, undefined);
    assert.equal(bodies[2].msg_index, 2);
    assert.equal(bodies[2].distribution, undefined);
    assert.equal(bodies[3].msg_index, 3);
    assert.equal(bodies[3].distribution, undefined);
    assert.equal(uploads, 1);
});

test("group manager periodically uploads sender-key envelopes for unchanged members without inline distribution", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    manager.senderKeyDistributionRetryWindow = 3;
    manager.senderKeyDistributionInterval = 20;

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 19,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });

    let uploads = 0;
    manager.parent = {
        encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
            iv: `iv-${msgIndex}`,
            body: `body-${msgIndex}`,
            mac: `mac-${msgIndex}`,
            tag: `tag-${msgIndex}`,
            enc: "aes-256-gcm",
        }),
        signGroupPayload: async () => "signature",
        uploadGroupSenderKeyEnvelopes: async () => {
            uploads++;
        },
    };
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => record;
    manager.saveSenderKeyRecord = async () => undefined;
    manager.buildDistributionPayloadForRecord = async () => ({
        distribution: { type: "signal_multi", ciphertexts: [{ uid: "bob", device_id: "bob-web", body: "key" }] },
        member_hash: "members-v2",
        kdf_ver: "v2",
    });

    const members = [{ uid: "alice" }, { uid: "bob", devices: ["bob-web"] }];
    const periodic = JSON.parse((await manager.encryptGroupMessage("group-1", "hello-20", members, "members-v2")).body);
    const nonPeriodic = JSON.parse((await manager.encryptGroupMessage("group-1", "hello-21", members, "members-v2")).body);

    assert.equal(periodic.msg_index, 19);
    assert.equal(periodic.distribution, undefined);
    assert.equal(nonPeriodic.msg_index, 20);
    assert.equal(nonPeriodic.distribution, undefined);
    assert.equal(uploads, 1);
});

test("group manager uploads sender key envelopes without attaching inline distribution", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    manager.senderKeyDistributionRetryWindow = 3;
    manager.senderKeyDistributionInterval = 20;

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 0,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });

    let uploaded: any = null;
    manager.parent = {
        encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
            iv: `iv-${msgIndex}`,
            body: `body-${msgIndex}`,
            mac: `mac-${msgIndex}`,
            tag: `tag-${msgIndex}`,
            enc: "aes-256-gcm",
        }),
        signGroupPayload: async () => "signature",
        uploadGroupSenderKeyEnvelopes: async (payload: any) => {
            uploaded = payload;
        },
    };
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => record;
    manager.saveSenderKeyRecord = async () => undefined;
    manager.buildDistributionPayloadForRecord = async () => ({
        key_id: 9,
        distribution: { type: "signal_multi", ciphertexts: [{ uid: "bob", device_id: "bob-web", body: "key" }] },
        member_hash: "members-v2",
        kdf_ver: "v2",
    });

    const encrypted = await manager.encryptGroupMessage("group-1", "hello", [{ uid: "bob", devices: ["bob-web"] }], "members-v2");
    const body = JSON.parse(encrypted.body);

    assert.equal(body.distribution, undefined);
    assert.equal(body.member_hash, undefined);
    assert.ok(uploaded);
    assert.equal(uploaded.group_id, "group-1");
    assert.equal(uploaded.sender_uid, "alice");
    assert.equal(uploaded.sender_device_id, "alice-web");
    assert.equal(uploaded.key_id, 9);
    assert.deepEqual(uploaded.envelopes, [{
        recipient_uid: "bob",
        recipient_device_id: "bob-web",
        envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "key" }),
    }]);
});

test("group manager skips duplicate sender key envelope uploads for same key and member hash", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";

    let uploads = 0;
    manager.parent = {
        uploadGroupSenderKeyEnvelopes: async () => {
            uploads++;
        },
    };
    const distribution = {
        key_id: 9,
        member_hash: "members-v2",
        distribution: {
            type: "signal_multi",
            ciphertexts: [
                { uid: "bob", device_id: "bob-web", body: "key" },
                { uid: "carol", device_id: "carol-web", body: "key" },
            ],
        },
    };

    await manager.uploadDistributionEnvelopes("group-1", distribution);
    await manager.uploadDistributionEnvelopes("group-1", distribution);

    assert.equal(uploads, 1);
});

test("group manager retries sender key envelope upload after a failed cached attempt", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    const originalWarn = console.warn;
    console.warn = () => undefined;

    let uploads = 0;
    manager.parent = {
        uploadGroupSenderKeyEnvelopes: async () => {
            uploads++;
            if (uploads === 1) {
                throw new Error("temporary database overload");
            }
        },
    };
    const distribution = {
        key_id: 9,
        member_hash: "members-v2",
        distribution: {
            type: "signal_multi",
            ciphertexts: [
                { uid: "bob", device_id: "bob-web", body: "key" },
            ],
        },
    };

    try {
        await assert.rejects(() => manager.uploadDistributionEnvelopes("group-1", distribution), /temporary database overload/);
        await manager.uploadDistributionEnvelopes("group-1", distribution);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(uploads, 2);
});

test("group manager recovers missing sender key from server envelope and retries decrypt", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();

    const distributionPlain = new SenderKeyDistributionMessage({
        groupId: "group-1",
        senderUid: "alice",
        senderDeviceId: "alice-web",
        keyId: 9,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        memberHash: "members-v2",
        kdfVersion: "v2",
    }).toString();

    let saved: SenderKeyRecord | null = null;
    let lookups = 0;
    manager.loadSenderKeyRecord = async () => saved;
    manager.saveSenderKeyRecord = async (_groupId: string, _senderUid: string, record: SenderKeyRecord) => {
        saved = record;
    };
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async (req: any) => {
            lookups++;
            assert.equal(req.group_id, "group-1");
            assert.equal(req.sender_uid, "alice");
            assert.equal(req.sender_device_id, "alice-web");
            assert.equal(req.key_id, 9);
            assert.equal(req.recipient_uid, "bob");
            assert.equal(req.recipient_device_id, "bob-web");
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        verifyGroupSignature: async () => true,
        decryptGroupPayload: async () => JSON.stringify({ type: 1, content: "hello" }),
    };

    const plaintext = await manager.decryptGroupMessageObject({
        type: "signal_group",
        group_id: "group-1",
        sender_uid: "alice",
        sender_device_id: "alice-web",
        key_id: 9,
        msg_index: 0,
        iv: "iv",
        body: "body",
        mac: "mac",
        tag: "tag",
        enc: "aes-256-gcm",
        signature: "sig",
    }, "alice", "alice-web");

    assert.equal(plaintext, JSON.stringify({ type: 1, content: "hello" }));
    assert.equal(lookups, 1);
    assert.ok(saved);
});

test("group manager recovers sender key envelope when local record misses message key id", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();

    const distributionPlain = new SenderKeyDistributionMessage({
        groupId: "group-1",
        senderUid: "alice",
        senderDeviceId: "alice-web",
        keyId: 9,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub-9",
        memberHash: "members-v3",
        kdfVersion: "v2",
    }).toString();

    let saved: SenderKeyRecord | null = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 8,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub-8",
                signingPrivKey: "priv-8",
                messageIndex: 0,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });
    let lookups = 0;
    manager.loadSenderKeyRecord = async () => saved;
    manager.saveSenderKeyRecord = async (_groupId: string, _senderUid: string, record: SenderKeyRecord) => {
        saved = record;
    };
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            lookups++;
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        verifyGroupSignature: async () => true,
        decryptGroupPayload: async () => JSON.stringify({ type: 1, content: "new key message" }),
    };

    const plaintext = await manager.decryptGroupMessageObject({
        type: "signal_group",
        group_id: "group-1",
        sender_uid: "alice",
        sender_device_id: "alice-web",
        key_id: 9,
        msg_index: 0,
        iv: "iv",
        body: "body",
        mac: "mac",
        tag: "tag",
        enc: "aes-256-gcm",
        signature: "sig",
    }, "alice", "alice-web");

    assert.equal(plaintext, JSON.stringify({ type: 1, content: "new key message" }));
    assert.equal(lookups, 1);
    assert.ok(saved && saved.getStateByKeyId(9));
    assert.ok(saved && saved.getStateByKeyId(8));
});

test("group manager recovers sender key envelope when local state is past message index", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();

    const distributionPlain = new SenderKeyDistributionMessage({
        groupId: "group-1",
        senderUid: "alice",
        senderDeviceId: "alice-web",
        keyId: 9,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub-9",
        memberHash: "members-v3",
        kdfVersion: "v2",
    }).toString();

    let saved: SenderKeyRecord | null = new SenderKeyRecord({
        memberHash: "members-v3",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
                signingPubKey: "pub-9",
                signingPrivKey: "priv-9",
                messageIndex: 2,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });
    let lookups = 0;
    manager.loadSenderKeyRecord = async () => saved;
    manager.saveSenderKeyRecord = async (_groupId: string, _senderUid: string, record: SenderKeyRecord) => {
        saved = record;
    };
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            lookups++;
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        verifyGroupSignature: async () => true,
        decryptGroupPayload: async () => JSON.stringify({ type: 1, content: "old history message" }),
    };

    const plaintext = await manager.decryptGroupMessageObject({
        type: "signal_group",
        group_id: "group-1",
        sender_uid: "alice",
        sender_device_id: "alice-web",
        key_id: 9,
        msg_index: 0,
        iv: "iv",
        body: "body",
        mac: "mac",
        tag: "tag",
        enc: "aes-256-gcm",
        signature: "sig",
    }, "alice", "alice-web");

    assert.equal(plaintext, JSON.stringify({ type: 1, content: "old history message" }));
    assert.equal(lookups, 1);
    assert.ok(saved && saved.getStateByKeyId(9));
    assert.equal(saved && saved.getStateByKeyId(9)?.messageIndex, 1);
});

test("group manager retries transient sender key envelope lookup failure", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 2;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;

    const distributionPlain = new SenderKeyDistributionMessage({
        groupId: "group-1",
        senderUid: "alice",
        senderDeviceId: "alice-web",
        keyId: 9,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        memberHash: "members-v2",
        kdfVersion: "v2",
    }).toString();

    let saved: SenderKeyRecord | null = null;
    let attempts = 0;
    manager.loadSenderKeyRecord = async () => saved;
    manager.saveSenderKeyRecord = async (_groupId: string, _senderUid: string, record: SenderKeyRecord) => {
        saved = record;
    };
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            attempts++;
            if (attempts === 1) {
                throw new Error("network unavailable");
            }
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
    };

    const recovered = await manager.recoverSenderKeyFromEnvelope({
        group_id: "group-1",
        key_id: 9,
    }, "alice", "alice-web");

    assert.equal(recovered, true);
    assert.equal(attempts, 2);
    assert.ok(saved);
});

test("group manager member hash changes when e2ee member devices change", () => {
    const manager: any = Object.create(GroupManager.prototype);
    const baseHash = manager.normalizeMemberHash(undefined, [
        { uid: "alice", devices: [{ device_id: "alice-web" }] },
        { uid: "bob", devices: [{ device_id: "bob-web-1" }] },
    ]);
    const reloginHash = manager.normalizeMemberHash(undefined, [
        { uid: "alice", devices: [{ device_id: "alice-web" }] },
        { uid: "bob", devices: [{ device_id: "bob-web-2" }] },
    ]);

    assert.notEqual(baseHash, reloginHash);
});
