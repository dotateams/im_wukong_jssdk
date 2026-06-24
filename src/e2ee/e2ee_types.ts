import type { Channel, ChannelInfo, Message, MessageContent } from "../model";

export type E2EESendAction = "plaintext" | "encrypt" | "block";

export interface E2EEApiClient {
    registerDeviceKeys?: (options: E2EEInitOptions) => Promise<void>;
    preflightChannelE2EE?: (channel: Channel) => Promise<ChannelInfo | any>;
    get?: (path: string) => Promise<any>;
    post?: (path: string, body?: any) => Promise<any>;
}

export interface E2EEMediaProvider {
    uploadEncryptedMedia?: (file: Blob, context: {
        channel: Channel;
        kind: "original" | "thumb";
        contentType: number;
        fileName?: string;
        mime?: string;
    }) => Promise<string>;
    fetchEncryptedMedia?: (url: string) => Promise<Blob>;
    createThumbnail?: (file: Blob, context: {
        contentType: number;
        mediaKind: string;
        maxSize: number;
    }) => Promise<Blob | undefined>;
}

export interface E2EEDecryptContext {
    message?: Message;
    fromUID?: string;
    senderDeviceId?: string | number;
}

export interface E2EECryptoAdapter {
    encryptMessage?: (content: MessageContent, channel: Channel) => Promise<MessageContent>;
    decryptMessage?: (content: MessageContent, channel: Channel, context?: E2EEDecryptContext) => Promise<MessageContent>;
    prepareGroupSend?: (channel: Channel) => Promise<void>;
    clearLocalData?: () => Promise<void>;
}

export interface E2EEInitOptions {
    uid: string;
    deviceId: string;
    deviceName?: string;
    platform?: string;
    apiClient?: E2EEApiClient;
    cryptoAdapter?: E2EECryptoAdapter;
    mediaProvider?: E2EEMediaProvider;
    autoCreateSignalAdapter?: boolean;
    senderKeyEnvelopeConcurrency?: number;
}

export interface ResolveSendPlanOptions {
    channelInfo?: ChannelInfo;
    refreshChannelInfo?: (channel: Channel) => Promise<ChannelInfo | undefined>;
}

export interface E2EESendPlan {
    action: E2EESendAction;
    reason?: string;
    channelInfo?: ChannelInfo;
}
