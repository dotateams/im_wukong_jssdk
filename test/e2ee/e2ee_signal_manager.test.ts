import * as assert from "assert";
import { SignalProtocolManager } from "../../src/signal/SignalProtocolManager";
import { GroupManager } from "../../src/signal/managers/GroupManager";
import { SenderKeyRecord } from "../../src/signal/models/SenderKeyRecord";
import { SenderKeyState } from "../../src/signal/models/SenderKeyState";

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

test("group manager retries inline sender-key distribution for early messages", async () => {
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

    manager.parent = {
        encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
            iv: `iv-${msgIndex}`,
            body: `body-${msgIndex}`,
            mac: `mac-${msgIndex}`,
            tag: `tag-${msgIndex}`,
            enc: "aes-256-gcm",
        }),
        signGroupPayload: async () => "signature",
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
    const bodies: any[] = [];
    for (let i = 0; i < 4; i++) {
        const encrypted = await manager.encryptGroupMessage("group-1", `hello-${i}`, members, "members-v2");
        bodies.push(JSON.parse(encrypted.body));
    }

    assert.equal(bodies[0].msg_index, 0);
    assert.ok(bodies[0].distribution);
    assert.equal(bodies[1].msg_index, 1);
    assert.ok(bodies[1].distribution);
    assert.equal(bodies[2].msg_index, 2);
    assert.ok(bodies[2].distribution);
    assert.equal(bodies[3].msg_index, 3);
    assert.equal(bodies[3].distribution, undefined);
});
