import { MessageContentType } from "../const";
import {
    Channel,
    ChannelTypeGroup,
    ChannelTypePerson,
    MessageContent,
    MessageContentManager,
    MessageSignalContent,
} from "../model";
import type { E2EEDecryptContext, E2EECryptoAdapter, E2EERecoverContext } from "./e2ee_types";

export interface SignalLikeManager {
    deviceId?: string | number;
    getRemoteDevices(uid: string, forceRefresh?: boolean): Promise<any[]>;
    encryptMessage(uid: string, deviceId: string | number, plaintext: string): Promise<any>;
    decryptMessage(uid: string, deviceId: string | number, messageType: any, ciphertext: any): Promise<string>;
    encryptGroupMessage?(groupId: string, plaintext: string, members?: any, memberHash?: any): Promise<any>;
    prepareGroupSend?(groupId: string, members?: any, memberHash?: any): Promise<any>;
    requestGroupSenderKeyRepair?(payload: any): Promise<any>;
    lookupGroupSenderKeyRepairRequests?(payload: any): Promise<any>;
    recoverGroupMessageDecryptFailure?(obj: any, senderUid: string, senderDeviceId: any): Promise<boolean>;
    invalidateChannelDevicesCache?(channelId: string, channelType?: any): void;
}

export interface SignalE2EEAdapterOptions {
    localUid?: string;
    localDeviceId: string | number;
    signalManager: SignalLikeManager;
    getGroupMembers?: (groupId: string) => Promise<any[]>;
    getGroupMemberHash?: (groupId: string, members: any[]) => string | Promise<string>;
}

export class SignalE2EEAdapter implements E2EECryptoAdapter {
    private localUid?: string;
    private localDeviceId: string | number;
    private signalManager: SignalLikeManager;
    private getGroupMembers?: (groupId: string) => Promise<any[]>;
    private getGroupMemberHash?: (groupId: string, members: any[]) => string | Promise<string>;
    private groupMembersCache: Map<string, { members: any[]; memberHash?: string }> = new Map();
    private groupMembersPromises: Map<string, Promise<{ members: any[]; memberHash?: string }>> = new Map();

    constructor(options: SignalE2EEAdapterOptions) {
        if (!options.localDeviceId) {
            throw new Error("localDeviceId is required");
        }
        if (!options.signalManager) {
            throw new Error("signalManager is required");
        }
        this.localUid = options.localUid;
        this.localDeviceId = options.localDeviceId;
        this.signalManager = options.signalManager;
        this.getGroupMembers = options.getGroupMembers;
        this.getGroupMemberHash = options.getGroupMemberHash;
    }

    public async prewarmChannel(channel: Channel): Promise<void> {
        if (channel.channelType !== ChannelTypeGroup || !this.getGroupMembers) {
            return;
        }
        await this.getGroupMembersForEncrypt(channel.channelID);
    }

    public async prepareGroupSend(channel: Channel): Promise<void> {
        if (channel.channelType !== ChannelTypeGroup || !this.signalManager.prepareGroupSend) {
            return;
        }
        const group = await this.getGroupMembersForEncrypt(channel.channelID);
        await this.signalManager.prepareGroupSend(channel.channelID, group.members, group.memberHash);
    }

    public invalidateGroupMemberCache(groupId: string): void {
        this.groupMembersCache.delete(groupId);
        this.groupMembersPromises.delete(groupId);
        if (typeof this.signalManager.invalidateChannelDevicesCache === "function") {
            this.signalManager.invalidateChannelDevicesCache(groupId, ChannelTypeGroup);
        }
    }

    public async clearLocalData(): Promise<void> {
        const manager: any = this.signalManager as any;
        if (manager && typeof manager.clearLocalData === "function") {
            await manager.clearLocalData();
        }
    }

    public async encryptMessage(content: MessageContent, channel: Channel): Promise<MessageContent> {
        if (this.isSignalContent(content)) {
            return content;
        }
        const plaintext = this.encodeContentToPlaintext(content);
        if (channel.channelType === ChannelTypePerson) {
            return this.encryptPerson(content, channel.channelID, plaintext);
        }
        if (channel.channelType === ChannelTypeGroup) {
            return this.encryptGroup(content, channel.channelID, plaintext);
        }
        throw new Error(`Unsupported E2EE channel type: ${channel.channelType}`);
    }

    public async decryptMessage(
        content: MessageContent,
        channel: Channel,
        context?: E2EEDecryptContext,
    ): Promise<MessageContent> {
        if (!this.isSignalContent(content)) {
            return content;
        }
        const signalContent = content as MessageSignalContent;
        const senderUid = this.resolveSenderUid(channel, context);
        const senderDeviceId = context?.senderDeviceId || signalContent.senderDeviceId;
        if (!senderUid) {
            throw new Error("Missing E2EE sender uid");
        }
        if (!senderDeviceId) {
            throw new Error("Missing E2EE sender device id");
        }
        const plaintext = await this.signalManager.decryptMessage(
            senderUid,
            senderDeviceId,
            signalContent.messageType,
            signalContent.ciphertext,
        );
        return this.decodePlaintextToContent(plaintext, signalContent.realContentType);
    }

    public async recoverDecryptFailure(
        content: MessageContent,
        channel: Channel,
        context?: E2EERecoverContext,
    ): Promise<boolean> {
        if (channel.channelType !== ChannelTypeGroup || !this.isSignalContent(content)) {
            return false;
        }
        if (!this.signalManager.recoverGroupMessageDecryptFailure) {
            return false;
        }
        const signalContent = content as MessageSignalContent;
        if (signalContent.messageType !== "signal_group") {
            return false;
        }
        const senderUid = this.resolveSenderUid(channel, context);
        const senderDeviceId = context?.senderDeviceId || signalContent.senderDeviceId;
        if (!senderUid || !senderDeviceId) {
            return false;
        }
        let obj: any = signalContent.ciphertext;
        if (typeof obj === "string") {
            try {
                obj = JSON.parse(obj);
            } catch (_error) {
                return false;
            }
        }
        if (!obj || obj.type !== "signal_group") {
            return false;
        }
        return this.signalManager.recoverGroupMessageDecryptFailure(obj, senderUid, senderDeviceId);
    }

    private isSignalContent(content: MessageContent | any): boolean {
        return content instanceof MessageSignalContent ||
            (content && content.contentType === MessageContentType.signalMessage);
    }

    private async encryptPerson(
        originalContent: MessageContent,
        remoteUid: string,
        plaintext: string,
    ): Promise<MessageSignalContent> {
        const devices = await this.getPersonRecipientDevices(remoteUid);
        if (!devices || devices.length === 0) {
            throw new Error(`No E2EE devices found for ${remoteUid}`);
        }

        const ciphertexts: any[] = [];
        for (const device of devices) {
            const deviceId = device && (device.device_id || device.deviceId || device.id);
            const deviceUid = device && (device.uid || device.user_id || device.userId || remoteUid);
            if (deviceId === undefined || deviceId === null || deviceId === "") {
                continue;
            }
            const ciphertext = await this.signalManager.encryptMessage(deviceUid, deviceId, plaintext);
            if (!ciphertext || !ciphertext.body) {
                throw new Error(`E2EE encryption returned empty ciphertext for device ${deviceId}`);
            }
            ciphertexts.push({
                uid: deviceUid,
                device_id: deviceId,
                type: ciphertext.type,
                body: ciphertext.body,
            });
        }

        if (ciphertexts.length === 0) {
            throw new Error(`No valid E2EE devices found for ${remoteUid}`);
        }

        return this.buildSignalContent(
            "signal_multi",
            JSON.stringify({ type: "signal_multi", ciphertexts }),
            originalContent.contentType,
        );
    }

    private async getPersonRecipientDevices(remoteUid: string): Promise<any[]> {
        const remoteDevices = await this.signalManager.getRemoteDevices(remoteUid, true);
        if (!this.localUid) {
            return remoteDevices;
        }
        const localDevices = await this.signalManager.getRemoteDevices(this.localUid, true);
        const recipients: any[] = [];
        const seen = new Set<string>();
        const append = (uid: string, devices: any[], skipLocalDevice: boolean) => {
            for (const device of devices || []) {
                const deviceId = device && (device.device_id || device.deviceId || device.id);
                if (deviceId === undefined || deviceId === null || deviceId === "") {
                    continue;
                }
                if (skipLocalDevice && String(deviceId) === String(this.localDeviceId)) {
                    continue;
                }
                const key = `${uid}:${deviceId}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                recipients.push({ ...device, uid, device_id: deviceId });
            }
        };
        append(remoteUid, remoteDevices, false);
        if (this.localUid !== remoteUid) {
            append(this.localUid, localDevices, false);
        }
        return recipients;
    }

    private async encryptGroup(
        originalContent: MessageContent,
        groupId: string,
        plaintext: string,
    ): Promise<MessageSignalContent> {
        if (!this.signalManager.encryptGroupMessage) {
            throw new Error("E2EE group encrypt adapter is unavailable");
        }
        const group = await this.getGroupMembersForEncrypt(groupId);
        const encrypted = await this.signalManager.encryptGroupMessage(groupId, plaintext, group.members, group.memberHash);
        const payload = this.normalizeGroupEncryptedPayload(groupId, encrypted);
        return this.buildSignalContent(
            "signal_group",
            JSON.stringify(payload),
            originalContent.contentType,
        );
    }

    private normalizeGroupEncryptedPayload(groupId: string, encrypted: any): any {
        if (!encrypted) {
            throw new Error(`E2EE group encryption returned empty ciphertext for ${groupId}`);
        }
        if (encrypted.type === "signal_group") {
            return encrypted;
        }
        if (typeof encrypted.body === "string") {
            try {
                const bodyPayload = JSON.parse(encrypted.body);
                if (bodyPayload && bodyPayload.type === "signal_group") {
                    return bodyPayload;
                }
            } catch (_error) {
                // Fall through to the legacy object wrapper below.
            }
        }
        const payload = { type: "signal_group", group_id: groupId, ...encrypted };
        if (payload.body && typeof payload.body === "string" && payload.body.indexOf("\"signal_group\"") >= 0) {
            throw new Error("Invalid nested E2EE group ciphertext payload");
        }
        return payload;
    }

    private async getGroupMembersForEncrypt(groupId: string): Promise<{ members: any[]; memberHash?: string }> {
        const cached = this.groupMembersCache.get(groupId);
        if (cached) {
            return cached;
        }
        const pending = this.groupMembersPromises.get(groupId);
        if (pending) {
            return pending;
        }
        const promise = (async () => {
            const members = this.getGroupMembers ? await this.getGroupMembers(groupId) : [];
            const memberHash = this.getGroupMemberHash ? await this.getGroupMemberHash(groupId, members) : undefined;
            const result = { members, memberHash };
            this.groupMembersCache.set(groupId, result);
            return result;
        })().finally(() => {
            this.groupMembersPromises.delete(groupId);
        });
        this.groupMembersPromises.set(groupId, promise);
        return promise;
    }

    private buildSignalContent(
        messageType: string,
        ciphertext: string,
        realContentType: number,
    ): MessageSignalContent {
        const signalContent = new MessageSignalContent();
        signalContent.ciphertext = ciphertext;
        signalContent.messageType = messageType;
        signalContent.realContentType = realContentType;
        signalContent.senderDeviceId = this.signalManager.deviceId || this.localDeviceId;
        return signalContent;
    }

    private encodeContentToPlaintext(content: MessageContent): string {
        const encoded = content.encode();
        const encodedString = String.fromCharCode.apply(null, Array.from(encoded));
        try {
            return decodeURIComponent(escape(encodedString));
        } catch (_error) {
            return encodedString;
        }
    }

    private decodePlaintextToContent(plaintext: string, fallbackType: number): MessageContent {
        const contentObj = JSON.parse(plaintext);
        const contentType = contentObj.type || fallbackType || MessageContentType.unknown;
        const messageContent = MessageContentManager.shared().getMessageContent(contentType);
        messageContent.decode(this.stringToUint8Array(JSON.stringify(contentObj)));
        return messageContent;
    }

    private stringToUint8Array(value: string): Uint8Array {
        const encoded = unescape(encodeURIComponent(value));
        const result = new Array<number>();
        for (let i = 0; i < encoded.length; i++) {
            result.push(encoded.charCodeAt(i));
        }
        return new Uint8Array(result);
    }

    private resolveSenderUid(channel: Channel, context?: E2EEDecryptContext): string {
        if (context?.fromUID) {
            return context.fromUID;
        }
        if (channel.channelType === ChannelTypePerson) {
            return channel.channelID;
        }
        return context?.message?.fromUID || channel.channelID;
    }
}
