import * as assert from "assert";
import { SessionManager } from "../../src/signal/managers/SessionManager";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function createSessionManager(claim: (bundle: any) => Promise<any>) {
    return new SessionManager({
        uid: "alice",
        deviceId: "alice-web",
        apiClient: { get: async () => ({}) },
        store: {} as any,
        isSuccessResponse: () => true,
        getResponseData: (resp: any) => resp,
        toBase64: (data: any) => String(data),
        fromBase64: (data: any) => data,
        stringToArrayBuffer: (value: string) => new TextEncoder().encode(value).buffer,
        arrayBufferToString: (value: any) => new TextDecoder().decode(value),
        ensureWebCrypto: () => undefined,
        maybeCheckAndRefillPreKeys: () => undefined,
        useOnetimePreKeys: claim,
    });
}

test("e2ee_session_manager claims one-time prekey before building a bundle without prekey", async () => {
    const claims: any[] = [];
    const manager: any = createSessionManager(async (bundle: any) => {
        claims.push(bundle);
        return {
            one_time_prekey: {
                key_id: 7,
                public_key: "claimed-prekey",
            },
        };
    });

    const bundle = await manager.resolveBundleWithClaimedPreKey("bob", "bob-web", {
        uid: "bob",
        device_id: "bob-web",
        identity_key: "identity",
        signed_prekey: { key_id: 1, public_key: "signed", signature: "sig" },
    });

    assert.deepEqual(claims, [{ uid: "bob", device_id: "bob-web" }]);
    assert.equal(bundle.prekey.key_id, 7);
    assert.equal(bundle.prekey.public_key, "claimed-prekey");
});

test("e2ee_session_manager keeps existing prekey without claiming another", async () => {
    let claimed = false;
    const manager: any = createSessionManager(async () => {
        claimed = true;
        return {};
    });

    const bundle = await manager.resolveBundleWithClaimedPreKey("bob", "bob-web", {
        uid: "bob",
        device_id: "bob-web",
        identity_key: "identity",
        signed_prekey: { key_id: 1, public_key: "signed", signature: "sig" },
        prekey: { key_id: 3, public_key: "existing-prekey" },
    });

    assert.equal(claimed, false);
    assert.equal(bundle.prekey.key_id, 3);
    assert.equal(bundle.prekey.public_key, "existing-prekey");
});

test("e2ee_session_manager maps uuid device ids to stable signal addresses", async () => {
    const manager: any = createSessionManager(async () => ({}));

    const first = manager.toSignalDeviceId("dc483c91-5277-4c06-aff3-ced0093a1d41");
    const again = manager.toSignalDeviceId("dc483c91-5277-4c06-aff3-ced0093a1d41");
    const second = manager.toSignalDeviceId("a9b6ca89-91cf-47bd-b569-025abd2ca01f");

    assert.equal(first, again);
    assert.ok(Number.isInteger(first));
    assert.ok(first > 0);
    assert.ok(first <= 0x7fffffff);
    assert.notEqual(first, second);
});

test("e2ee_session_manager preserves numeric signal device ids", async () => {
    const manager: any = createSessionManager(async () => ({}));

    assert.equal(manager.toSignalDeviceId("33"), 33);
    assert.equal(manager.toSignalDeviceId(33), 33);
});

test("e2ee_session_manager deletes stale sessions and clears cached state", async () => {
    const deleted: string[] = [];
    const manager: any = createSessionManager(async () => ({}));
    manager.store = {
        deleteSession: async (identifier: string) => {
            deleted.push(identifier);
        },
        loadSession: async () => ({ session: true }),
    };

    assert.equal(await manager.hasSession("bob", "bob-web"), true);
    await manager.deleteSession("bob", "bob-web");
    assert.equal(await manager.hasSession("bob", "bob-web"), false);
    assert.equal(deleted.length, 1);
    assert.ok(deleted[0].startsWith("bob."));
});

test("e2ee_session_manager retries only recoverable prekey base-key session errors", async () => {
    const manager: any = createSessionManager(async () => ({}));

    assert.equal(
        manager.isRecoverablePreKeySessionError(3, "unable to find session for base key abc, 33"),
        true,
    );
    assert.equal(
        manager.isRecoverablePreKeySessionError(1, "unable to find session for base key abc, 33"),
        false,
    );
    assert.equal(
        manager.isRecoverablePreKeySessionError(3, "Missing Signed PreKey for PreKeyWhisperMessage"),
        false,
    );
});
