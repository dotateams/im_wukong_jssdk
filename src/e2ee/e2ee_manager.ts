import type { Channel, ChannelInfo, MessageContent } from "../model";
import { ChannelTypePerson } from "../model";
import type { E2EEDecryptContext, E2EEInitOptions, E2EESendPlan, ResolveSendPlanOptions } from "./e2ee_types";
import { SignalE2EEAdapter } from "./e2ee_signal_adapter";
import { SignalProtocolManager } from "../signal/SignalProtocolManager";

export class E2EEManager {
    private options?: E2EEInitOptions;

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
        if (options.apiClient && options.apiClient.registerDeviceKeys) {
            await options.apiClient.registerDeviceKeys(options);
        }
    }

    public reset(): void {
        this.options = undefined;
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
        return adapter.decryptMessage(content, channel, context);
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
                    signalManager.getChanelSubscribersDevices(groupId, 2, true),
                getGroupMemberHash: (_groupId: string, members: any[]) =>
                    signalManager.normalizeMemberHash(undefined, members),
            }),
        };
    }
}
