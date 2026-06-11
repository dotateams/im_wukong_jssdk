import * as assert from "assert";
import WKSDK from "../../src";
import {
    Channel,
    ChannelTypePerson,
    Conversation,
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
    sdk.conversationManager.conversations = [];
    return sdk;
}

function signalMessage(): Message {
    const content = new MessageSignalContent();
    content.messageType = "signal_multi";
    content.realContentType = MessageContentType.text;
    content.senderDeviceId = "web-device-1";
    content.ciphertext = JSON.stringify({ type: "signal_multi", payload: "ciphertext" });

    const message = new Message();
    message.channel = new Channel("receiver", ChannelTypePerson);
    message.fromUID = "receiver";
    message.content = content;
    return message;
}

test("e2ee_conversation_manager decrypts synced conversation last messages", async () => {
    const sdk = resetSdk();
    const conversation = new Conversation();
    conversation.channel = new Channel("receiver", ChannelTypePerson);
    conversation.lastMessage = signalMessage();
    conversation.remoteExtra.version = 0;

    sdk.config.provider.syncConversationsCallback = async () => [conversation];
    await sdk.config.initE2EE({
        uid: "sender",
        deviceId: "web-device-1",
        cryptoAdapter: {
            decryptMessage: async () => new MessageText("conversation decrypted"),
        },
    });

    try {
        const conversations = await sdk.conversationManager.sync();

        assert.ok(conversations[0].lastMessage!.content instanceof MessageText);
        assert.equal((conversations[0].lastMessage!.content as MessageText).text, "conversation decrypted");
        assert.equal(sdk.conversationManager.conversations[0], conversations[0]);
    } finally {
        sdk.config.provider.syncConversationsCallback = undefined as any;
    }
});
