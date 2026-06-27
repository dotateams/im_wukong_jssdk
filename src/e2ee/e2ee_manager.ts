import type { Channel, ChannelInfo, MediaMessageContent, MessageContent } from "../model";
import { ChannelTypeGroup, ChannelTypePerson } from "../model";
import type { E2EEDecryptContext, E2EEInitOptions, E2EERecoverContext, E2EESendPlan, ResolveSendPlanOptions } from "./e2ee_types";
import { SignalE2EEAdapter } from "./e2ee_signal_adapter";
import { SignalProtocolManager } from "../signal/SignalProtocolManager";
import { E2EEMediaCrypto } from "./e2ee_media";
import { E2EEConfigManager } from "../signal/E2EEConfig";

export class E2EEManager {
    private options?: E2EEInitOptions;
    private mediaCrypto?: E2EEMediaCrypto;

    public get initialized(): boolean {
        return !!this.options;
    }

    public get currentOptions(): E2EEInitOptions | undefined {
        return this.options;
    }

    public async initialize(options: E2EEInitOptions): Promise<void> {
        if (!options.uid) {
            throw new Error("E2EE uid is required");
        }
        if (!options.deviceId) {
            throw new Error("E2EE deviceId is required");
        }
        this.options = await this.normalizeOptions(options);
        this.mediaCrypto = new E2EEMediaCrypto({
            apiClient: this.options.apiClient,
            provider: this.options.mediaProvider,
            cacheScope: () => ({
                uid: this.options?.uid,
                deviceId: this.options?.deviceId,
            }),
        });
        if (options.apiClient && options.apiClient.registerDeviceKeys) {
            await options.apiClient.registerDeviceKeys(options);
        }
    }

    public reset(): void {
        this.options = undefined;
        this.mediaCrypto = undefined;
    }

    public async clearLocalPlaintextData(): Promise<void> {
        const options = this.options;
        if (!options) {
            return;
        }
        this.clearPlaintextStorage(options.uid, options.deviceId);
        if (this.mediaCrypto && typeof (this.mediaCrypto as any).clearLocalData === "function") {
            ;(this.mediaCrypto as any).clearLocalData();
        }
    }

    public async clearLocalData(): Promise<void> {
        const options = this.options;
        if (!options) {
            return;
        }
        await this.clearLocalPlaintextData();
        const adapter: any = options.cryptoAdapter as any;
        if (adapter && typeof adapter.clearLocalData === "function") {
            await adapter.clearLocalData();
        }
    }

    public async resolveSendPlan(
        channel: Channel,
        _content: MessageContent,
        options: ResolveSendPlanOptions = {},
    ): Promise<E2EESendPlan> {
        const channelInfo = await this.resolveChannelInfo(channel, options);

        if (!channelInfo || typeof channelInfo.isE2e !== "boolean") {
            return {
                action: "block",
                reason: "E2EE channel metadata is unresolved",
            };
        }

        if (!channelInfo.isE2e) {
            return {
                action: "plaintext",
                channelInfo,
            };
        }

        if (!this.initialized) {
            return {
                action: "block",
                reason: "E2EE is not initialized",
                channelInfo,
            };
        }

        return {
            action: "encrypt",
            channelInfo,
        };
    }

    public async encryptMessage(content: MessageContent, channel: Channel): Promise<MessageContent> {
        if (!this.options) {
            throw new Error("E2EE is not initialized");
        }
        const adapter = this.options.cryptoAdapter;
        if (!adapter || !adapter.encryptMessage) {
            throw new Error("E2EE encrypt adapter is unavailable");
        }
        return adapter.encryptMessage(content, channel);
    }

    public async prewarmChannel(channel: Channel): Promise<void> {
        if (!this.options || channel.channelType !== ChannelTypeGroup) {
            return;
        }
        const adapter: any = this.options.cryptoAdapter as any;
        if (adapter && typeof adapter.prewarmChannel === "function") {
            await adapter.prewarmChannel(channel);
        }
    }

    public async prepareGroupSend(channel: Channel): Promise<void> {
        if (!this.options || channel.channelType !== ChannelTypeGroup) {
            return;
        }
        const adapter = this.options.cryptoAdapter as any;
        if (adapter && typeof adapter.prepareGroupSend === "function") {
            await adapter.prepareGroupSend(channel);
        }
    }

    public invalidateGroupMemberCache(channel: Channel): void {
        if (!this.options || channel.channelType !== ChannelTypeGroup) {
            return;
        }
        const adapter = this.options.cryptoAdapter as any;
        if (adapter && typeof adapter.invalidateGroupMemberCache === "function") {
            adapter.invalidateGroupMemberCache(channel.channelID);
        }
    }

    public canEncryptMedia(content: MessageContent): boolean {
        return !!this.mediaCrypto && this.mediaCrypto.canEncrypt(content);
    }

    public async encryptMediaMessage(content: MediaMessageContent, channel: Channel): Promise<MessageContent> {
        if (!this.mediaCrypto) {
            throw new Error("E2EE media crypto is unavailable");
        }
        const encryptedMedia = await this.mediaCrypto.encryptContent(content, channel);
        const encryptedSignal = await this.encryptMessage(encryptedMedia, channel);
        ;(encryptedSignal as any).e2eePlaintextContent = encryptedMedia;
        return encryptedSignal;
    }

    public async decryptMessage(
        content: MessageContent,
        channel: Channel,
        context?: E2EEDecryptContext,
    ): Promise<MessageContent> {
        if (!this.options) {
            throw new Error("E2EE is not initialized");
        }
        const adapter = this.options.cryptoAdapter;
        if (!adapter || !adapter.decryptMessage) {
            throw new Error("E2EE decrypt adapter is unavailable");
        }
        const decrypted = await adapter.decryptMessage(content, channel, context);
        if (this.mediaCrypto && this.mediaCrypto.isEncryptedMedia(decrypted)) {
            return this.mediaCrypto.restoreContent(decrypted as any);
        }
        return decrypted;
    }

    public async recoverDecryptFailure(
        content: MessageContent,
        channel: Channel,
        context?: E2EERecoverContext,
    ): Promise<boolean> {
        if (!this.options) {
            return false;
        }
        const adapter = this.options.cryptoAdapter;
        if (!adapter || !adapter.recoverDecryptFailure) {
            return false;
        }
        return adapter.recoverDecryptFailure(content, channel, context);
    }

    public shouldCachePlaintext(content: MessageContent, channel?: Channel): boolean {
        if (!this.mediaCrypto) {
            return true;
        }
        if (this.mediaCrypto.isRestoredMedia(content)) {
            if (channel && channel.channelType !== ChannelTypePerson) {
                return false;
            }
            return !!this.mediaCrypto.toEncryptedMediaContent(content);
        }
        return !this.mediaCrypto.canEncrypt(content);
    }

    public cacheablePlaintextContent(content: MessageContent, channel?: Channel): MessageContent | undefined {
        if (!this.mediaCrypto) {
            return content;
        }
        if (this.mediaCrypto.isRestoredMedia(content)) {
            if (channel && channel.channelType !== ChannelTypePerson) {
                return undefined;
            }
            return this.mediaCrypto.toEncryptedMediaContent(content);
        }
        return content;
    }

    public async restoreCachedPlaintext(content: MessageContent, channel?: Channel): Promise<MessageContent> {
        if (this.mediaCrypto && this.mediaCrypto.isEncryptedMedia(content)) {
            return this.mediaCrypto.restoreContent(content as any);
        }
        return content;
    }

    public async loadMediaOriginal(content: MessageContent): Promise<string | undefined> {
        if (!this.mediaCrypto) {
            return undefined;
        }
        return this.mediaCrypto.loadOriginal(content as any);
    }

    public async loadMediaThumbnail(content: MessageContent): Promise<string | undefined> {
        if (!this.mediaCrypto) {
            return undefined;
        }
        return this.mediaCrypto.loadThumbnail(content as any);
    }

    private clearPlaintextStorage(uid: string, deviceId: string): void {
        const prefix = `wk_e2ee_plaintext:${uid}:${deviceId}:`;
        for (const storage of [this.getStorage("sessionStorage"), this.getStorage("localStorage")]) {
            if (!storage) {
                continue;
            }
            const keys: string[] = [];
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key && key.indexOf(prefix) === 0) {
                    keys.push(key);
                }
            }
            for (const key of keys) {
                storage.removeItem(key);
            }
        }
    }

    private getStorage(name: "sessionStorage" | "localStorage"): Storage | undefined {
        try {
            const storage = (globalThis as any)[name];
            return storage || undefined;
        } catch (_error) {
            return undefined;
        }
    }

    private async resolveChannelInfo(
        channel: Channel,
        options: ResolveSendPlanOptions,
    ): Promise<ChannelInfo | undefined> {
        const preflightInfo = await this.preflightChannelInfo(channel);
        if (preflightInfo && typeof preflightInfo.isE2e === "boolean") {
            return preflightInfo;
        }
        if (options.refreshChannelInfo) {
            const shouldRefresh =
                !options.channelInfo ||
                typeof options.channelInfo.isE2e !== "boolean" ||
                options.channelInfo.isE2e === false;
            if (shouldRefresh) {
                const refreshed = await options.refreshChannelInfo(channel);
                if (refreshed) {
                    return refreshed;
                }
            }
        }
        if (options.channelInfo && typeof options.channelInfo.isE2e === "boolean") {
            return options.channelInfo;
        }
        return options.channelInfo;
    }

    private async preflightChannelInfo(channel: Channel): Promise<ChannelInfo | undefined> {
        const apiClient = this.options?.apiClient;
        if (!apiClient || channel.channelType !== ChannelTypePerson) {
            return undefined;
        }
        let resp: any;
        if (apiClient.preflightChannelE2EE) {
            resp = await apiClient.preflightChannelE2EE(channel);
        } else if (typeof apiClient.post === "function") {
            resp = await apiClient.post(`channels/${channel.channelID}/${channel.channelType}/e2ee/preflight`, {});
        }
        return this.normalizeChannelInfo(channel, resp);
    }

    private normalizeChannelInfo(channel: Channel, data: any): ChannelInfo | undefined {
        if (!data) {
            return undefined;
        }
        const info = data.channel ? data as ChannelInfo : ({ channel } as ChannelInfo);
        const rawIsE2E = data.is_e2e !== undefined ? data.is_e2e : data.isE2e;
        if (typeof rawIsE2E === "boolean") {
            info.isE2e = rawIsE2E;
        } else if (rawIsE2E !== undefined && rawIsE2E !== null) {
            info.isE2e = rawIsE2E === 1 || rawIsE2E === "1" || rawIsE2E === "true";
        }
        const enabledAt = data.e2e_enabled_at !== undefined ? data.e2e_enabled_at : data.e2eEnabledAt;
        if (enabledAt !== undefined && enabledAt !== null) {
            info.e2eEnabledAt = Number(enabledAt) || 0;
        }
        const startSeq = data.e2e_start_message_seq !== undefined ? data.e2e_start_message_seq : data.e2eStartMessageSeq;
        if (startSeq !== undefined && startSeq !== null) {
            (info as any).e2eStartMessageSeq = Number(startSeq) || 0;
        }
        if (!info.channel) {
            info.channel = channel;
        }
        return info;
    }

    private async normalizeOptions(options: E2EEInitOptions): Promise<E2EEInitOptions> {
        if (options.cryptoAdapter || options.autoCreateSignalAdapter === false) {
            return options;
        }
        const apiClient = options.apiClient;
        if (!apiClient || typeof apiClient.get !== "function" || typeof apiClient.post !== "function") {
            return options;
        }
        if (options.senderKeyEnvelopeConcurrency !== undefined) {
            E2EEConfigManager.getInstance().updateConfig({
                senderKeyEnvelopeConcurrency: options.senderKeyEnvelopeConcurrency,
            });
        }
        const signalManager = new SignalProtocolManager(options.uid, apiClient, {
            deviceId: options.deviceId,
            deviceName: options.deviceName,
        });
        await signalManager.initialize();
        return {
            ...options,
            cryptoAdapter: new SignalE2EEAdapter({
                localUid: options.uid,
                localDeviceId: options.deviceId,
                signalManager,
                getGroupMembers: async (groupId: string) =>
                    signalManager.getChanelSubscribersDevices(groupId, 2),
                getGroupMemberHash: (_groupId: string, members: any[]) =>
                    signalManager.normalizeMemberHash(undefined, members),
            }),
        };
    }
}
