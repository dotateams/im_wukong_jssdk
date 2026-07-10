import * as assert from "assert";
import { SignalProtocolManager } from "../../src/signal/SignalProtocolManager";
import { GroupManager } from "../../src/signal/managers/GroupManager";
import { GroupCipher } from "../../src/signal/ciphers/GroupCipher";
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

test("signal protocol manager encrypts group distribution from provided device bundles without fetching user keys", async () => {
    const manager: any = new SignalProtocolManager("alice", {
        get: async (path: string) => {
            throw new Error(`unexpected key bundle fetch: ${path}`);
        },
    }, {
        deviceId: "alice-web",
    });
    manager.ensureWebCrypto = () => undefined;
    manager.getSubtleCrypto = () => ({
        importKey: async () => ({}),
        encrypt: async () => {
            const bytes = new Uint8Array(20);
            bytes.set([1, 2, 3, 4]);
            return bytes.buffer;
        },
    });
    manager.getCurve = async () => ({
        generateKeyPair: () => ({ pubKey: new Uint8Array([1, 2, 3]), privKey: new Uint8Array([4, 5, 6]) }),
        calculateAgreement: () => new Uint8Array([7, 8, 9]),
    });
    manager.hkdfSha256Bytes = () => new Uint8Array(32);
    manager.randomBytes = () => new Uint8Array(12);
    manager.stringToArrayBuffer = (value: string) => new TextEncoder().encode(value).buffer;

    const ciphertexts = await manager.encryptGroupDistributionForDevice("bob", "distribution", [{
        uid: "bob",
        device_id: "bob-web",
        identity_key: "AQIDBA==",
    }]);

    assert.equal(ciphertexts.length, 1);
    assert.equal(ciphertexts[0].uid, "bob");
    assert.equal(ciphertexts[0].device_id, "bob-web");
});

test("signal protocol manager encrypts large group distribution from provided bundles without key fetch fanout", async () => {
    let keyFetches = 0;
    const manager: any = new SignalProtocolManager("alice", {
        get: async (path: string) => {
            keyFetches++;
            throw new Error(`unexpected key bundle fetch: ${path}`);
        },
    }, {
        deviceId: "alice-web",
    });
    manager.ensureWebCrypto = () => undefined;
    manager.getSubtleCrypto = () => ({
        importKey: async () => ({}),
        encrypt: async () => {
            const bytes = new Uint8Array(20);
            bytes.set([1, 2, 3, 4]);
            return bytes.buffer;
        },
    });
    manager.getCurve = async () => ({
        generateKeyPair: () => ({ pubKey: new Uint8Array([1, 2, 3]), privKey: new Uint8Array([4, 5, 6]) }),
        calculateAgreement: () => new Uint8Array([7, 8, 9]),
    });
    manager.hkdfSha256Bytes = () => new Uint8Array(32);
    manager.randomBytes = () => new Uint8Array(12);
    manager.stringToArrayBuffer = (value: string) => new TextEncoder().encode(value).buffer;

    const devices = Array.from({ length: 1200 }, (_item, index) => ({
        uid: "bob",
        device_id: `bob-web-${index}`,
        identity_key: "AQIDBA==",
    }));
    const started = Date.now();

    const ciphertexts = await manager.encryptGroupDistributionForDevice("bob", "distribution", devices);

    assert.equal(keyFetches, 0);
    assert.equal(ciphertexts.length, 1200);
    assert.equal(ciphertexts[1199].device_id, "bob-web-1199");
    assert.ok(Date.now() - started < 2000, "large provided-bundle distribution path should stay local and fast");
});

test("signal protocol manager force refreshes key bundles when provided devices are incomplete", async () => {
    let forceRefreshArg: boolean | undefined;
    const manager: any = Object.create(SignalProtocolManager.prototype);
    manager.keyBundleDirectory = {
        normalize: () => null,
        getUserKeyBundles: async (_uid: string, forceRefresh?: boolean) => {
            forceRefreshArg = forceRefresh;
            return [{
                uid: "bob",
                deviceId: "bob-web",
                identityKey: "AQIDBA==",
            }];
        },
    };
    manager.ensureWebCrypto = () => undefined;
    manager.getSubtleCrypto = () => ({
        importKey: async () => ({}),
        encrypt: async () => {
            const bytes = new Uint8Array(20);
            bytes.set([1, 2, 3, 4]);
            return bytes.buffer;
        },
    });
    manager.getCurve = async () => ({
        generateKeyPair: () => ({ pubKey: new Uint8Array([1, 2, 3]), privKey: new Uint8Array([4, 5, 6]) }),
        calculateAgreement: () => new Uint8Array([7, 8, 9]),
    });
    manager.fromBase64 = (value: string) => Buffer.from(value, "base64");
    manager.toBase64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
    manager.hkdfSha256Bytes = () => new Uint8Array(32);
    manager.randomBytes = () => new Uint8Array(12);
    manager.stringToArrayBuffer = (value: string) => new TextEncoder().encode(value).buffer;

    const ciphertexts = await manager.encryptGroupDistributionForDevice("bob", "distribution", [{
        device_id: "bob-web",
    }]);

    assert.equal(forceRefreshArg, true);
    assert.equal(ciphertexts.length, 1);
    assert.equal(ciphertexts[0].device_id, "bob-web");
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
    assert.equal(uploaded.version, 2);
    assert.equal(uploaded.envelopes, undefined);
    assert.deepEqual(uploaded.items, [[
        "bob",
        "bob-web",
        JSON.stringify({ uid: "bob", device_id: "bob-web", body: "key" }),
    ]]);
});

test("group manager includes sender own devices in sender-key envelopes for history recovery", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 10,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });
    const encryptedFor: string[] = [];
    manager.parent = {
        encryptGroupDistributionForDevice: async (uid: string, _plain: string, devices: any[]) => {
            return devices.map((device) => {
                const deviceId = device.device_id || device.deviceId || device.id || device;
                encryptedFor.push(`${uid}:${deviceId}`);
                return {
                    enc: "aes-256-gcm",
                    uid,
                    device_id: deviceId,
                    body: `key:${uid}:${deviceId}`,
                };
            });
        },
    };

    const distribution = await manager.buildDistributionPayloadForRecord("group-1", record, [
        { uid: "alice", devices: [{ device_id: "alice-web" }, { device_id: "alice-phone" }] },
        { uid: "bob", devices: [{ device_id: "bob-web" }] },
    ], "members-v2");

    assert.deepEqual(encryptedFor.sort(), ["alice:alice-phone", "alice:alice-web", "bob:bob-web"]);
    assert.deepEqual(
        distribution.distribution.ciphertexts.map((item: any) => `${item.uid}:${item.device_id}`).sort(),
        ["alice:alice-phone", "alice:alice-web", "bob:bob-web"],
    );
});

test("group manager builds sender-key envelopes with bounded concurrency", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.senderKeyEnvelopeConcurrency = 3;

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 10,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });

    let active = 0;
    let maxActive = 0;
    manager.parent = {
        encryptGroupDistributionForDevice: async (uid: string, _plain: string, devices: any[]) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return devices.map((device) => ({
                enc: "aes-256-gcm",
                uid,
                device_id: device.device_id,
                body: `key:${uid}:${device.device_id}`,
            }));
        },
    };

    const members = Array.from({ length: 12 }).map((_, i) => ({
        uid: `user-${i}`,
        devices: [{ device_id: `device-${i}` }],
    }));

    const distribution = await manager.buildDistributionPayloadForRecord("group-1", record, members, "members-v2");

    assert.equal(distribution.distribution.ciphertexts.length, 12);
    assert.equal(maxActive, 3);
});

test("group manager prepareGroupSend uploads envelopes without advancing sender chain", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    manager.senderKeyEnvelopeConcurrency = 3;

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
    let uploaded = 0;
    let saved = 0;

    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => null;
    manager.createSenderKeyRecord = async () => record;
    manager.buildDistributionPayloadForRecord = async () => ({
        key_id: 9,
        member_hash: "members-v2",
        distribution: {
            ciphertexts: [
                { uid: "bob", device_id: "bob-web", enc: "aes-256-gcm", body: "key" },
            ],
        },
    });
    manager.uploadDistributionEnvelopes = async () => {
        uploaded += 1;
    };
    manager.saveSenderKeyRecord = async () => {
        saved += 1;
    };

    await manager.prepareGroupSend("group-1", [{ uid: "bob", devices: [{ device_id: "bob-web" }] }], "members-v2");

    assert.equal(uploaded, 1);
    assert.equal(saved, 1);
    assert.equal(record.getState().messageIndex, 0);
});

test("group manager requests targeted sender key repair when envelope recovery fails", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();
    let repairPayload: any = null;

    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            throw new Error("not found");
        },
        requestGroupSenderKeyRepair: async (payload: any) => {
            repairPayload = payload;
        },
    };

    const recovered = await manager.recoverSenderKeyFromEnvelope(
        { group_id: "group-1", key_id: 9 },
        "alice",
        "alice-web",
    );

    assert.equal(recovered, false);
    assert.deepEqual(repairPayload, {
        group_id: "group-1",
        sender_uid: "alice",
        sender_device_id: "alice-web",
        key_id: 9,
        recipient_uid: "bob",
        recipient_device_id: "bob-web",
        reason: "missing_sender_key",
    });
});

test("group manager requests targeted sender key repair when envelope lookup returns empty", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();
    let repairPayload: any = null;

    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => ({}),
        requestGroupSenderKeyRepair: async (payload: any) => {
            repairPayload = payload;
        },
    };

    const recovered = await manager.recoverSenderKeyFromEnvelope(
        { group_id: "group-1", key_id: 9 },
        "alice",
        "alice-web",
    );

    assert.equal(recovered, false);
    assert.deepEqual(repairPayload, {
        group_id: "group-1",
        sender_uid: "alice",
        sender_device_id: "alice-web",
        key_id: 9,
        recipient_uid: "bob",
        recipient_device_id: "bob-web",
        reason: "missing_sender_key",
    });
});

test("group manager batches targeted sender key repair requests when batch api is available", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-web";
    manager.groupEnvelopeRecoveryPromises = new Map();
    const batchPayloads: any[] = [];
    let fallbackCalls = 0;

    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => ({}),
        requestGroupSenderKeyRepairBatch: async (payload: any) => {
            batchPayloads.push(payload);
        },
        requestGroupSenderKeyRepair: async () => {
            fallbackCalls += 1;
        },
    };

    const results = await Promise.all([
        manager.recoverSenderKeyFromEnvelope({ group_id: "group-1", key_id: 9 }, "alice", "alice-web"),
        manager.recoverSenderKeyFromEnvelope({ group_id: "group-1", key_id: 10 }, "alice", "alice-web"),
    ]);

    assert.deepEqual(results, [false, false]);
    assert.equal(fallbackCalls, 0);
    assert.equal(batchPayloads.length, 1);
    assert.deepEqual(batchPayloads[0], {
        requests: [
            {
                group_id: "group-1",
                sender_uid: "alice",
                sender_device_id: "alice-web",
                key_id: 9,
                recipient_uid: "bob",
                recipient_device_id: "bob-web",
                reason: "missing_sender_key",
            },
            {
                group_id: "group-1",
                sender_uid: "alice",
                sender_device_id: "alice-web",
                key_id: 10,
                recipient_uid: "bob",
                recipient_device_id: "bob-web",
                reason: "missing_sender_key",
            },
        ],
    });
});

test("group manager prepareGroupSend uploads sender key only to pending repair devices", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 8,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });
    let builtMembers: any[] = [];
    let uploaded = 0;

    manager.parent = {
        lookupGroupSenderKeyRepairRequests: async () => ({
            requests: [
                { recipient_uid: "bob", recipient_device_id: "bob-web" },
                { recipient_uid: "bob", recipient_device_id: "bob-phone" },
            ],
        }),
    };
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => record;
    manager.buildDistributionPayloadForRecord = async (_groupId: string, _record: any, members: any[]) => {
        builtMembers = members;
        return {
            key_id: 9,
            member_hash: "members-v2",
            distribution: {
                ciphertexts: members.flatMap((member: any) =>
                    member.devices.map((device: any) => ({
                        uid: member.uid,
                        device_id: device.device_id,
                        enc: "aes-256-gcm",
                        body: "key",
                    })),
                ),
            },
        };
    };
    manager.uploadDistributionEnvelopes = async () => {
        uploaded += 1;
    };
    manager.logPerf = () => undefined;

    await manager.prepareGroupSend("group-1", [
        { uid: "bob", devices: [{ device_id: "bob-web" }, { device_id: "bob-phone" }] },
        { uid: "carol", devices: [{ device_id: "carol-web" }] },
    ], "members-v2");

    assert.deepEqual(builtMembers, [{ uid: "bob", devices: [{ device_id: "bob-web" }, { device_id: "bob-phone" }] }]);
    assert.equal(uploaded, 1);
    assert.equal(record.getState().messageIndex, 8);
});

test("group manager pending repair lookup uses bounded page and drains has_more in background", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";

    const cached = new Set<string>();
    manager.senderKeyRepairRequestCache = {
        has: (key: string) => cached.has(key),
        set: (key: string) => cached.add(key),
        keys: () => Array.from(cached.keys()),
        delete: (key: string) => cached.delete(key),
    };

    const requestedLimits: number[] = [];
    let lookups = 0;
    let uploads = 0;
    manager.parent = {
        lookupGroupSenderKeyRepairRequests: async (payload: any) => {
            requestedLimits.push(payload.limit);
            lookups++;
            if (lookups === 1) {
                return {
                    has_more: true,
                    requests: [{ recipient_uid: "bob", recipient_device_id: "bob-web-1" }],
                };
            }
            return {
                has_more: false,
                requests: [{ recipient_uid: "bob", recipient_device_id: "bob-web-2" }],
            };
        },
    };
    manager.buildDistributionPayloadForRecord = async (_groupId: string, _record: any, members: any[]) => ({
        key_id: 7,
        member_hash: "members-v1",
        distribution: {
            type: "signal_multi",
            ciphertexts: members.flatMap((member: any) =>
                member.devices.map((device: any) => ({ uid: member.uid, device_id: device.device_id, body: "sender-key" })),
            ),
        },
    });
    manager.uploadDistributionEnvelopes = async () => {
        uploads++;
    };
    const record = {
        memberHash: "members-v1",
        getState: () => ({ keyId: 7 }),
    };

    const repaired = await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(repaired, 1);
    assert.deepEqual(requestedLimits, [500, 500]);
    assert.equal(lookups, 2);
    assert.equal(uploads, 2);
});

test("group manager throttles empty pending repair lookups until cache invalidation", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";

    let lookups = 0;
    manager.parent = {
        lookupGroupSenderKeyRepairRequests: async () => {
            lookups++;
            return { has_more: false, requests: [] };
        },
    };
    manager.buildDistributionPayloadForRecord = async () => {
        throw new Error("empty repair lookup should not build distribution");
    };
    manager.uploadDistributionEnvelopes = async () => {
        throw new Error("empty repair lookup should not upload distribution");
    };
    const record = {
        memberHash: "members-v1",
        getState: () => ({ keyId: 7 }),
    };

    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");
    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");
    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");

    assert.equal(lookups, 1);

    manager.invalidateGroupRepairRequestCache("group-1");
    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");

    assert.equal(lookups, 2);
});

test("group manager encryptGroupMessage uploads pending repair envelopes before sending cached key", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();

    const record = new SenderKeyRecord({
        memberHash: "members-v2",
        states: [
            new SenderKeyState({
                keyId: 9,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                messageIndex: 8,
                skipped: {},
                kdfVersion: "v2",
            }),
        ],
    });
    let builtMembers: any[] = [];
    let uploaded = 0;
    let encrypted = 0;

    manager.parent = {
        lookupGroupSenderKeyRepairRequests: async () => ({
            requests: [
                { recipient_uid: "bob", recipient_device_id: "bob-web" },
            ],
        }),
    };
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => record;
    manager.saveSenderKeyRecord = async () => undefined;
    manager.shouldReuploadAfterIdentityRepair = () => false;
    manager.shouldRetrySenderKeyDistribution = () => false;
    manager.buildDistributionPayloadForRecord = async (_groupId: string, _record: any, members: any[]) => {
        builtMembers = members;
        return {
            key_id: 9,
            member_hash: "members-v2",
            distribution: {
                ciphertexts: members.flatMap((member: any) =>
                    member.devices.map((device: any) => ({
                        uid: member.uid,
                        device_id: device.device_id,
                        enc: "aes-256-gcm",
                        body: "key",
                    })),
                ),
            },
        };
    };
    manager.uploadDistributionEnvelopes = async () => {
        uploaded += 1;
    };
    manager.logPerf = () => undefined;

    const originalEncrypt = GroupCipher.prototype.encrypt;
    GroupCipher.prototype.encrypt = async function () {
        encrypted += 1;
        return {
            payload: {
                group_id: "group-1",
                sender_uid: "alice",
                key_id: 9,
                msg_index: 9,
                ciphertext: "cipher",
            },
        };
    };
    try {
        const result = await manager.encryptGroupMessage("group-1", "hello", [
            { uid: "bob", devices: [{ device_id: "bob-web" }] },
            { uid: "carol", devices: [{ device_id: "carol-web" }] },
        ], "members-v2");

        assert.deepEqual(builtMembers, [{ uid: "bob", devices: [{ device_id: "bob-web" }] }]);
        assert.equal(uploaded, 1);
        assert.equal(encrypted, 1);
        assert.equal(result.type, 0);
        assert.equal(JSON.parse(result.body).sender_device_id, "alice-web");
    } finally {
        GroupCipher.prototype.encrypt = originalEncrypt;
    }
});

test("group manager prepareGroupSend waits for active group encryption lock", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    let releaseLock: any;
    manager.groupEncryptionLocks.set("group-1", new Promise((resolve) => {
        releaseLock = resolve;
    }));

    let started = false;
    manager.normalizeMemberHash = () => "members-v2";
    manager.loadSenderKeyRecord = async () => {
        started = true;
        return { memberHash: "members-v2" };
    };
    manager.logPerf = () => undefined;

    const pending = manager.prepareGroupSend("group-1", [{ uid: "bob" }], "members-v2");
    await Promise.resolve();
    assert.equal(started, false);

    releaseLock();
    await pending;
    assert.equal(started, true);
});

test("sender key state rederives old message key when skipped cache was trimmed", () => {
    const rootKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const fresh = new SenderKeyState({
        keyId: 9,
        senderKey: rootKey,
        chainKey: rootKey,
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
    });
    const expected = fresh.getMessageKeyForIndex(3).messageKey;
    const advanced = new SenderKeyState({
        keyId: 9,
        senderKey: rootKey,
        chainKey: rootKey,
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
    });
    advanced.getMessageKeyForIndex(80);
    advanced.skipped = {};

    assert.equal(advanced.getMessageKeyForIndex(3).messageKey, expected);
    assert.equal(advanced.messageIndex, 81);
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

test("group manager reuploads existing sender-key envelopes after local identity repair", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";
    manager.groupEncryptionLocks = new Map();
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeUploadPromises = new Map();
    manager.senderKeyDistributionInterval = 0;
    manager.senderKeyDistributionRetryWindow = 0;
    manager.identityRepairGeneration = 0;
    manager.identityRepairDistributionGroups = new Set();
    manager.senderKeyCache = { clear: () => undefined, get: () => undefined, set: () => undefined };
    manager.senderKeyStateCache = { clear: () => undefined };
    manager.senderKeyEnvelopeMissingCache = { clear: () => undefined };
    manager.senderKeyRepairRequestCache = { clear: () => undefined, has: () => true, set: () => undefined };
    manager.senderKeyEnvelopeUploadCache = { clear: () => undefined, has: () => false, set: () => undefined };

    const record = new SenderKeyRecord({
        memberHash: "members-v1",
        states: [
            new SenderKeyState({
                keyId: 7,
                senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                signingPubKey: "pub",
                signingPrivKey: "priv",
                kdfVersion: "v2",
            }),
        ],
    });

    let uploads = 0;
    manager.loadSenderKeyRecord = async () => record;
    manager.saveSenderKeyRecord = async () => undefined;
    manager.buildDistributionPayloadForRecord = async () => ({
        key_id: 7,
        member_hash: "members-v1",
        distribution: {
            ciphertexts: [
                { uid: "bob", device_id: "bob-web", enc: "aes-256-gcm", body: "cipher" },
            ],
        },
    });
    manager.uploadDistributionEnvelopes = async () => {
        uploads++;
    };
    manager.uploadPendingRepairEnvelopes = async () => 0;

    await manager.prepareGroupSend("group-1", [{ uid: "bob", devices: [{ device_id: "bob-web" }] }], "members-v1");
    assert.equal(uploads, 0, "unchanged group should not upload before identity repair");

    manager.markLocalIdentityRepaired();
    await manager.prepareGroupSend("group-1", [{ uid: "bob", devices: [{ device_id: "bob-web" }] }], "members-v1");
    assert.equal(uploads, 1, "identity repair should force one sender-key envelope reupload for the group");

    await manager.prepareGroupSend("group-1", [{ uid: "bob", devices: [{ device_id: "bob-web" }] }], "members-v1");
    assert.equal(uploads, 1, "same repair generation should not reupload repeatedly for the same group");
});

test("group manager starts first-login grace and clears recovery caches without interrupting in-flight recovery", () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.identityRepairGeneration = 0;
    manager.identityRepairDistributionGroups = new Set(["old"]);
    manager.firstLoginEnvelopeGraceMs = 30000;
    manager.firstLoginGraceUntil = 0;
    const inFlight = Promise.resolve(true);
    manager.groupEnvelopeRecoveryPromises = new Map([["group-1:alice:alice-web:9:bob:bob-web", inFlight]]);
    let uploadCacheCleared = false;
    let missingCacheCleared = false;
    let forceLookupCleared = false;
    let repairRequestCleared = false;
    let stateCacheCleared = false;
    manager.senderKeyEnvelopeUploadCache = { clear: () => { uploadCacheCleared = true; } };
    manager.senderKeyEnvelopeUploadPromises = { clear: () => undefined };
    manager.senderKeyEnvelopeMissingCache = { clear: () => { missingCacheCleared = true; } };
    manager.senderKeyEnvelopeForceLookupCache = { clear: () => { forceLookupCleared = true; } };
    manager.senderKeyRepairRequestCache = { clear: () => { repairRequestCleared = true; } };
    manager.senderKeyStateCache = { clear: () => { stateCacheCleared = true; } };

    const before = Date.now();
    manager.markFirstLoginKeyRegistrationComplete();

    assert.equal(manager.identityRepairGeneration, 1);
    assert.equal(manager.identityRepairDistributionGroups.size, 0);
    assert.ok(manager.firstLoginGraceUntil >= before + 29000);
    assert.equal(manager.groupEnvelopeRecoveryPromises.get("group-1:alice:alice-web:9:bob:bob-web"), inFlight);
    assert.equal(uploadCacheCleared, true);
    assert.equal(missingCacheCleared, true);
    assert.equal(forceLookupCleared, true);
    assert.equal(repairRequestCleared, true);
    assert.equal(stateCacheCleared, true);
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

test("group manager retries sender key repair after empty lookup cache is invalidated", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "alice";
    manager.deviceId = "alice-web";

    const cached = new Set<string>();
    manager.senderKeyRepairRequestCache = {
        has: (key: string) => cached.has(key),
        set: (key: string) => cached.add(key),
        keys: () => Array.from(cached.keys()),
        delete: (key: string) => cached.delete(key),
    };

    let lookups = 0;
    let uploads = 0;
    manager.parent = {
        lookupGroupSenderKeyRepairRequests: async () => {
            lookups++;
            if (lookups === 1) {
                return { requests: [] };
            }
            return { requests: [{ recipient_uid: "bob", recipient_device_id: "bob-web" }] };
        },
    };
    manager.buildDistributionPayloadForRecord = async (_groupId: string, _record: any, members: any[]) => {
        assert.deepEqual(members, [{ uid: "bob", devices: [{ device_id: "bob-web" }] }]);
        return {
            key_id: 7,
            member_hash: "members-v1",
            distribution: {
                type: "signal_multi",
                ciphertexts: [{ uid: "bob", device_id: "bob-web", body: "sender-key" }],
            },
        };
    };
    manager.uploadDistributionEnvelopes = async () => {
        uploads++;
    };
    const record = {
        memberHash: "members-v1",
        getState: () => ({ keyId: 7 }),
    };

    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");
    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");
    manager.invalidateGroupRepairRequestCache("group-1");
    await manager.uploadPendingRepairEnvelopes("group-1", record, "members-v1");

    assert.equal(lookups, 2);
    assert.equal(uploads, 1);
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

test("group manager falls back to server envelope when inline distribution was encrypted for stale identity", async () => {
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
    let distributionDecrypts = 0;
    manager.loadSenderKeyRecord = async () => saved;
    manager.saveSenderKeyRecord = async (_groupId: string, _senderUid: string, record: SenderKeyRecord) => {
        saved = record;
    };
    manager.parent = {
        selectCiphertextForDevice: () => ({ uid: "bob", device_id: "bob-web", is_ecies: true, body: "stale-inline" }),
        lookupGroupSenderKeyEnvelope: async () => {
            lookups++;
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-web", body: "fresh-server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async (envelope: any) => {
            distributionDecrypts++;
            if (envelope.body === "stale-inline") {
                throw new DOMException("operation failed", "OperationError");
            }
            return distributionPlain;
        },
        verifyGroupSignature: async () => true,
        decryptGroupPayload: async () => JSON.stringify({ type: 1, content: "hello after repair" }),
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
        distribution: {
            type: "signal_multi",
            ciphertexts: [{ uid: "bob", device_id: "bob-web", body: "stale-inline", is_ecies: true }],
        },
    }, "alice", "alice-web");

    assert.equal(plaintext, JSON.stringify({ type: 1, content: "hello after repair" }));
    assert.equal(lookups, 1);
    assert.equal(distributionDecrypts, 2);
    assert.ok(saved && saved.getStateByKeyId(9));
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

test("group manager rederives old sender key locally when local state is past message index", async () => {
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
    assert.equal(lookups, 0);
    assert.ok(saved && saved.getStateByKeyId(9));
    assert.equal(saved && saved.getStateByKeyId(9)?.messageIndex, 2);
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

test("group manager suppresses repeated permanent missing sender key envelope lookups", async () => {
    const originalWarn = console.warn;
    let warnings = 0;
    console.warn = () => {
        warnings++;
    };
    const manager: any = Object.create(GroupManager.prototype);
    try {
        manager.uid = "bob";
        manager.deviceId = "bob-h5";
        manager.groupEnvelopeRecoveryPromises = new Map();
        manager.senderKeyEnvelopeRecoveryMaxAttempts = 3;
        manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;

        let attempts = 0;
        manager.parent = {
            lookupGroupSenderKeyEnvelope: async () => {
                attempts++;
                const error: any = new Error("not found");
                error.status = 404;
                throw error;
            },
        };

        const first = await manager.recoverSenderKeyFromEnvelope({
            group_id: "group-1",
            key_id: 9,
        }, "alice", "alice-web");
        const second = await manager.recoverSenderKeyFromEnvelope({
            group_id: "group-1",
            key_id: 9,
        }, "alice", "alice-web");

        assert.equal(first, false);
        assert.equal(second, false);
        assert.equal(attempts, 1);
        assert.equal(warnings, 0);
    } finally {
        console.warn = originalWarn;
    }
});

test("group manager treats first-login 404 sender key envelope as retryable", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 3;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;
    manager.firstLoginGraceUntil = Date.now() + 30000;

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
            if (attempts < 3) {
                const error: any = new Error("envelope not ready");
                error.status = 404;
                throw error;
            }
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-h5", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const recovered = await manager.recoverSenderKeyFromEnvelope({
        group_id: "group-1",
        key_id: 9,
    }, "alice", "alice-web");

    assert.equal(recovered, true);
    assert.equal(attempts, 3);
    assert.ok(saved && saved.getStateByKeyId(9));
});

test("group manager does not poison first-login 404 sender key envelope miss", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 1;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;
    manager.firstLoginGraceUntil = Date.now() + 30000;

    let attempts = 0;
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            attempts++;
            const error: any = new Error("envelope not ready");
            error.status = 404;
            throw error;
        },
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const payload = {
        group_id: "group-1",
        key_id: 9,
    };
    const first = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web");
    const second = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web");

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(attempts, 2);
});

test("group manager still poisons 403 sender key envelope lookup inside first-login grace", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 3;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;
    manager.firstLoginGraceUntil = Date.now() + 30000;

    let attempts = 0;
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            attempts++;
            const error: any = new Error("forbidden");
            error.status = 403;
            throw error;
        },
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const payload = {
        group_id: "group-1",
        key_id: 9,
    };
    const first = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web");
    const second = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web");

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(attempts, 1);
});

test("group manager rate limits forced realtime sender key envelope lookups", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 1;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;

    let attempts = 0;
    manager.parent = {
        lookupGroupSenderKeyEnvelope: async () => {
            attempts++;
            const error: any = new Error("not found");
            error.status = 404;
            throw error;
        },
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const payload = {
        group_id: "group-1",
        key_id: 9,
    };
    const first = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web", {
        force: true,
        reason: "realtime_decrypt_failure",
    });
    const second = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web", {
        force: true,
        reason: "realtime_decrypt_failure",
    });

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(attempts, 1);
});

test("group manager retries forced realtime sender key lookup after short cooldown", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 1;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;
    manager.senderKeyEnvelopeForceLookupCooldownMs = 1;

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
                const error: any = new Error("not found");
                error.status = 404;
                throw error;
            }
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-h5", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const payload = {
        group_id: "group-1",
        key_id: 9,
    };
    const first = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web", {
        force: true,
        reason: "realtime_decrypt_failure",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web", {
        force: true,
        reason: "realtime_decrypt_failure",
    });

    assert.equal(first, false);
    assert.equal(second, true);
    assert.equal(attempts, 2);
    assert.ok(saved && saved.getStateByKeyId(9));
});

test("group manager forced realtime 404 does not block later normal envelope recovery", async () => {
    const manager: any = Object.create(GroupManager.prototype);
    manager.uid = "bob";
    manager.deviceId = "bob-h5";
    manager.groupEnvelopeRecoveryPromises = new Map();
    manager.senderKeyEnvelopeRecoveryMaxAttempts = 1;
    manager.senderKeyEnvelopeRecoveryBaseDelayMs = 1;
    manager.firstLoginGraceUntil = 0;

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
                const error: any = new Error("not found");
                error.status = 404;
                throw error;
            }
            return { envelope: JSON.stringify({ uid: "bob", device_id: "bob-h5", body: "server-envelope", is_ecies: true }) };
        },
        decryptGroupDistributionForDevice: async () => distributionPlain,
        requestGroupSenderKeyRepair: async () => undefined,
    };

    const payload = {
        group_id: "group-1",
        key_id: 9,
    };
    const first = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web", {
        force: true,
        reason: "realtime_decrypt_failure",
    });
    const second = await manager.recoverSenderKeyFromEnvelope(payload, "alice", "alice-web");

    assert.equal(first, false);
    assert.equal(second, true);
    assert.equal(attempts, 2);
    assert.ok(saved && saved.getStateByKeyId(9));
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
