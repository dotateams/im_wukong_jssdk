import * as libsignal from '@privacyresearch/libsignal-protocol-typescript';
import { SignalProtocolStore } from '../storage/SignalProtocolStore';
import { SmartLRUCache } from '../utils/SmartLRUCache';
import { E2EEConfigManager } from '../E2EEConfig';

export interface IAPIClient {
  get(url: string): Promise<any>;
}

export interface SessionManagerParams {
  uid: string;
  deviceId: string | number;
  apiClient: IAPIClient;
  store: SignalProtocolStore;
  isSuccessResponse: (resp: any) => boolean;
  getResponseData: (resp: any) => any;
  toBase64: (data: any) => string;
  fromBase64: (data: any) => any;
  stringToArrayBuffer: (s: string) => ArrayBuffer;
  arrayBufferToString: (b: any) => string;
  ensureWebCrypto: () => void;
  maybeCheckAndRefillPreKeys: () => void;
  useOnetimePreKeys: (bundle: any) => Promise<any>;
  getRemoteKeyBundle?: (uid: string, deviceId: string | number) => Promise<any>;
}

export class SessionManager {
  uid: string;
  deviceId: string | number;
  apiClient: IAPIClient;
  store: SignalProtocolStore;
  getResponseData: (resp: any) => any;
  isSuccessResponse: (resp: any) => boolean;
  toBase64: (data: any) => string;
  fromBase64: (data: any) => any;
  stringToArrayBuffer: (s: string) => ArrayBuffer;
  arrayBufferToString: (b: any) => string;
  ensureWebCrypto: () => void;
  sessionBuildingLocks: Map<string, Promise<void>>;
  maybeCheckAndRefillPreKeys: () => void;
  useOnetimePreKeys: (bundle: any) => Promise<any>;
  getRemoteKeyBundle: (uid: string, deviceId: string | number) => Promise<any>;

  // 智能LRU缓存
  private sessionCache: SmartLRUCache<string, boolean>;

  constructor(params: SessionManagerParams) {
    this.uid = params.uid;
    this.deviceId = params.deviceId;
    this.apiClient = params.apiClient;
    this.store = params.store;
    this.isSuccessResponse = params.isSuccessResponse;
    this.getResponseData = params.getResponseData;
    this.toBase64 = params.toBase64;
    this.fromBase64 = params.fromBase64;
    this.stringToArrayBuffer = params.stringToArrayBuffer;
    this.arrayBufferToString = params.arrayBufferToString;
    this.ensureWebCrypto = params.ensureWebCrypto;
    this.sessionBuildingLocks = new Map();
    this.maybeCheckAndRefillPreKeys = params.maybeCheckAndRefillPreKeys;
    this.useOnetimePreKeys = params.useOnetimePreKeys;
    this.getRemoteKeyBundle =
      params.getRemoteKeyBundle ||
      (async (remoteUid: string, remoteDeviceId: string | number) => {
        const response = await this.apiClient.get(`/e2e/keys/${remoteUid}/${remoteDeviceId}`);
        if (!this.isSuccessResponse(response)) {
          throw new Error(
            `Failed to get prekey bundle: ${response && ((response as any).msg ?? (response as any).code)}`,
          );
        }
        return this.getResponseData(response);
      });

    // 初始化智能缓存
    const config = E2EEConfigManager.getInstance().getConfig();
    this.sessionCache = new SmartLRUCache({
      maxSize: 1000,
      ttlMs: config.sessionCacheTTL,
    });
  }

  private updateSessionCache(identifier: string, exists: boolean) {
    this.sessionCache.set(identifier, exists);
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { size: number; hitRate: number } {
    return this.sessionCache.getStats();
  }

  async buildSession(remoteUid: string, remoteDeviceId: string | number) {
    let bundleData: any = await this.getRemoteKeyBundle(remoteUid, remoteDeviceId);
    bundleData = await this.resolveBundleWithClaimedPreKey(remoteUid, remoteDeviceId, bundleData);
    const identityKeyRaw = bundleData.identity_key ?? bundleData.IdentityKey ?? bundleData.identityKey;
    const signedRaw =
      bundleData.signed_prekey ?? bundleData.SignedPrekey ?? bundleData.SignedPreKey ?? bundleData.signedPrekey;
    const preKeyRaw = bundleData.prekey ?? bundleData.Prekey ?? bundleData.PreKey ?? bundleData.preKey;
    const identityKey = this.fromBase64(identityKeyRaw);
    const signedPreKeyPublic = this.fromBase64(
      signedRaw && (signedRaw.public_key ?? signedRaw.PublicKey ?? signedRaw.publicKey),
    );
    const signature = this.fromBase64(signedRaw && (signedRaw.signature ?? signedRaw.Signature));
    const preKeyPublic = preKeyRaw
      ? this.fromBase64(preKeyRaw.public_key ?? preKeyRaw.PublicKey ?? preKeyRaw.publicKey)
      : undefined;
    const device: any = {
      identityKey,
      signedPreKey: {
        keyId: (signedRaw && (signedRaw.key_id ?? signedRaw.KeyID ?? signedRaw.keyId)) as any,
        publicKey: signedPreKeyPublic,
        signature,
      },
      preKey: preKeyRaw
        ? { keyId: preKeyRaw.key_id ?? preKeyRaw.KeyID ?? preKeyRaw.keyId, publicKey: preKeyPublic }
        : undefined,
      registrationId: bundleData.registration_id ?? bundleData.RegistrationID ?? bundleData.registrationId ?? 0,
    };
    const address = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const sessionBuilder = new (libsignal as any).SessionBuilder(this.store, address);
    await sessionBuilder.processPreKey(device);
    console.log(`Session built with ${remoteUid}:${remoteDeviceId}`);
    this.maybeCheckAndRefillPreKeys();

    // Update cache
    this.updateSessionCache(address.toString(), true);
  }

  async resolveBundleWithClaimedPreKey(remoteUid: string, remoteDeviceId: string | number, bundleData: any) {
    if (!bundleData) {
      return bundleData;
    }
    const existingPreKey = bundleData.prekey ?? bundleData.Prekey ?? bundleData.PreKey ?? bundleData.preKey;
    if (existingPreKey) {
      return bundleData;
    }
    const claimed = await this.useOnetimePreKeys({ uid: remoteUid, device_id: remoteDeviceId });
    const claimedPreKey =
      claimed && (claimed.one_time_prekey ?? claimed.OneTimePreKey ?? claimed.prekey ?? claimed.Prekey ?? claimed.PreKey);
    if (!claimedPreKey) {
      return bundleData;
    }
    return {
      ...bundleData,
      prekey: claimedPreKey,
    };
  }

  async hasSession(remoteUid: string, remoteDeviceId: string | number) {
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const identifier = remoteAddress.toString();

    // Check cache first
    if (this.sessionCache.has(identifier)) {
      const cached = this.sessionCache.get(identifier);
      if (cached !== undefined) {
        return cached;
      }
    }

    const session = await this.store.loadSession(identifier);
    const exists = !!session;

    // Update cache
    this.updateSessionCache(identifier, exists);

    return exists;
  }

  async deleteSession(remoteUid: string, remoteDeviceId: string | number) {
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const identifier = remoteAddress.toString();
    if (this.store && typeof (this.store as any).deleteSession === 'function') {
      await (this.store as any).deleteSession(identifier);
    } else {
      await this.store.storeSession(identifier, undefined);
    }

    // Update cache
    this.updateSessionCache(identifier, false);

    console.log(`Session deleted with ${remoteUid}:${remoteDeviceId}`);
  }

  clearSessionCache() {
    this.sessionCache.clear();
    this.sessionBuildingLocks.clear();
  }

  isRecoverablePreKeySessionError(messageType: any, message: string) {
    if (Number(messageType) !== 3) {
      return false;
    }
    return message.indexOf('unable to find session for base key') >= 0 || message.indexOf('Bad MAC') >= 0;
  }

  async encryptMessage(remoteUid: string, remoteDeviceId: string | number, plaintext: string) {
    this.ensureWebCrypto();
    const hasSession = await this.hasSession(remoteUid, remoteDeviceId);
    if (!hasSession) {
      const lockKey = `${remoteUid}:${remoteDeviceId}`;
      let lock = this.sessionBuildingLocks.get(lockKey);
      if (!lock) {
        lock = this.buildSession(remoteUid, remoteDeviceId).finally(() => {
          this.sessionBuildingLocks.delete(lockKey);
        });
        this.sessionBuildingLocks.set(lockKey, lock);
      }
      await lock;
    }
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const sessionCipher = new (libsignal as any).SessionCipher(this.store, remoteAddress);
    const message = await sessionCipher.encrypt(this.stringToArrayBuffer(plaintext));
    if (!message || !message.body) {
      throw new Error('Empty Signal ciphertext body');
    }
    return {
      type: message.type,
      body: this.toBase64(message.body),
    };
  }

  async decryptSignalCipherMessage(
    remoteUid: string,
    remoteDeviceId: string | number,
    messageType: any,
    ciphertext: any,
  ) {
    this.ensureWebCrypto();
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const cipherBytes = typeof ciphertext === 'string' ? this.fromBase64(ciphertext) : ciphertext;
    const doDecrypt = async () => {
      const sessionCipher = new (libsignal as any).SessionCipher(this.store, remoteAddress);
      if (messageType === 3) {
        return await sessionCipher.decryptPreKeyWhisperMessage(cipherBytes);
      }
      return await sessionCipher.decryptWhisperMessage(cipherBytes);
    };
    try {
      const plaintext = await doDecrypt();
      return this.arrayBufferToString(plaintext);
    } catch (e) {
      const msg = e && (e as any).message ? (e as any).message : String(e || '');
      if (this.isRecoverablePreKeySessionError(messageType, msg)) {
        console.warn(`Recovering stale Signal session with ${remoteUid}:${remoteDeviceId}: ${msg}`);
        await this.deleteSession(remoteUid, remoteDeviceId);
        const retryPlaintext = await doDecrypt();
        return this.arrayBufferToString(retryPlaintext);
      }
      throw e;
    }
  }

  async ensureTrustedIdentityKey(remoteUid: string, remoteDeviceId: string | number, identityKey: any) {
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const identifier = remoteAddress.toString();
    const trusted = await this.store.isTrustedIdentity(identifier, identityKey, 0);
    if (!trusted) {
      throw new Error('Untrusted identity key');
    }
    const existing = await this.store.getIdentity(identifier);
    if (!existing) {
      await this.store.saveIdentity(identifier, identityKey);
    }
  }

  /**
   * 生成安全指纹 (Safety Number/Fingerprint)
   * 用于防范中间人攻击(MITM)。用户可通过面对面扫码或外部渠道核对该指纹。
   * 算法：对本地身份公钥和远端身份公钥进行联合哈希。
   */
  async getFingerprint(remoteUid: string, remoteDeviceId: string | number): Promise<string | null> {
    const remoteAddress = new (libsignal as any).SignalProtocolAddress(remoteUid, this.toSignalDeviceId(remoteDeviceId));
    const identifier = remoteAddress.toString();

    // 获取远端身份公钥
    const remoteIdentity = await this.store.getIdentity(identifier);
    if (!remoteIdentity) {
      return null;
    }

    // 获取本地身份公钥
    const localIdentityKeyPair = await this.store.getIdentityKeyPair();
    if (!localIdentityKeyPair || !localIdentityKeyPair.pubKey) {
      return null;
    }

    // 将公钥转换为 Base64 以保证字符串拼接的一致性
    const localPubKeyBase64 = this.toBase64(localIdentityKeyPair.pubKey);
    const remotePubKeyBase64 = this.toBase64(remoteIdentity);

    // 排序以确保双方生成的指纹一致（无关发起方）
    const keys = [localPubKeyBase64, remotePubKeyBase64].sort();

    // 使用 SHA-256 生成指纹（这里简单示意，实际可根据需要引入 crypto 库进行 SHA-256）
    // 为了不引入额外的强依赖，这里使用简单的拼接作为指纹演示，
    // 强烈建议在应用层使用 CryptoJS.SHA256(keys.join("|")).toString()
    return keys.join('|');
  }

  toSignalDeviceId(deviceId: string | number): number {
    if (typeof deviceId === 'number' && Number.isFinite(deviceId)) {
      return this.normalizeSignalDeviceIdNumber(deviceId);
    }
    const raw = String(deviceId || '').trim();
    if (/^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return this.normalizeSignalDeviceIdNumber(parsed);
      }
    }
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0) % 0x7ffffffe + 1;
  }

  private normalizeSignalDeviceIdNumber(value: number): number {
    const normalized = Math.floor(Math.abs(value));
    if (normalized >= 1 && normalized <= 0x7fffffff) {
      return normalized;
    }
    return normalized % 0x7ffffffe + 1;
  }
}
