import * as assert from "assert";
import {
    Channel,
    ChannelInfo,
    ChannelTypeGroup,
    ChannelTypePerson,
    MessageSignalContent,
    MessageText,
} from "../../src/model";
import { MessageContentType } from "../../src/const";
import { E2EEManager } from "../../src/e2ee/e2ee_manager";
import { SignalProtocolManager } from "../../src/signal/SignalProtocolManager";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function enabledChannelInfo(channel: Channel): ChannelInfo {
    const info = new ChannelInfo();
    info.channel = channel;
    info.isE2e = true;
    info.e2eEnabledAt = 1710000000;
    return info;
}

function disabledChannelInfo(channel: Channel): ChannelInfo {
    const info = new ChannelInfo();
    info.channel = channel;
    info.isE2e = false;
    return info;
}

test("e2ee_gate ChannelInfo stores E2EE metadata", () => {
    const channel = new Channel("group-1", ChannelTypeGroup);
    const info = enabledChannelInfo(channel);

    assert.equal(info.isE2e, true);
    assert.equal(info.e2eEnabledAt, 1710000000);
});

test("e2ee_gate MessageSignalContent encodes envelope metadata", () => {
    const content = new MessageSignalContent();
    content.messageType = "signal_multi";
    content.realContentType = MessageContentType.text;
    content.senderDeviceId = "web-device-1";
    content.ciphertext = JSON.stringify({ type: "signal_multi", ciphertexts: [] });

    const decoded = new MessageSignalContent();
    decoded.decode(content.encode());

    assert.equal(decoded.contentType, MessageContentType.signalMessage);
    assert.equal(decoded.messageType, "signal_multi");
    assert.equal(decoded.realContentType, MessageContentType.text);
    assert.equal(decoded.senderDeviceId, "web-device-1");
    assert.equal(decoded.ciphertext, content.ciphertext);
});

test("e2ee_gate initialization requires uid and deviceId", async () => {
    const manager = new E2EEManager();

    await assert.rejects(
        () => manager.initialize({ uid: "", deviceId: "web-device-1" }),
        /uid/,
    );
    await assert.rejects(
        () => manager.initialize({ uid: "u1", deviceId: "" }),
        /deviceId/,
    );
});

test("e2ee_gate explicit disabled channel sends plaintext", async () => {
    const manager = new E2EEManager();
    const channel = new Channel("u2", ChannelTypePerson);
    const plan = await manager.resolveSendPlan(channel, new MessageText("hello"), {
        channelInfo: disabledChannelInfo(channel),
    });

    assert.equal(plan.action, "plaintext");
});

test("e2ee_gate refreshes disabled cache before sending", async () => {
    const manager = new E2EEManager();
    const channel = new Channel("u2", ChannelTypePerson);
    let refreshed = false;
    const plan = await manager.resolveSendPlan(channel, new MessageText("hello"), {
        channelInfo: disabledChannelInfo(channel),
        refreshChannelInfo: async () => {
            refreshed = true;
            return enabledChannelInfo(channel);
        },
    });

    assert.equal(refreshed, true);
    assert.equal(plan.action, "block");
    assert.match(plan.reason || "", /initial/i);
});

test("e2ee_gate enabled channel blocks before initialization", async () => {
    const manager = new E2EEManager();
    const channel = new Channel("u2", ChannelTypePerson);
    const plan = await manager.resolveSendPlan(channel, new MessageText("hello"), {
        channelInfo: enabledChannelInfo(channel),
    });

    assert.equal(plan.action, "block");
    assert.match(plan.reason || "", /initial/i);
});

test("e2ee_gate unknown channel metadata refreshes and blocks if unresolved", async () => {
    const manager = new E2EEManager();
    const channel = new Channel("u3", ChannelTypePerson);
    let refreshed = false;

    const plan = await manager.resolveSendPlan(channel, new MessageText("hello"), {
        refreshChannelInfo: async () => {
            refreshed = true;
            return undefined;
        },
    });

    assert.equal(refreshed, true);
    assert.equal(plan.action, "block");
    assert.match(plan.reason || "", /metadata/i);
});

test("e2ee_gate plaintext history stays readable in enabled channels", () => {
    const text = new MessageText("old plaintext");
    const decoded = new MessageText();

    decoded.decode(text.encode());

    assert.equal(decoded.text, "old plaintext");
    assert.equal(decoded.contentType, MessageContentType.text);
});

test("e2ee_gate auto signal adapter uses cached group subscriber devices while sending", async () => {
    const initialize = SignalProtocolManager.prototype.initialize;
    const getChanelSubscribersDevices = SignalProtocolManager.prototype.getChanelSubscribersDevices;
    const encryptGroupMessage = SignalProtocolManager.prototype.encryptGroupMessage;
    const forceRefreshArgs: any[] = [];

    SignalProtocolManager.prototype.initialize = async function () {
        return undefined as any;
    };
    SignalProtocolManager.prototype.getChanelSubscribersDevices = async function (
        _channelId: string,
        _channelType: any,
        forceRefresh?: boolean,
    ) {
        forceRefreshArgs.push(forceRefresh);
        return [{ uid: "bob", devices: [{ device_id: "bob-web" }] }];
    };
    SignalProtocolManager.prototype.encryptGroupMessage = async function (groupId: string) {
        return {
            type: "signal_group",
            group_id: groupId,
            body: "cipher-body",
        };
    };

    try {
        const manager = new E2EEManager();
        await manager.initialize({
            uid: "alice",
            deviceId: "alice-web",
            apiClient: {
                get: async () => [],
                post: async () => ({}),
            },
        });

        await manager.encryptMessage(new MessageText("hello"), new Channel("group-1", ChannelTypeGroup));
    } finally {
        SignalProtocolManager.prototype.initialize = initialize;
        SignalProtocolManager.prototype.getChanelSubscribersDevices = getChanelSubscribersDevices;
        SignalProtocolManager.prototype.encryptGroupMessage = encryptGroupMessage;
    }

    assert.deepEqual(forceRefreshArgs, [undefined]);
});

test("e2ee_gate prewarms encrypted group subscriber devices without forcing refresh", async () => {
    const initialize = SignalProtocolManager.prototype.initialize;
    const getChanelSubscribersDevices = SignalProtocolManager.prototype.getChanelSubscribersDevices;
    const forceRefreshArgs: any[] = [];

    SignalProtocolManager.prototype.initialize = async function () {
        return undefined as any;
    };
    SignalProtocolManager.prototype.getChanelSubscribersDevices = async function (
        _channelId: string,
        _channelType: any,
        forceRefresh?: boolean,
    ) {
        forceRefreshArgs.push(forceRefresh);
        return [{ uid: "bob", devices: [{ device_id: "bob-web" }] }];
    };

    try {
        const manager = new E2EEManager();
        await manager.initialize({
            uid: "alice",
            deviceId: "alice-web",
            apiClient: {
                get: async () => [],
                post: async () => ({}),
            },
        });

        await (manager as any).prewarmChannel(new Channel("group-1", ChannelTypeGroup));
    } finally {
        SignalProtocolManager.prototype.initialize = initialize;
        SignalProtocolManager.prototype.getChanelSubscribersDevices = getChanelSubscribersDevices;
    }

    assert.deepEqual(forceRefreshArgs, [undefined]);
});
