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

  // 智能缓存
  private senderKeyCache: SmartLRUCache<string, SenderKeyRecord>;
  private senderKeyStateCache: SmartLRUCache<string, any>;
  private readonly senderKeyDistributionRetryWindow = 3;

  constructor(parent: any, uid: any, deviceId: any) {
    this.parent = parent;
    this.uid = uid;
    this.deviceId = deviceId;
    this.groupEncryptionLocks = new Map();
    this.signalStore = new SignalProtocolStoreClass(uid, deviceId);

    // 初始化智能缓存
    const config = E2EEConfigManager.getInstance().getConfig();
    this.senderKeyCache = new SmartLRUCache({
      maxSize: config.maxSenderKeyCacheSize,
      ttlMs: config.sessionCacheTTL,
    });
    this.senderKeyStateCache = new SmartLRUCache({
      maxSize: 2000,
      ttlMs: 2 * 60 * 1000,
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

  async encryptGroupMessage(groupId: any, plaintext: string, members: any, memberHash: any) {
    const prevLock = this.groupEncryptionLocks.get(groupId) || Promise.resolve();
    const currentLock = prevLock.then(async () => {
      const normalizedMemberHash = this.normalizeMemberHash(memberHash, members);
      let record: any = await this.loadSenderKeyRecord(groupId, this.uid, this.deviceId);
      let shouldDistribute = !record || (normalizedMemberHash && record.memberHash !== normalizedMemberHash);
      if (shouldDistribute) {
        record = await this.createSenderKeyRecord(groupId, normalizedMemberHash, record);
      }
      const cipher = new GroupCipher(this.parent, record, groupId, this.uid);
      const encryptResult = await cipher.encrypt(plaintext);
      const payload: any = { ...encryptResult.payload, sender_device_id: this.deviceId };
      shouldDistribute = shouldDistribute || this.shouldRetrySenderKeyDistribution(record, payload);
      if (shouldDistribute) {
        const distribution = await this.buildDistributionPayloadForRecord(groupId, record, members, normalizedMemberHash);
        if (distribution) {
          payload.distribution = distribution.distribution;
          payload.member_hash = distribution.member_hash;
          payload.kdf_ver = distribution.kdf_ver;
        }
      }
      // console.log("signal_group payload:", {
      //   group_id: payload.group_id,
      //   sender_uid: payload.sender_uid,
      //   sender_device_id: payload.sender_device_id,
      //   key_id: payload.key_id,
      //   signing_pub_key: payload.signing_pub_key,
      // })
      await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
      return { type: 0, body: JSON.stringify(payload) };
    });
    this.groupEncryptionLocks.set(
      groupId,
      currentLock.catch(() => undefined),
    );
    return await currentLock;
  }

  shouldRetrySenderKeyDistribution(record: any, payload: any): boolean {
    const state: any = record && typeof record.getState === 'function' ? record.getState() : null;
    if (!state || typeof payload?.msg_index !== 'number') {
      return false;
    }
    return state.keyId === payload.key_id && payload.msg_index < this.senderKeyDistributionRetryWindow;
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
    const ciphertexts: any[] = [];
    for (const member of members) {
      if (!member || !member.uid || member.uid === this.uid) {
        continue;
      }
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
        console.error(`[GroupManager] Encrypt inline distribution failed for ${member.uid}:`, e);
      }
    }
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
    const ciphertexts: any[] = [];
    for (const member of members) {
      if (!member || !member.uid || member.uid === this.uid) {
        continue;
      }
      // const deviceIds = Array.isArray(member.deviceIds) ? member.deviceIds : []
      // for (const deviceId of deviceIds) {
      try {
        // Optimization: Check if we have an existing session for this device
        // const hasSession = await this.parent.hasSession(member.uid, deviceId)

        let ct: any;
        // if (hasSession) {
        //    ct = await this.parent.encryptMessage(member.uid, deviceId, distributionPlain)
        //    if (ct && typeof ct.body === "string") {
        //      ciphertexts.push({ uid: member.uid, device_id: deviceId, type: ct.type, body: ct.body })
        //    }
        // } else {
        // Fallback to direct device key encryption (ECIES) if no session exists
        // This avoids the overhead of X3DH session establishment for one-off distribution
        ct = await this.parent.encryptGroupDistributionForDevice(member.uid, distributionPlain, member.devices);
        if (ct && Array.isArray(ct)) {
          // For ECIES, we need to mark it appropriately or use a specific structure
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
        console.error(`[GroupManager] Encrypt distribution failed for ${member.uid}:`, e);
      }
      // }
    }
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
    await this.saveSenderKeyRecord(groupId, this.uid, record, this.deviceId);
    return { type: 0, body: JSON.stringify(payload) };
  }

  async decryptGroupMessageObject(obj: any, remoteUid: string, remoteDeviceId: any) {
    const groupId = obj.group_id;
    const senderUid = obj.sender_uid || remoteUid;
    const senderDeviceId =
      obj.sender_device_id !== undefined && obj.sender_device_id !== null ? obj.sender_device_id : remoteDeviceId;
    let record: any = await this.loadSenderKeyRecord(groupId, senderUid, senderDeviceId);
    if (obj.distribution && Array.isArray(obj.distribution.ciphertexts)) {
      const matched = this.parent.selectCiphertextForDevice(obj.distribution.ciphertexts, this.uid, this.deviceId);
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
            'decryptGroupMessageObject distribution decrypt failed',
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
    if (!record) {
      throw new Error('Missing sender key');
    }
    const cipher = new GroupCipher(this.parent, record, groupId, senderUid);
    const plaintext = await cipher.decrypt(obj);
    this.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId);
    return plaintext;
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
