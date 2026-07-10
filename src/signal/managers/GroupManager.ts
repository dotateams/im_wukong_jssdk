import CryptoJS from 'crypto-js';
import StorageService from '../storage/StorageService';
import { SignalProtocolStore as SignalProtocolStoreClass } from '../storage/SignalProtocolStore';
import { SenderKeyState } from '../models/SenderKeyState';
import { SenderKeyRecord } from '../models/SenderKeyRecord';
import { SenderKeyDistributionMessage } from '../models/SenderKeyDistributionMessage';
import { GroupCipher } from '../ciphers/GroupCipher';
import { SmartLRUCache } from '../utils/SmartLRUCache';
import { E2EEConfigManager } from '../E2EEConfig';

export class GroupManager {
  parent: any;
  uid: any;
  deviceId: any;
  groupEncryptionLocks: Map<any, any>;
  signalStore: SignalProtocolStoreClass;
  groupEnvelopeRecoveryPromises: Map<string, Promise<boolean>>;

  // 智能缓存
  private senderKeyCache: SmartLRUCache<string, SenderKeyRecord>;
  private senderKeyStateCache: SmartLRUCache<string, any>;
  private senderKeyEnvelopeUploadCache: SmartLRUCache<string, boolean>;
  private senderKeyEnvelopeUploadPromises: Map<string, Promise<void>>;
  private senderKeyDistributionPreparedCache: SmartLRUCache<string, boolean>;
  private senderKeyEnvelopeMissingCache: SmartLRUCache<string, boolean>;
  private senderKeyEnvelopeForceLookupCache: SmartLRUCache<string, boolean>;
  private senderKeyRepairRequestCache: SmartLRUCache<string, boolean>;
  private senderKeyRepairBatchQueue: Map<string, any>;
  private senderKeyRepairBatchTimer: any;
  private senderKeyEnvelopeLookupBatchQueue: Map<string, any>;
  private senderKeyEnvelopeLookupBatchTimer: any;
  private readonly senderKeyDistributionRetryWindow = 1;
  private readonly senderKeyDistributionInterval: number;
  private readonly senderKeyEnvelopeRecoveryMaxAttempts: number;
  private readonly senderKeyEnvelopeRecoveryBaseDelayMs: number;
  private readonly senderKeyEnvelopeForceLookupCooldownMs: number;
  private readonly senderKeyEnvelopeMissingPersistentTtlMs: number;
  private readonly firstLoginEnvelopeGraceMs: number;
  private firstLoginGraceUntil: number;
  senderKeyEnvelopeConcurrency: number;
  senderKeyEnvelopeUploadBatchSize: number;
  private identityRepairGeneration: number;
  private identityRepairDistributionGroups: Set<string>;

  constructor(parent: any, uid: any, deviceId: any) {
    this.parent = parent;
    this.uid = uid;
    this.deviceId = deviceId;
    this.groupEncryptionLocks = new Map();
    this.groupEnvelopeRecoveryPromises = new Map();
    this.senderKeyEnvelopeUploadPromises = new Map();
    this.senderKeyRepairBatchQueue = new Map();
    this.senderKeyRepairBatchTimer = null;
    this.senderKeyEnvelopeLookupBatchQueue = new Map();
    this.senderKeyEnvelopeLookupBatchTimer = null;
    this.identityRepairGeneration = 0;
    this.identityRepairDistributionGroups = new Set();
    this.firstLoginGraceUntil = 0;
    this.signalStore = new SignalProtocolStoreClass(uid, deviceId);

    // 初始化智能缓存
    const config = E2EEConfigManager.getInstance().getConfig();
    this.senderKeyDistributionInterval = Math.max(0, Number(config.senderKeyDistributionInterval || 0));
    this.senderKeyEnvelopeRecoveryMaxAttempts = Math.max(1, Number(config.maxDecryptRetries || 3));
    this.senderKeyEnvelopeRecoveryBaseDelayMs = Math.max(1, Number(config.retryDelayMs || 1000));
    this.senderKeyEnvelopeForceLookupCooldownMs = Math.max(500, Math.min(Number(config.retryDelayMs || 1000), 3000));
    this.senderKeyEnvelopeMissingPersistentTtlMs = 5 * 60 * 1000;
    this.firstLoginEnvelopeGraceMs = Math.max(0, Number(config.firstLoginEnvelopeGraceMs || 30000));
    this.senderKeyEnvelopeConcurrency = Math.max(1, Number(config.senderKeyEnvelopeConcurrency || config.groupDistributionConcurrency || 10));
    this.senderKeyEnvelopeUploadBatchSize = Math.max(1, Number((config as any).senderKeyEnvelopeUploadBatchSize || 100));
    this.senderKeyCache = new SmartLRUCache({
      maxSize: config.maxSenderKeyCacheSize,
      ttlMs: config.sessionCacheTTL,
    });
    this.senderKeyStateCache = new SmartLRUCache({
      maxSize: 2000,
      ttlMs: 2 * 60 * 1000,
    });
    this.senderKeyEnvelopeUploadCache = new SmartLRUCache({
      maxSize: config.maxDistributionCacheSize,
      ttlMs: config.senderKeyEnvelopeUploadCacheTTL,
    });
    this.senderKeyDistributionPreparedCache = new SmartLRUCache({
      maxSize: config.maxDistributionCacheSize,
      ttlMs: Math.max(Number(config.senderKeyEnvelopeUploadCacheTTL || 0), 5 * 60 * 1000),
    });
    this.senderKeyEnvelopeMissingCache = new SmartLRUCache({
      maxSize: 5000,
      ttlMs: 60 * 1000,
    });
    this.senderKeyEnvelopeForceLookupCache = new SmartLRUCache({
      maxSize: 5000,
      ttlMs: 60 * 1000,
    });
    this.senderKeyRepairRequestCache = new SmartLRUCache({
      maxSize: 5000,
      ttlMs: 30 * 1000,
    });
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(groupId: any, senderUid: any, senderDeviceId?: any): string {
    return `${groupId}:${senderUid}:${senderDeviceId || 'default'}`;
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): {
    senderKeyCache: { size: number; hitRate: number };
    senderKeyStateCache: { size: number; hitRate: number };
  } {
    return {
      senderKeyCache: this.senderKeyCache.getStats(),
      senderKeyStateCache: this.senderKeyStateCache.getStats(),
    };
  }

  markLocalIdentityRepaired() {
    this.identityRepairGeneration++;
    this.identityRepairDistributionGroups = new Set();
    this.senderKeyEnvelopeUploadCache?.clear?.();
    this.senderKeyEnvelopeUploadPromises?.clear?.();
    this.senderKeyEnvelopeMissingCache?.clear?.();
    this.senderKeyEnvelopeForceLookupCache?.clear?.();
    this.clearPersistentSenderKeyEnvelopeMissingCache();
    this.senderKeyRepairRequestCache?.clear?.();
    this.senderKeyRepairBatchQueue?.clear?.();
    if (this.senderKeyRepairBatchTimer) {
      clearTimeout(this.senderKeyRepairBatchTimer);
      this.senderKeyRepairBatchTimer = null;
    }
    this.senderKeyStateCache?.clear?.();
  }

  markFirstLoginKeyRegistrationComplete(graceMs?: number) {
    const duration = Math.max(0, Number(graceMs ?? this.firstLoginEnvelopeGraceMs ?? 30000));
    this.firstLoginGraceUntil = Date.now() + duration;
    this.markLocalIdentityRepaired();
  }

  private getIdentityRepairDistributionKey(groupId: any): string {
    return `${this.identityRepairGeneration}:${groupId}`;
  }

  private shouldReuploadAfterIdentityRepair(groupId: any, record: any): boolean {
    if (!this.identityRepairGeneration || !record) {
      return false;
    }
    const key = this.getIdentityRepairDistributionKey(groupId);
    return !this.identityRepairDistributionGroups.has(key);
  }

  private markIdentityRepairDistributionDone(groupId: any) {
    if (!this.identityRepairGeneration) {
      return;
    }
    this.identityRepairDistributionGroups.add(this.getIdentityRepairDistributionKey(groupId));
  }

  normalizeMemberHash(memberHash: any, members: any) {
    if (memberHash && typeof memberHash === 'string') {
      return memberHash;
    }
    if (!Array.isArray(members) || members.length === 0) {
      return '';
    }
    const entries: any[] = [];
    for (const member of members) {
      if (member && member.uid) {
        const deviceIds = this.normalizeMemberDeviceIds(member);
        if (deviceIds.length === 0) {
          entries.push(`${member.uid}:`);
        } else {
          for (const deviceId of deviceIds) {
            entries.push(`${member.uid}:${deviceId}`);
          }
        }
      }
    }
    const unique = Array.from(new Set(entries)).sort();
    if (unique.length === 0) {
      return '';
    }
    return (CryptoJS as any).MD5(unique.join('|')).toString();
  }

  /**
   * 从成员列表计算 memberHash（用于确保一致性）
   * @param members 成员列表，格式为 { uid: string, deviceIds: (string | number)[] }[]
   * @returns MD5 hash of sorted uids
   */
  calculateMemberHashFromMembers(members: any): string {
    if (!Array.isArray(members) || members.length === 0) {
      return '';
    }
    const entries: any[] = [];
    for (const member of members) {
      if (member && member.uid) {
        const deviceIds = this.normalizeMemberDeviceIds(member);
        if (deviceIds.length === 0) {
          entries.push(`${member.uid}:`);
        } else {
          for (const deviceId of deviceIds) {
            entries.push(`${member.uid}:${deviceId}`);
          }
        }
      }
    }
    const unique = Array.from(new Set(entries)).sort();
    if (unique.length === 0) {
      return '';
    }
    return (CryptoJS as any).MD5(unique.join('|')).toString();
  }

  calculateMemberUidHashFromMembers(members: any): string {
    if (!Array.isArray(members) || members.length === 0) {
      return '';
    }
    const unique = Array.from(new Set(
      members
        .filter((member) => member && member.uid)
        .map((member) => String(member.uid)),
    )).sort();
    if (unique.length === 0) {
      return '';
    }
    return (CryptoJS as any).MD5(unique.join('|')).toString();
  }

  private normalizeRotationMemberHash(memberHash: any, members: any): string {
    return this.calculateMemberUidHashFromMembers(members) || this.normalizeMemberHash(memberHash, members);
  }

  private normalizeMemberDeviceIds(member: any): string[] {
    const rawDevices =
      member.devices ||
      member.device_ids ||
      member.deviceIds ||
      member.e2ee_devices ||
      member.e2eeDevices ||
      [];
    const devices = Array.isArray(rawDevices) ? rawDevices : [];
    const ids: string[] = [];
    for (const device of devices) {
      const deviceId =
        device && typeof device === 'object'
          ? device.device_id ?? device.deviceId ?? device.id
          : device;
      if (deviceId !== undefined && deviceId !== null && deviceId !== '') {
        ids.push(String(deviceId));
      }
    }
    return Array.from(new Set(ids)).sort();
  }

  async createSenderKeyState(existingRecord: any) {
    const keyBytes = this.parent.randomBytes(32);
    const curve = await this.parent.getCurve();
    const signingKeyPair = curve.generateKeyPair();
    let nextKeyId = 1;
    if (existingRecord && typeof existingRecord.getState === 'function') {
      const current = existingRecord.getState();
      if (current && typeof current.keyId === 'number') {
        nextKeyId = current.keyId + 1;
      }
    }
    return new SenderKeyState({
      keyId: nextKeyId,
      senderKey: this.parent.toBase64(keyBytes),
      chainKey: this.parent.toBase64(keyBytes),
      messageIndex: 0,
      skipped: {},
      signingPubKey: this.parent.toBase64(signingKeyPair.pubKey),
      signingPrivKey: this.parent.toBase64(signingKeyPair.privKey),
      kdfVersion: 'v2',
    });
  }

  async createSenderKeyRecord(groupId: any, memberHash: any, existingRecord: any) {
    const state = await this.createSenderKeyState(existingRecord);
    let record = existingRecord;
    if (!record) {
      record = new SenderKeyRecord({ memberHash: memberHash || '', states: [] });
    } else {
      record.memberHash = memberHash || record.memberHash || '';
    }
    record.addState(state);
    await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
    return record;
  }

  async loadSenderKeyRecord(groupId: any, senderUid: any, senderDeviceId: any): Promise<SenderKeyRecord | null> {
    if (!groupId || !senderUid) {
      return null;
    }

    const cacheKey = this.getCacheKey(groupId, senderUid, senderDeviceId);

    // 先查缓存
    const cached = this.senderKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 缓存未命中，从存储加载
    const record = await this.signalStore.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);

    // 加入缓存
    if (record) {
      this.senderKeyCache.set(cacheKey, record);
    }

    return record;
  }

  async saveSenderKeyRecord(groupId: any, senderUid: any, record: any, senderDeviceId: any): Promise<void> {
    if (!groupId || !senderUid || !record) {
      return;
    }

    // 保存到存储
    await this.signalStore.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);

    // 更新缓存
    const cacheKey = this.getCacheKey(groupId, senderUid, senderDeviceId);
    this.senderKeyCache.set(cacheKey, record);
  }

  async deleteSenderKeyRecord(groupId: any, senderUid: any, senderDeviceId?: any): Promise<void> {
    await this.signalStore.deleteSenderKeyRecord(groupId, senderUid, senderDeviceId);
  }

  async deleteGroupSenderKeys(groupId: string): Promise<void> {
    await this.signalStore.deleteGroupSenderKeys(groupId);
  }

  async deleteUserSenderKeys(senderUid: string): Promise<void> {
    await this.signalStore.deleteUserSenderKeys(senderUid);
  }

  async prepareGroupSend(groupId: any, members: any, memberHash: any) {
    const startedAt = this.now();
    const lockKey = groupId;
    const prevLock = this.groupEncryptionLocks.get(lockKey) || Promise.resolve();
    const currentLock = prevLock.then(async () => {
      const loadStartedAt = this.now();
      const normalizedMemberHash = this.normalizeRotationMemberHash(memberHash, members);
      let record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);
      const loadMs = this.now() - loadStartedAt;
      const shouldCreateSenderKey = !record || (normalizedMemberHash && record.memberHash !== normalizedMemberHash);
      const shouldReuploadForIdentityRepair = this.shouldReuploadAfterIdentityRepair(groupId, record);
      if (!shouldCreateSenderKey && !shouldReuploadForIdentityRepair) {
        const repairStartedAt = this.now();
        const repairCount = await this.uploadPendingRepairEnvelopes(groupId, record, normalizedMemberHash);
        const repairMs = this.now() - repairStartedAt;
        this.logPerf('prepareGroupSend', {
          groupId,
          memberCount: Array.isArray(members) ? members.length : 0,
          cacheHit: true,
          repairCount,
          loadMs,
          repairMs,
          totalMs: this.now() - startedAt,
        });
        return true;
      }
      const createStartedAt = this.now();
      if (shouldCreateSenderKey) {
        record = await this.createSenderKeyRecord(groupId, normalizedMemberHash, record);
      }
      const createMs = this.now() - createStartedAt;
      const buildStartedAt = this.now();
      const distribution = await this.buildDistributionPayloadForRecord(groupId, record, members, normalizedMemberHash);
      const buildMs = this.now() - buildStartedAt;
      let uploadMs = 0;
      if (distribution) {
        const uploadStartedAt = this.now();
        await this.uploadDistributionEnvelopes(groupId, distribution);
        this.markSenderKeyDistributionPrepared(groupId, record, members, normalizedMemberHash);
        uploadMs = this.now() - uploadStartedAt;
        if (shouldReuploadForIdentityRepair) {
          this.markIdentityRepairDistributionDone(groupId);
        }
      }
      await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
      this.logPerf('prepareGroupSend', {
        groupId,
        memberCount: Array.isArray(members) ? members.length : 0,
        envelopeCount: distribution?.distribution?.ciphertexts?.length || 0,
        cacheHit: false,
        concurrency: Math.max(1, Number((this as any).senderKeyEnvelopeConcurrency || 10)),
        loadMs,
        createMs,
        buildMs,
        uploadMs,
        totalMs: this.now() - startedAt,
      });
      return true;
    });
    this.groupEncryptionLocks.set(lockKey, currentLock.catch(() => undefined));
    return await currentLock;
  }

  async encryptGroupMessage(groupId: any, plaintext: string, members: any, memberHash: any) {
    const startedAt = this.now();
    const prevLock = this.groupEncryptionLocks.get(groupId) || Promise.resolve();
    const currentLock = prevLock.then(async () => {
      const loadStartedAt = this.now();
      const normalizedMemberHash = this.normalizeRotationMemberHash(memberHash, members);
      let record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);
      const loadMs = this.now() - loadStartedAt;
      const shouldCreateSenderKey = !record || (normalizedMemberHash && record.memberHash !== normalizedMemberHash);
      const shouldReuploadForIdentityRepair = this.shouldReuploadAfterIdentityRepair(groupId, record);
      if (shouldCreateSenderKey) {
        const createStartedAt = this.now();
        record = await this.createSenderKeyRecord(groupId, normalizedMemberHash, record);
        this.logPerf('createSenderKeyRecord', {
          groupId,
          memberCount: Array.isArray(members) ? members.length : 0,
          totalMs: this.now() - createStartedAt,
        });
      }
      const encryptStartedAt = this.now();
      const cipher = new GroupCipher(this.parent, record, groupId, this.uid);
      const encryptResult = await cipher.encrypt(plaintext);
      const encryptMs = this.now() - encryptStartedAt;
      const payload: any = { ...encryptResult.payload, sender_device_id: this.deviceId };
      const shouldRetryDistribution =
        this.shouldRetrySenderKeyDistribution(record, payload) &&
        !this.isSenderKeyDistributionPrepared(groupId, record, members, normalizedMemberHash);
      const shouldDistribute = shouldCreateSenderKey || shouldReuploadForIdentityRepair || shouldRetryDistribution;
      let buildMs = 0;
      let uploadMs = 0;
      let envelopeCount = 0;
      let repairCount = 0;
      let repairMs = 0;
      if (shouldDistribute) {
        const buildStartedAt = this.now();
        const distribution = await this.buildDistributionPayloadForRecord(groupId, record, members, normalizedMemberHash);
        buildMs = this.now() - buildStartedAt;
        if (distribution) {
          envelopeCount = distribution?.distribution?.ciphertexts?.length || 0;
          const uploadStartedAt = this.now();
          await this.uploadDistributionEnvelopes(groupId, distribution);
          this.markSenderKeyDistributionPrepared(groupId, record, members, normalizedMemberHash);
          uploadMs = this.now() - uploadStartedAt;
          if (shouldReuploadForIdentityRepair) {
            this.markIdentityRepairDistributionDone(groupId);
          }
        }
      } else {
        const repairStartedAt = this.now();
        repairCount = await this.uploadPendingRepairEnvelopes(groupId, record, normalizedMemberHash);
        repairMs = this.now() - repairStartedAt;
      }
      // console.log("signal_group payload:", {
      //   group_id: payload.group_id,
      //   sender_uid: payload.sender_uid,
      //   sender_device_id: payload.sender_device_id,
      //   key_id: payload.key_id,
      //   signing_pub_key: payload.signing_pub_key,
      // })
      await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
      this.logPerf('encryptGroupMessage', {
        groupId,
        memberCount: Array.isArray(members) ? members.length : 0,
        envelopeCount,
        repairCount,
        distributed: !!shouldDistribute,
        loadMs,
        encryptMs,
        buildMs,
        uploadMs,
        repairMs,
        totalMs: this.now() - startedAt,
      });
      return { type: 0, body: JSON.stringify(payload) };
    });
    this.groupEncryptionLocks.set(
      groupId,
      currentLock.catch(() => undefined),
    );
    return await currentLock;
  }

  async uploadDistributionEnvelopes(groupId: any, distribution: any): Promise<void> {
    if (!this.parent || typeof this.parent.uploadGroupSenderKeyEnvelopes !== 'function') {
      return;
    }
    const ciphertexts = distribution?.distribution?.ciphertexts;
    if (!Array.isArray(ciphertexts) || ciphertexts.length === 0) {
      return;
    }
    const envelopes: any[] = [];
    for (const item of ciphertexts) {
      const recipientUid = item.uid ?? item.recipient_uid ?? item.recipientUid;
      const recipientDeviceId = item.device_id ?? item.deviceId ?? item.recipient_device_id ?? item.recipientDeviceId;
      if (!recipientUid || recipientDeviceId === undefined || recipientDeviceId === null || recipientDeviceId === '') {
        continue;
      }
      envelopes.push({
        recipient_uid: recipientUid,
        recipient_device_id: String(recipientDeviceId),
        envelope: JSON.stringify(item),
      });
    }
    if (envelopes.length === 0) {
      return;
    }
    const uploadCacheKey = this.getSenderKeyEnvelopeUploadCacheKey(groupId, distribution, envelopes);
    const uploadCache = this.getSenderKeyEnvelopeUploadCache();
    if (uploadCacheKey && uploadCache.has(uploadCacheKey)) {
      return;
    }
    if (!this.senderKeyEnvelopeUploadPromises) {
      this.senderKeyEnvelopeUploadPromises = new Map();
    }
    const pendingUpload = uploadCacheKey ? this.senderKeyEnvelopeUploadPromises.get(uploadCacheKey) : undefined;
    if (pendingUpload) {
      await pendingUpload;
      return;
    }
    const doUpload = async () => {
      for (const batch of this.chunkSenderKeyEnvelopes(envelopes)) {
        await this.parent.uploadGroupSenderKeyEnvelopes(
          this.buildCompactSenderKeyEnvelopeUploadPayload(groupId, distribution, batch),
        );
      }
      if (uploadCacheKey) {
        uploadCache.set(uploadCacheKey, true);
      }
    };
    const uploadPromise = doUpload();
    if (uploadCacheKey) {
      this.senderKeyEnvelopeUploadPromises.set(uploadCacheKey, uploadPromise);
    }
    try {
      await uploadPromise;
    } catch (error) {
      console.warn('[GroupManager] upload sender key envelopes failed', error);
      throw error;
    } finally {
      if (uploadCacheKey) {
        this.senderKeyEnvelopeUploadPromises.delete(uploadCacheKey);
      }
    }
  }

  private chunkSenderKeyEnvelopes(envelopes: any[]): any[][] {
    const batchSize = Math.max(1, Number((this as any).senderKeyEnvelopeUploadBatchSize || 100));
    const batches: any[][] = [];
    for (let i = 0; i < envelopes.length; i += batchSize) {
      batches.push(envelopes.slice(i, i + batchSize));
    }
    return batches;
  }

  private buildCompactSenderKeyEnvelopeUploadPayload(groupId: any, distribution: any, envelopes: any[]) {
    return {
      version: 2,
      group_id: groupId,
      sender_uid: this.uid,
      sender_device_id: this.deviceId,
      key_id: distribution.key_id ?? distribution.keyId,
      items: envelopes.map((item) => [
        item.recipient_uid,
        item.recipient_device_id,
        item.envelope,
      ]),
    };
  }

  async uploadPendingRepairEnvelopes(groupId: any, record: any, memberHash: string, options: { background?: boolean } = {}): Promise<number> {
    if (!this.parent || typeof this.parent.lookupGroupSenderKeyRepairRequests !== 'function') {
      return 0;
    }
    const state = record && typeof record.getState === 'function' ? record.getState() : null;
    if (!groupId || !state || !state.keyId) {
      return 0;
    }
    const cacheKey = this.getSenderKeyRepairRequestCacheKey(groupId, state.keyId);
    const cache = this.getSenderKeyRepairRequestCache();
    if (cache.has(cacheKey)) {
      return 0;
    }
    let resp: any;
    try {
      resp = await this.parent.lookupGroupSenderKeyRepairRequests({
        group_id: groupId,
        sender_uid: this.uid,
        sender_device_id: this.deviceId,
        key_id: state.keyId,
        limit: 500,
      });
    } catch (error) {
      const config = E2EEConfigManager.getInstance().getConfig();
      if (config.debugEnabled || config.verboseLogging) {
        console.warn('[GroupManager] lookup sender key repair requests failed', error);
      }
      return 0;
    }
    const requests = this.normalizeRepairRequests(resp);
    if (requests.length === 0) {
      cache.set(cacheKey, true);
      return 0;
    }
    const members = this.repairRequestsToMembers(requests);
    if (members.length === 0) {
      cache.set(cacheKey, true);
      return 0;
    }
    const distribution = await this.buildDistributionPayloadForRecord(groupId, record, members, memberHash || record.memberHash || '');
    if (!distribution) {
      return 0;
    }
    await this.uploadDistributionEnvelopes(groupId, distribution);
    const repairedCount = members.reduce((total, member) => total + this.normalizeMemberDeviceIds(member).length, 0);
    const hasMore = !!(resp?.has_more || resp?.hasMore || resp?.data?.has_more || resp?.data?.hasMore);
    if (hasMore) {
      setTimeout(() => {
        this.uploadPendingRepairEnvelopes(groupId, record, memberHash || record.memberHash || '', { background: true })
          .catch((error) => {
            const config = E2EEConfigManager.getInstance().getConfig();
            if (config.debugEnabled || config.verboseLogging) {
              console.warn('[GroupManager] background drain sender key repair requests failed', error);
            }
          });
      }, options.background ? 1000 : 100);
    } else {
      cache.set(cacheKey, true);
    }
    return repairedCount;
  }

  private normalizeRepairRequests(resp: any): any[] {
    const raw =
      Array.isArray(resp) ? resp :
      Array.isArray(resp?.requests) ? resp.requests :
      Array.isArray(resp?.data?.requests) ? resp.data.requests :
      Array.isArray(resp?.data) ? resp.data :
      [];
    const dedup = new Map<string, any>();
    for (const item of raw) {
      const uid = item?.recipient_uid ?? item?.recipientUid ?? item?.uid;
      const deviceId = item?.recipient_device_id ?? item?.recipientDeviceId ?? item?.device_id ?? item?.deviceId;
      if (!uid || deviceId === undefined || deviceId === null || deviceId === '') {
        continue;
      }
      dedup.set(`${uid}:${deviceId}`, {
        uid,
        device_id: String(deviceId),
      });
    }
    return Array.from(dedup.values());
  }

  private repairRequestsToMembers(requests: any[]): any[] {
    const byUid = new Map<string, any[]>();
    for (const request of requests) {
      const uid = request.uid ?? request.recipient_uid ?? request.recipientUid;
      const deviceId = request.device_id ?? request.deviceId ?? request.recipient_device_id ?? request.recipientDeviceId;
      if (!uid || deviceId === undefined || deviceId === null || deviceId === '') {
        continue;
      }
      const devices = byUid.get(uid) || [];
      devices.push({ device_id: String(deviceId) });
      byUid.set(uid, devices);
    }
    return Array.from(byUid.entries()).map(([uid, devices]) => ({
      uid,
      devices,
    }));
  }

  private getSenderKeyRepairRequestCacheKey(groupId: any, keyId: any): string {
    return `repair:${groupId}:${this.uid}:${this.deviceId}:${keyId}`;
  }

  // invalidateGroupRepairRequestCache 清除某群的 repair 请求去抖缓存，使下次发送重新轮询 repair 请求。
  // 在收到“设备集变更”提示后调用，避免 30s 去抖窗口内新加入设备的 repair 请求被忽略。
  invalidateGroupRepairRequestCache(groupId: any): void {
    if (!groupId || !this.senderKeyRepairRequestCache) {
      return;
    }
    const prefix = `repair:${groupId}:`;
    for (const key of this.senderKeyRepairRequestCache.keys()) {
      if (typeof key === 'string' && key.indexOf(prefix) === 0) {
        this.senderKeyRepairRequestCache.delete(key);
      }
    }
  }

  private getSenderKeyRepairRequestCache(): SmartLRUCache<string, boolean> {
    if (!this.senderKeyRepairRequestCache) {
      this.senderKeyRepairRequestCache = new SmartLRUCache({
        maxSize: 5000,
        ttlMs: 30 * 1000,
      });
    }
    return this.senderKeyRepairRequestCache;
  }

  private getSenderKeyEnvelopeUploadCache(): SmartLRUCache<string, boolean> {
    if (!this.senderKeyEnvelopeUploadCache) {
      const config = E2EEConfigManager.getInstance().getConfig();
      this.senderKeyEnvelopeUploadCache = new SmartLRUCache({
        maxSize: config.maxDistributionCacheSize,
        ttlMs: config.senderKeyEnvelopeUploadCacheTTL,
      });
    }
    return this.senderKeyEnvelopeUploadCache;
  }

  private getSenderKeyDistributionPreparedCache(): SmartLRUCache<string, boolean> {
    if (!this.senderKeyDistributionPreparedCache) {
      const config = E2EEConfigManager.getInstance().getConfig();
      this.senderKeyDistributionPreparedCache = new SmartLRUCache({
        maxSize: config.maxDistributionCacheSize,
        ttlMs: Math.max(Number(config.senderKeyEnvelopeUploadCacheTTL || 0), 5 * 60 * 1000),
      });
    }
    return this.senderKeyDistributionPreparedCache;
  }

  markSenderKeyDistributionPrepared(groupId: any, record: any, members: any[], memberHash: string): void {
    const key = this.getSenderKeyDistributionPreparedKey(groupId, record, members, memberHash);
    if (key) {
      this.getSenderKeyDistributionPreparedCache().set(key, true);
    }
    const senderKey = this.getSenderKeyDistributionPreparedKey(groupId, record, [], '');
    if (senderKey) {
      this.getSenderKeyDistributionPreparedCache().set(senderKey, true);
    }
  }

  private isSenderKeyDistributionPrepared(groupId: any, record: any, members: any[], memberHash: string): boolean {
    const key = this.getSenderKeyDistributionPreparedKey(groupId, record, members, memberHash);
    if (key && this.getSenderKeyDistributionPreparedCache().get(key)) {
      return true;
    }
    const senderKey = this.getSenderKeyDistributionPreparedKey(groupId, record, [], '');
    return !!(senderKey && this.getSenderKeyDistributionPreparedCache().get(senderKey));
  }

  private getSenderKeyDistributionPreparedKey(groupId: any, record: any, members: any[], memberHash: string): string {
    const state: any = record && typeof record.getState === 'function' ? record.getState() : null;
    const keyId = state && state.keyId;
    if (!groupId || keyId === undefined || keyId === null || keyId === '') {
      return '';
    }
    const deviceSetHash = this.calculateMemberHashFromMembers(members) || this.normalizeMemberHash(memberHash, members);
    return `${groupId}:${this.uid}:${this.deviceId}:${keyId}:${deviceSetHash || ''}`;
  }

  private getSenderKeyEnvelopeUploadCacheKey(groupId: any, distribution: any, envelopes: any[]): string {
    const keyId = distribution?.key_id ?? distribution?.keyId;
    if (keyId === undefined || keyId === null || keyId === '') {
      return '';
    }
    const memberHash = distribution?.member_hash ?? distribution?.memberHash ?? '';
    const recipients = envelopes
      .map((item) => `${item.recipient_uid}:${item.recipient_device_id}`)
      .sort()
      .join('|');
    const recipientsHash = (CryptoJS as any).MD5(recipients).toString();
    return `${groupId}:${this.uid}:${this.deviceId}:${keyId}:${memberHash}:${recipientsHash}`;
  }

  shouldRetrySenderKeyDistribution(record: any, payload: any): boolean {
    const state: any = record && typeof record.getState === 'function' ? record.getState() : null;
    if (!state || typeof payload?.msg_index !== 'number') {
      return false;
    }
    if (state.keyId !== payload.key_id) {
      return false;
    }
    if (payload.msg_index < this.senderKeyDistributionRetryWindow) {
      return true;
    }
    const interval = Math.max(0, Number((this as any).senderKeyDistributionInterval || 0));
    return interval > 0 && payload.msg_index > 0 && payload.msg_index % interval === 0;
  }

  private async buildEnvelopeCiphertextsForMembers(members: any[], distributionPlain: string, logPrefix: string): Promise<any[]> {
    const validMembers = (Array.isArray(members) ? members : []).filter((member) => member && member.uid);
    if (validMembers.length === 0) {
      return [];
    }
    const concurrency = Math.min(
      validMembers.length,
      Math.max(1, Number((this as any).senderKeyEnvelopeConcurrency || 10)),
    );
    const results: any[][] = new Array(validMembers.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < validMembers.length) {
        const index = nextIndex++;
        const member = validMembers[index];
        const ciphertexts: any[] = [];
        try {
          const ct = await this.parent.encryptGroupDistributionForDevice(member.uid, distributionPlain, member.devices);
          if (ct && Array.isArray(ct)) {
            for (const item of ct) {
              if (item.enc === 'aes-256-gcm') {
                ciphertexts.push({
                  ...item,
                  uid: member.uid,
                  is_ecies: true,
                });
              } else {
                ciphertexts.push({ uid: member.uid, device_id: item.device_id, type: item.type, body: item.body });
              }
            }
          }
        } catch (e) {
          console.error(`[GroupManager] ${logPrefix} failed for ${member.uid}:`, e);
        }
        results[index] = ciphertexts;
      }
    };
    await Promise.all(new Array(concurrency).fill(0).map(() => worker()));
    return ([] as any[]).concat(...results.filter(Boolean));
  }

  async buildDistributionPayloadForRecord(groupId: any, record: any, members: any, normalizedMemberHash: string) {
    const state: any = record && record.getState();
    if (!state || !Array.isArray(members) || members.length === 0) {
      return null;
    }
    const distributionMessage = new SenderKeyDistributionMessage({
      groupId,
      senderUid: this.uid,
      senderDeviceId: this.deviceId,
      keyId: state.keyId,
      senderKey: state.senderKey,
      signingPubKey: state.signingPubKey,
      memberHash: normalizedMemberHash || '',
      kdfVersion: state.kdfVersion,
    });
    const distributionPlain = distributionMessage.toString();
    const ciphertexts = await this.buildEnvelopeCiphertextsForMembers(
      members,
      distributionPlain,
      'Encrypt inline distribution',
    );
    if (ciphertexts.length === 0) {
      return null;
    }
    return {
      type: 'signal_group_distribution',
      group_id: groupId,
      sender_uid: this.uid,
      sender_device_id: this.deviceId,
      key_id: state.keyId,
      version: state.keyId,
      member_hash: normalizedMemberHash || '',
      kdf_ver: state.kdfVersion,
      distribution: { type: 'signal_multi', ciphertexts },
    };
  }

  async buildGroupDistributionMessage(groupId: any, memberHash: any, forceNewKey: boolean) {
    const normalizedMemberHash = this.normalizeMemberHash(memberHash, []);
    let record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);
    if (forceNewKey || !record) {
      record = await this.createSenderKeyRecord(groupId, normalizedMemberHash, record);
    }
    const state: any = record.getState();
    if (!state) {
      return null;
    }
    const distributionMessage = new SenderKeyDistributionMessage({
      groupId,
      senderUid: this.uid,
      senderDeviceId: this.deviceId,
      keyId: state.keyId,
      senderKey: state.senderKey,
      signingPubKey: state.signingPubKey,
      memberHash: normalizedMemberHash || '',
      kdfVersion: state.kdfVersion,
    });
    const distributionPlain = distributionMessage.toString();
    await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
    return {
      plain: distributionPlain,
      keyId: state.keyId,
      memberHash: normalizedMemberHash || '',
      kdfVersion: state.kdfVersion,
    };
  }

  async encryptGroupDistribution(groupId: any, members: any, memberHash: any, forceNewKey: boolean) {
    const normalizedMemberHash = this.normalizeMemberHash(memberHash, members);
    let record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);
    if (forceNewKey || !record) {
      record = await this.createSenderKeyRecord(groupId, normalizedMemberHash, record);
    } else {
      return null;
    }
    const state: any = record.getState();
    if (!state) {
      return null;
    }
    if (!Array.isArray(members) || members.length === 0) {
      return null;
    }
    const distributionMessage = new SenderKeyDistributionMessage({
      groupId,
      senderUid: this.uid,
      senderDeviceId: this.deviceId,
      keyId: state.keyId,
      senderKey: state.senderKey,
      signingPubKey: state.signingPubKey,
      memberHash: normalizedMemberHash || '',
      kdfVersion: state.kdfVersion,
    });
    const distributionPlain = distributionMessage.toString();
    const ciphertexts = await this.buildEnvelopeCiphertextsForMembers(
      members,
      distributionPlain,
      'Encrypt distribution',
    );
    if (ciphertexts.length === 0) {
      return null;
    }
    const payload = {
      type: 'signal_group_distribution',
      group_id: groupId,
      sender_uid: this.uid,
      sender_device_id: this.deviceId,
      key_id: state.keyId,
      version: state.keyId,
      member_hash: normalizedMemberHash || '',
      kdf_ver: state.kdfVersion,
      distribution: { type: 'signal_multi', ciphertexts },
    };
    await this.uploadDistributionEnvelopes(groupId, payload);
    await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
    return {
      type: 0,
      body: JSON.stringify({
        type: payload.type,
        group_id: payload.group_id,
        sender_uid: payload.sender_uid,
        sender_device_id: payload.sender_device_id,
        key_id: payload.key_id,
        version: payload.version,
        member_hash: payload.member_hash,
        kdf_ver: payload.kdf_ver,
      }),
    };
  }

  async decryptGroupMessageObject(obj: any, remoteUid: string, remoteDeviceId: any) {
    const groupId = obj.group_id;
    const senderUid = obj.sender_uid || remoteUid;
    const senderDeviceId =
      obj.sender_device_id !== undefined && obj.sender_device_id !== null ? obj.sender_device_id : remoteDeviceId;
    let record: any = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
    if (obj.distribution && Array.isArray(obj.distribution.ciphertexts)) {
      const matched = this.parent.selectCiphertextForDevice(obj.distribution.ciphertexts, this.uid, this.deviceId);
      let distributionPlain: any = null;
      if (matched) {
        try {
          if (obj.distribution.type === 'ecies_multi' || matched.is_ecies) {
            distributionPlain = await this.parent.decryptGroupDistributionForDevice(matched);
          } else {
            distributionPlain = await this.parent.decryptSignalCipherMessage(
              senderUid,
              senderDeviceId,
              matched.type,
              matched.body,
            );
          }
        } catch (e) {
          console.log(
            'decryptGroupMessageObject distribution decrypt failed',
            {
              sender_uid: senderUid,
              sender_device_id: senderDeviceId,
              message_type: matched.type,
            },
            e,
          );
          distributionPlain = null;
        }
        if (!distributionPlain) {
          const recovered = await this.recoverSenderKeyFromEnvelope(obj, senderUid, senderDeviceId);
          if (recovered) {
            record = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
          }
        }
      }
      if (distributionPlain) {
        try {
          const distributionMessage = SenderKeyDistributionMessage.fromString(distributionPlain);
          if (distributionMessage) {
            const newState = SenderKeyState.fromDistribution(distributionMessage);
            console.log('signal_group_distribution saved:', {
              group_id: (distributionMessage as any).groupId,
              sender_uid: (distributionMessage as any).senderUid,
              sender_device_id: (distributionMessage as any).senderDeviceId,
              key_id: (distributionMessage as any).keyId,
              signing_pub_key: (distributionMessage as any).signingPubKey,
            });
            if (!record) {
              record = new SenderKeyRecord({
                memberHash: (distributionMessage as any).memberHash || '',
                states: [newState],
              });
            } else {
              record.memberHash = (distributionMessage as any).memberHash || record.memberHash || '';
              record.addState(newState);
            }
            await this.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);
          }
        } catch (e) {
          console.error(`[GroupManager] Failed to process distribution message for ${groupId}`, e);
        }
      }
    }
    if (!this.hasSenderKeyState(record, obj?.key_id)) {
      const recovered = await this.recoverSenderKeyFromEnvelope(obj, senderUid, senderDeviceId);
      if (recovered) {
        record = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
      }
    }
    if (!record) {
      throw new Error('Missing sender key');
    }
    const cipher = new GroupCipher(this.parent, record, groupId, senderUid);
    let plaintext: any;
    try {
      plaintext = await cipher.decrypt(obj);
    } catch (error) {
      if (!this.isMissingMessageKeyError(error)) {
        throw error;
      }
      const recovered = await this.recoverSenderKeyFromEnvelope(obj, senderUid, senderDeviceId);
      if (!recovered) {
        throw error;
      }
      record = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
      if (!record) {
        throw error;
      }
      const retryCipher = new GroupCipher(this.parent, record, groupId, senderUid);
      plaintext = await retryCipher.decrypt(obj);
    }
    this.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);
    return plaintext;
  }

  private hasSenderKeyState(record: any, keyId: any): boolean {
    if (!record || keyId === undefined || keyId === null || keyId === '') {
      return false;
    }
    if (typeof record.getStateByKeyId !== 'function') {
      return true;
    }
    return !!record.getStateByKeyId(keyId);
  }

  async recoverSenderKeyFromEnvelope(
    obj: any,
    senderUid: string,
    senderDeviceId: any,
    options: { force?: boolean; reason?: string } = {},
  ): Promise<boolean> {
    if (!this.parent || typeof this.parent.lookupGroupSenderKeyEnvelope !== 'function') {
      return false;
    }
    const groupId = obj?.group_id;
    const keyId = obj?.key_id;
    if (!groupId || !senderUid || !senderDeviceId || !keyId) {
      return false;
    }
    if (!this.groupEnvelopeRecoveryPromises) {
      this.groupEnvelopeRecoveryPromises = new Map();
    }
    const recoveryKey = `${groupId}:${senderUid}:${senderDeviceId}:${keyId}:${this.uid}:${this.deviceId}`;
    if (!options.force && (this.getSenderKeyEnvelopeMissingCache().get(recoveryKey) || this.getPersistentSenderKeyEnvelopeMissing(recoveryKey))) {
      return false;
    }
    const forceLookupCache = this.getSenderKeyEnvelopeForceLookupCache();
    if (options.force && forceLookupCache.get(recoveryKey)) {
      return false;
    }
    const existing = this.groupEnvelopeRecoveryPromises.get(recoveryKey);
    if (existing) {
      return existing;
    }
    const repairPayload = {
      group_id: groupId,
      sender_uid: senderUid,
      sender_device_id: senderDeviceId,
      key_id: keyId,
      recipient_uid: this.uid,
      recipient_device_id: this.deviceId,
      reason: options.reason || 'missing_sender_key',
    };
    const promise = this.doRecoverSenderKeyFromEnvelope(groupId, senderUid, senderDeviceId, keyId)
      .then(async (recovered) => {
        if (!recovered) {
          if (options.force) {
            forceLookupCache.set(recoveryKey, true);
          } else if (!this.isWithinFirstLoginGrace()) {
            this.markSenderKeyEnvelopeMissing(recoveryKey);
          }
          await this.requestSenderKeyRepair(repairPayload);
        }
        return recovered;
      })
      .catch((error) => {
        if (options.force) {
          forceLookupCache.set(recoveryKey, true);
        }
        if (this.shouldCacheEnvelopeLookupFailure(error, options)) {
          this.markSenderKeyEnvelopeMissing(recoveryKey);
        }
        const config = E2EEConfigManager.getInstance().getConfig();
        if (config.debugEnabled || config.verboseLogging) {
          console.warn('[GroupManager] recover sender key envelope failed', error);
        }
        return this.requestSenderKeyRepair(repairPayload).then(() => false);
      })
      .finally(() => {
        this.groupEnvelopeRecoveryPromises.delete(recoveryKey);
      });
    this.groupEnvelopeRecoveryPromises.set(recoveryKey, promise);
    return promise;
  }

  private async requestSenderKeyRepair(payload: any): Promise<void> {
    if (!this.parent || typeof this.parent.requestGroupSenderKeyRepair !== 'function') {
      return;
    }
    const cacheKey = `request:${payload.group_id}:${payload.sender_uid}:${payload.sender_device_id}:${payload.key_id}:${payload.recipient_uid}:${payload.recipient_device_id}`;
    const requestCache = this.getSenderKeyRepairRequestCache();
    if (requestCache.get(cacheKey)) {
      return;
    }
    requestCache.set(cacheKey, true);
    if (typeof this.parent.requestGroupSenderKeyRepairBatch === 'function') {
      return this.enqueueSenderKeyRepairRequest(cacheKey, payload);
    }
    try {
      await this.parent.requestGroupSenderKeyRepair(payload);
    } catch (error) {
      const config = E2EEConfigManager.getInstance().getConfig();
      if (config.debugEnabled || config.verboseLogging) {
        console.warn('[GroupManager] request sender key repair failed', error);
      }
    }
  }

  private enqueueSenderKeyRepairRequest(cacheKey: string, payload: any): Promise<void> {
    if (!this.senderKeyRepairBatchQueue) {
      this.senderKeyRepairBatchQueue = new Map();
    }
    return new Promise((resolve) => {
      const existing = this.senderKeyRepairBatchQueue.get(cacheKey);
      if (existing) {
        existing.resolvers.push(resolve);
      } else {
        this.senderKeyRepairBatchQueue.set(cacheKey, {
          payload,
          resolvers: [resolve],
        });
      }
      if (this.senderKeyRepairBatchQueue.size >= 100) {
        this.flushSenderKeyRepairBatchQueue();
        return;
      }
      if (!this.senderKeyRepairBatchTimer) {
        this.senderKeyRepairBatchTimer = setTimeout(() => {
          this.senderKeyRepairBatchTimer = null;
          this.flushSenderKeyRepairBatchQueue();
        }, 50);
      }
    });
  }

  private async flushSenderKeyRepairBatchQueue(): Promise<void> {
    if (!this.senderKeyRepairBatchQueue || this.senderKeyRepairBatchQueue.size <= 0) {
      return;
    }
    if (this.senderKeyRepairBatchTimer) {
      clearTimeout(this.senderKeyRepairBatchTimer);
      this.senderKeyRepairBatchTimer = null;
    }
    const entries = Array.from(this.senderKeyRepairBatchQueue.values());
    this.senderKeyRepairBatchQueue.clear();
    const requests = entries.map((entry) => entry.payload);
    try {
      await this.parent.requestGroupSenderKeyRepairBatch({ requests });
    } catch (error) {
      await Promise.all(requests.map(async (request) => {
        try {
          await this.parent.requestGroupSenderKeyRepair(request);
        } catch (fallbackError) {
          const config = E2EEConfigManager.getInstance().getConfig();
          if (config.debugEnabled || config.verboseLogging) {
            console.warn('[GroupManager] request sender key repair fallback failed', fallbackError);
          }
        }
      }));
    } finally {
      entries.forEach((entry) => {
        entry.resolvers.forEach((resolve: any) => resolve());
      });
    }
  }

  private getSenderKeyEnvelopeMissingCache(): SmartLRUCache<string, boolean> {
    if (!this.senderKeyEnvelopeMissingCache) {
      this.senderKeyEnvelopeMissingCache = new SmartLRUCache({
        maxSize: 5000,
        ttlMs: 60 * 1000,
      });
    }
    return this.senderKeyEnvelopeMissingCache;
  }

  private getSenderKeyEnvelopeForceLookupCache(): SmartLRUCache<string, boolean> {
    if (!this.senderKeyEnvelopeForceLookupCache) {
      const cooldownMs = Math.max(1, Number((this as any).senderKeyEnvelopeForceLookupCooldownMs || 1000));
      this.senderKeyEnvelopeForceLookupCache = new SmartLRUCache({
        maxSize: 5000,
        ttlMs: cooldownMs,
      });
    }
    return this.senderKeyEnvelopeForceLookupCache;
  }

  private markSenderKeyEnvelopeMissing(recoveryKey: string) {
    this.getSenderKeyEnvelopeMissingCache().set(recoveryKey, true);
    this.setPersistentSenderKeyEnvelopeMissing(recoveryKey);
  }

  private getPersistentSenderKeyEnvelopeMissingKey(recoveryKey: string): string {
    return `${this.getPersistentSenderKeyEnvelopeMissingPrefix()}${encodeURIComponent(recoveryKey)}`;
  }

  private getPersistentSenderKeyEnvelopeMissingPrefix(): string {
    return `e2ee_sender_key_envelope_missing:${this.uid || ''}:${this.deviceId || ''}:`;
  }

  private getPersistentSenderKeyEnvelopeMissing(recoveryKey: string): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }
    const key = this.getPersistentSenderKeyEnvelopeMissingKey(recoveryKey);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || Number(parsed.expiresAt || 0) <= Date.now()) {
        localStorage.removeItem(key);
        return false;
      }
      this.getSenderKeyEnvelopeMissingCache().set(recoveryKey, true);
      return true;
    } catch (_) {
      localStorage.removeItem(key);
      return false;
    }
  }

  private setPersistentSenderKeyEnvelopeMissing(recoveryKey: string) {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.getPersistentSenderKeyEnvelopeMissingKey(recoveryKey), JSON.stringify({
        expiresAt: Date.now() + Math.max(1000, Number(this.senderKeyEnvelopeMissingPersistentTtlMs || 5 * 60 * 1000)),
      }));
    } catch (_) {
      // Ignore storage quota/private-mode failures; the in-memory cache still protects this page lifetime.
    }
  }

  private clearPersistentSenderKeyEnvelopeMissingCache() {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const prefix = this.getPersistentSenderKeyEnvelopeMissingPrefix();
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        keys.push(key);
      }
    }
    keys.forEach((key) => localStorage.removeItem(key));
  }

  private async doRecoverSenderKeyFromEnvelope(groupId: any, senderUid: string, senderDeviceId: any, keyId: any): Promise<boolean> {
    const resp = await this.lookupGroupSenderKeyEnvelopeWithRetry({
      group_id: groupId,
      sender_uid: senderUid,
      sender_device_id: senderDeviceId,
      key_id: keyId,
      recipient_uid: this.uid,
      recipient_device_id: this.deviceId,
    });
    const rawEnvelope = resp?.envelope ?? resp?.data?.envelope;
    if (!rawEnvelope) {
      return false;
    }
    const envelope = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
    let distributionPlain: any = null;
    if (envelope.is_ecies || envelope.enc === 'aes-256-gcm') {
      distributionPlain = await this.parent.decryptGroupDistributionForDevice(envelope);
    } else {
      distributionPlain = await this.parent.decryptSignalCipherMessage(senderUid, senderDeviceId, envelope.type, envelope.body);
    }
    const distributionMessage = SenderKeyDistributionMessage.fromString(distributionPlain);
    if (!distributionMessage) {
      return false;
    }
    const newState = SenderKeyState.fromDistribution(distributionMessage);
    let record: any = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
    if (!record) {
      record = new SenderKeyRecord({
        memberHash: (distributionMessage as any).memberHash || '',
        states: [],
      });
    } else {
      record.memberHash = (distributionMessage as any).memberHash || record.memberHash || '';
    }
    record.addState(newState);
    await this.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);
    return true;
  }

  private async lookupGroupSenderKeyEnvelopeWithRetry(payload: any): Promise<any> {
    const maxAttempts = Math.max(1, Number((this as any).senderKeyEnvelopeRecoveryMaxAttempts || 3));
    const baseDelay = Math.max(1, Number((this as any).senderKeyEnvelopeRecoveryBaseDelayMs || 1000));
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.parent && typeof this.parent.lookupGroupSenderKeyEnvelopeBatch === 'function') {
          return await this.enqueueGroupSenderKeyEnvelopeLookup(payload);
        }
        return await this.parent.lookupGroupSenderKeyEnvelope(payload);
      } catch (error) {
        lastError = error;
        if (this.shouldStopEnvelopeLookupRetry(error) || attempt >= maxAttempts) {
          throw error;
        }
        await this.delay(Math.min(baseDelay * Math.pow(2, attempt - 1), 30000));
      }
    }
    throw lastError;
  }

  private enqueueGroupSenderKeyEnvelopeLookup(payload: any): Promise<any> {
    const cacheKey = this.groupSenderKeyEnvelopeLookupCacheKey(payload);
    return new Promise((resolve, reject) => {
      const existing = this.senderKeyEnvelopeLookupBatchQueue.get(cacheKey);
      if (existing) {
        existing.resolvers.push(resolve);
        existing.rejecters.push(reject);
      } else {
        this.senderKeyEnvelopeLookupBatchQueue.set(cacheKey, {
          payload,
          resolvers: [resolve],
          rejecters: [reject],
        });
      }
      if (this.senderKeyEnvelopeLookupBatchQueue.size >= 50) {
        this.flushGroupSenderKeyEnvelopeLookupBatchQueue();
        return;
      }
      if (!this.senderKeyEnvelopeLookupBatchTimer) {
        this.senderKeyEnvelopeLookupBatchTimer = setTimeout(() => {
          this.senderKeyEnvelopeLookupBatchTimer = null;
          this.flushGroupSenderKeyEnvelopeLookupBatchQueue();
        }, 25);
      }
    });
  }

  private async flushGroupSenderKeyEnvelopeLookupBatchQueue(): Promise<void> {
    if (!this.senderKeyEnvelopeLookupBatchQueue || this.senderKeyEnvelopeLookupBatchQueue.size <= 0) {
      return;
    }
    if (this.senderKeyEnvelopeLookupBatchTimer) {
      clearTimeout(this.senderKeyEnvelopeLookupBatchTimer);
      this.senderKeyEnvelopeLookupBatchTimer = null;
    }
    const entries = Array.from(this.senderKeyEnvelopeLookupBatchQueue.values());
    this.senderKeyEnvelopeLookupBatchQueue.clear();
    const requests = entries.map((entry) => entry.payload);
    try {
      const resp = await this.parent.lookupGroupSenderKeyEnvelopeBatch({ requests });
      const results = Array.isArray(resp?.results) ? resp.results : [];
      const byKey = new Map<string, any>();
      results.forEach((item: any) => {
        if (item && item.request) {
          byKey.set(this.groupSenderKeyEnvelopeLookupCacheKey(item.request), item);
        }
      });
      entries.forEach((entry) => {
        const result = byKey.get(this.groupSenderKeyEnvelopeLookupCacheKey(entry.payload));
        const value = result?.found ? result.envelope : null;
        entry.resolvers.forEach((resolve: any) => resolve(value));
      });
    } catch (error) {
      await Promise.all(entries.map(async (entry) => {
        try {
          const fallback = await this.parent.lookupGroupSenderKeyEnvelope(entry.payload);
          entry.resolvers.forEach((resolve: any) => resolve(fallback));
        } catch (fallbackError) {
          entry.rejecters.forEach((reject: any) => reject(fallbackError));
        }
      }));
    }
  }

  private groupSenderKeyEnvelopeLookupCacheKey(payload: any): string {
    return [
      payload?.group_id || '',
      payload?.sender_uid || '',
      payload?.sender_device_id || '',
      payload?.key_id || '',
      payload?.recipient_uid || '',
      payload?.recipient_device_id || '',
    ].join('\x00');
  }

  private isPermanentEnvelopeLookupError(error: any): boolean {
    const status = Number(error?.status ?? error?.code ?? error?.response?.status ?? 0);
    if (status === 403) {
      return true;
    }
    return status === 404 && !this.isWithinFirstLoginGrace();
  }

  private shouldCacheEnvelopeLookupFailure(error: any, options: { force?: boolean; reason?: string } = {}): boolean {
    if (options.force && this.isEnvelopeNotReadyError(error)) {
      return false;
    }
    return this.isPermanentEnvelopeLookupError(error);
  }

  private shouldStopEnvelopeLookupRetry(error: any): boolean {
    if (this.isEnvelopeNotReadyError(error) && this.isWithinFirstLoginGrace()) {
      return false;
    }
    return this.isPermanentEnvelopeLookupError(error);
  }

  private isEnvelopeNotReadyError(error: any): boolean {
    const status = Number(error?.status ?? error?.code ?? error?.response?.status ?? 0);
    return status === 404;
  }

  private isWithinFirstLoginGrace(): boolean {
    return Date.now() < Number((this as any).firstLoginGraceUntil || 0);
  }

  private isMissingMessageKeyError(error: any): boolean {
    return String(error?.message || error || '').indexOf('Missing message key') >= 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logPerf(action: string, stats: any) {
    const config = E2EEConfigManager.getInstance().getConfig();
    if (!config.debugEnabled && !config.verboseLogging) {
      return;
    }
    const rounded: any = { ...stats };
    for (const key of ['loadMs', 'createMs', 'encryptMs', 'buildMs', 'uploadMs', 'totalMs']) {
      if (typeof rounded[key] === 'number') {
        rounded[key] = Math.round(rounded[key] * 100) / 100;
      }
    }
    console.info(`[E2EE][perf][${action}]`, rounded);
  }

  private now(): number {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  async decryptGroupDistributionObject(obj: any, remoteUid: string, remoteDeviceId: any) {
    const groupId = obj.group_id;
    const senderUid = obj.sender_uid || remoteUid;
    const senderDeviceId =
      obj.sender_device_id !== undefined && obj.sender_device_id !== null ? obj.sender_device_id : remoteDeviceId;
    let record: any = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
    if (obj.distribution && Array.isArray(obj.distribution.ciphertexts)) {
      const matched = this.parent.selectCiphertextForDevice(obj.distribution.ciphertexts, this.uid, this.deviceId);
      if (!matched) {
        console.warn('[GroupManager] decryptGroupDistributionObject: 未找到匹配的设备 ciphertext', {
          group_id: groupId,
          my_uid: this.uid,
          my_device_id: this.deviceId,
          ciphertext_count: obj.distribution.ciphertexts.length,
          ciphertext_devices: obj.distribution.ciphertexts.map((c: any) => c.device_id ?? c.deviceId ?? c.id),
        });
      }
      if (matched) {
        let distributionPlain: any = null;
        try {
          if (obj.distribution.type === 'ecies_multi' || matched.is_ecies) {
            distributionPlain = await this.parent.decryptGroupDistributionForDevice(matched);
          } else {
            distributionPlain = await this.parent.decryptSignalCipherMessage(
              senderUid,
              senderDeviceId,
              matched.type,
              matched.body,
            );
          }
        } catch (e) {
          console.log(
            'decryptGroupDistributionObject decrypt failed',
            {
              sender_uid: senderUid,
              sender_device_id: senderDeviceId,
              message_type: matched.type,
            },
            e,
          );
          throw e;
        }
        try {
          const distributionMessage = SenderKeyDistributionMessage.fromString(distributionPlain);
          if (distributionMessage) {
            const newState = SenderKeyState.fromDistribution(distributionMessage);
            console.log('[GroupManager] signal_group_distribution saved:', {
              group_id: groupId,
              sender_uid: senderUid,
              sender_device_id: senderDeviceId,
              key_id: (distributionMessage as any).keyId,
            });
            if (!record) {
              record = new SenderKeyRecord({
                memberHash: (distributionMessage as any).memberHash || '',
                states: [newState],
              });
            } else {
              record.memberHash = (distributionMessage as any).memberHash || record.memberHash || '';
              record.addState(newState);
            }
            await this.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);
          }
        } catch (e) {
          console.error(`[GroupManager] Failed to process distribution object for ${groupId}`, e);
        }
      }
    }
  }

  getStatesByKeyIds(record: SenderKeyRecord, keyIds: number[]): SenderKeyState[] {
    if (!record || !keyIds || keyIds.length === 0) {
      return [];
    }

    const states: SenderKeyState[] = [];
    for (const keyId of keyIds) {
      const state = record.getStateByKeyId(keyId);
      if (state) {
        states.push(state);
      }
    }

    return states;
  }

  async buildGroupDistributionBatch(groupId: any, memberHash: any, keyIds?: number[]) {
    const normalizedMemberHash = this.normalizeMemberHash(memberHash, []);
    const record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);

    if (!record || record.states.length === 0) {
      console.warn(`[GroupManager] No sender key record found for group ${groupId}`);
      return null;
    }

    // 构建分布数据（不包含加密）
    const distributions: {
      key_id: number;
      member_hash: string;
      kdf_ver: string;
      distribution_plain?: string;
      error?: string;
    }[] = [];

    if (keyIds && keyIds.length > 0) {
      // 查找指定指定 key_id 的 state
      for (const keyId of keyIds) {
        const state = record.getStateByKeyId(keyId);
        if (state) {
          const distributionMessage = new SenderKeyDistributionMessage({
            groupId,
            senderUid: this.uid,
            senderDeviceId: this.deviceId,
            keyId: state.keyId,
            senderKey: state.senderKey,
            signingPubKey: state.signingPubKey,
            memberHash: normalizedMemberHash || '',
            kdfVersion: state.kdfVersion,
          });

          distributions.push({
            key_id: state.keyId,
            member_hash: normalizedMemberHash || '',
            kdf_ver: state.kdfVersion || 'v2',
            distribution_plain: distributionMessage.toString(),
          });
        } else {
          // 找不到 state，添加带 error 的项
          distributions.push({
            key_id: keyId,
            member_hash: '',
            kdf_ver: '',
            error: 'StateKeyNotFound',
          });
        }
      }

      // 如果所有 key_id 都找不到，返回 null
      if (distributions.every((d) => d.error)) {
        console.warn(`[GroupManager] No states found for key_ids: ${keyIds.join(', ')}`);
        return null;
      }
    } else {
      // 向后兼容：返回当前的 state
      const currentState = record.getState();
      if (!currentState) {
        console.warn(`[GroupManager] No current state found for group ${groupId}`);
        return null;
      }

      const distributionMessage = new SenderKeyDistributionMessage({
        groupId,
        senderUid: this.uid,
        senderDeviceId: this.deviceId,
        keyId: currentState.keyId,
        senderKey: currentState.senderKey,
        signingPubKey: currentState.signingPubKey,
        memberHash: normalizedMemberHash || '',
        kdfVersion: currentState.kdfVersion,
      });

      distributions.push({
        key_id: currentState.keyId,
        member_hash: normalizedMemberHash || '',
        kdf_ver: currentState.kdfVersion || 'v2',
        distribution_plain: distributionMessage.toString(),
      });
    }

    return {
      group_id: groupId,
      sender_uid: this.uid,
      sender_device_id: this.deviceId,
      distributions,
    };
  }
}
