import * as assert from "assert";
import { PreKeyManager } from "../../src/signal/managers/PreKeyManager";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

test("e2ee_prekey_manager refills with server one_time_prekeys field", async () => {
    let replenishBody: any = null;
    const manager: any = new PreKeyManager({
        uid: "alice",
        deviceId: "alice-web",
        deviceName: "Alice Web",
        apiClient: {
            get: async () => ({ remaining: 0, total: 0 }),
            post: async (_path: string, body: any) => {
                replenishBody = body;
                return { ok: true };
            },
        },
        store: {},
        toBase64: (data: any) => `b64:${data}`,
        ensureWebCrypto: () => undefined,
    });
    manager.generatePreKeys = async () => [
        { keyId: 1, keyPair: { pubKey: "pub-1" } },
        { keyId: 2, keyPair: { pubKey: "pub-2" } },
    ];

    await manager.checkAndRefillPreKeys();

    assert.equal(replenishBody.uid, "alice");
    assert.equal(replenishBody.device_id, "alice-web");
    assert.ok(Array.isArray(replenishBody.one_time_prekeys));
    assert.equal(replenishBody.one_time_prekeys.length, 2);
    assert.equal(replenishBody.onetime_prekeys, undefined);
});

test("e2ee_prekey_manager re-registers existing identity when server device is missing", async () => {
    let uploaded: any = null;
    const manager: any = new PreKeyManager({
        uid: "alice",
        deviceId: "alice-web",
        deviceName: "Alice Web",
        apiClient: {
            get: async (path: string) => {
                assert.equal(path, "/e2e/keys/alice/alice-web");
                return { status: 404, msg: "not found" };
            },
            post: async (_path: string, body: any) => {
                uploaded = body;
                return { ok: true };
            },
        },
        store: {
            init: async () => undefined,
            getIdentityKeyPair: async () => ({ pubKey: "identity-pub", privKey: "identity-priv" }),
            getLocalRegistrationId: async () => 33,
            loadSignedPreKey: async () => ({ pubKey: "signed-pub", privKey: "signed-priv" }),
            storeSignedPreKey: async () => undefined,
        },
        toBase64: (data: any) => `b64:${data}`,
        ensureWebCrypto: () => undefined,
    });
    manager.generatePreKeys = async () => [
        { keyId: 101, keyPair: { pubKey: "prekey-101" } },
    ];
    manager.generateSignedPreKey = async () => ({
        keyId: 1,
        keyPair: { pubKey: "signed-new", privKey: "signed-priv" },
        signature: "signed-sig",
    });

    await manager.initialize();

    assert.ok(uploaded, "expected existing local identity to be uploaded when server is missing");
    assert.equal(uploaded.uid, "alice");
    assert.equal(uploaded.device_id, "alice-web");
    assert.equal(uploaded.identity_key, "b64:identity-pub");
    assert.ok(Array.isArray(uploaded.prekeys));
    assert.equal(uploaded.prekeys.length, 1);
});

test("e2ee_prekey_manager repairs missing local signed prekey for registered device", async () => {
    let uploaded: any = null;
    let generatedSignedPreKeyId: any = null;
    const manager: any = new PreKeyManager({
        uid: "alice",
        deviceId: "alice-web",
        deviceName: "Alice Web",
        apiClient: {
            get: async (path: string) => {
                assert.equal(path, "/e2e/keys/alice/alice-web");
                return {
                    uid: "alice",
                    device_id: "alice-web",
                    signed_prekey: { key_id: 7, public_key: "server-signed", signature: "server-sig" },
                };
            },
            post: async (_path: string, body: any) => {
                uploaded = body;
                return { ok: true };
            },
        },
        store: {
            init: async () => undefined,
            getIdentityKeyPair: async () => ({ pubKey: "identity-pub", privKey: "identity-priv" }),
            getLocalRegistrationId: async () => 33,
            loadSignedPreKey: async () => undefined,
            storeSignedPreKey: async () => undefined,
        },
        toBase64: (data: any) => `b64:${data}`,
        ensureWebCrypto: () => undefined,
    });
    manager.generatePreKeys = async () => [
        { keyId: 101, keyPair: { pubKey: "prekey-101" } },
    ];
    manager.generateSignedPreKey = async (keyId: any) => {
        generatedSignedPreKeyId = keyId;
        return {
            keyPair: { pubKey: "signed-new", privKey: "signed-priv" },
            signature: "signed-sig",
        };
    };

    await manager.initialize();

    assert.equal(generatedSignedPreKeyId, 7);
    assert.ok(uploaded, "expected missing local signed prekey to be repaired");
    assert.equal(uploaded.signed_prekey.key_id, 7);
    assert.equal(uploaded.signed_prekey.public_key, "b64:signed-new");
});

test("e2ee_prekey_manager uploads complete signed prekey rotation bundle", async () => {
    let uploaded: any = null;
    let storedSignedPreKeyId: any = null;
    const manager: any = new PreKeyManager({
        uid: "alice",
        deviceId: "alice-web",
        deviceName: "Alice Web",
        apiClient: {
            post: async (_path: string, body: any) => {
                uploaded = body;
                return { ok: true };
            },
        },
        store: {
            getIdentityKeyPair: async () => ({ pubKey: "identity-pub", privKey: "identity-priv" }),
            getLocalRegistrationId: async () => 33,
            storeSignedPreKey: async (keyId: any) => {
                storedSignedPreKeyId = keyId;
            },
        },
        toBase64: (data: any) => `b64:${data}`,
        ensureWebCrypto: () => undefined,
    });
    manager.generateSignedPreKeyId = () => 123456;
    manager.generateSignedPreKey = async () => ({
        keyPair: { pubKey: "signed-pub", privKey: "signed-priv" },
        signature: "signed-sig",
    });

    await manager.rotateSignedPreKey();

    assert.equal(storedSignedPreKeyId, 123456);
    assert.equal(uploaded.uid, "alice");
    assert.equal(uploaded.device_id, "alice-web");
    assert.equal(uploaded.device_name, "Alice Web");
    assert.equal(uploaded.platform, "web");
    assert.equal(uploaded.identity_key, "b64:identity-pub");
    assert.equal(uploaded.registration_id, 33);
    assert.equal(uploaded.signed_prekey.key_id, 123456);
    assert.equal(uploaded.signed_prekey.public_key, "b64:signed-pub");
    assert.equal(uploaded.signed_prekey.signature, "b64:signed-sig");
});

test("e2ee_prekey_manager signed prekey id stays within backend uint32 range", () => {
    const manager: any = new PreKeyManager({
        uid: "alice",
        deviceId: "alice-web",
        deviceName: "Alice Web",
        apiClient: {},
        store: {},
        toBase64: (data: any) => String(data),
        ensureWebCrypto: () => undefined,
    });

    const keyId = manager.generateSignedPreKeyId();

    assert.ok(Number.isInteger(keyId));
    assert.ok(keyId >= 0);
    assert.ok(keyId <= 0x7fffffff);
});
