import * as libsignal from '@privacyresearch/libsignal-protocol-typescript'
import CryptoJS from 'crypto-js'
import { SignalProtocolStore } from './storage/SignalProtocolStore'
import StorageService from './storage/StorageService'
import { MessageContentType } from '../const'
import { DeviceDirectory } from './managers/DeviceDirectory'
import { PreKeyManager } from './managers/PreKeyManager'
import { SessionManager } from './managers/SessionManager'
import { GroupManager } from './managers/GroupManager'
import { KeyBundleDirectory } from './managers/KeyBundleDirectory'
import { E2EEConfigManager } from './E2EEConfig'
import { randomBytes, stringToArrayBuffer, arrayBufferToString } from './utils/bytes'
import { toBase64, fromBase64 } from './utils/base64'
import { hkdfSha256Bytes, hkdfExpandWord, arrayBufferToWordArray, wordArrayToUint8Array } from './utils/hkdf'
import { getDeviceIdFromStorage, getOSAndVersion, generateUUID } from './utils/platform'

const SESSION_COMPATIBILITY_MIGRATION_VERSION = '20260609-session-rebuild-v2'

export class SignalProtocolManager {
  uid: any
  deviceId: any
  deviceName: any
  apiClient: any
  store: any
  curve: any
  webcrypto: any
  deviceDirectory: DeviceDirectory
  keyBundleDirectory: KeyBundleDirectory
  preKeyManager: PreKeyManager
  sessionManager: SessionManager
  groupManager: GroupManager

  constructor(uid: any,  apiClient: any, options?: { deviceId?: any; deviceName?: any }) {
    this.uid = uid
    this.deviceId = options?.deviceId || this.getDeviceIdFromStorage()
    this.deviceName = options?.deviceName || this.getOSAndVersion()
    this.apiClient = apiClient
    this.store = new SignalProtocolStore(uid, this.deviceId)
    this.curve = null
    this.webcrypto = null
    this.deviceDirectory = new DeviceDirectory(
      apiClient,
      this.isSuccessResponse.bind(this),
      this.getResponseData.bind(this),
      { uid: this.uid, deviceId: this.deviceId }
    )
    this.keyBundleDirectory = new KeyBundleDirectory(
      apiClient,
      this.isSuccessResponse.bind(this),
      this.getResponseData.bind(this)
    )
    this.preKeyManager = new PreKeyManager({
      uid: this.uid,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      apiClient: this.apiClient,
      store: this.store,
      toBase64: this.toBase64.bind(this),
      ensureWebCrypto: this.ensureWebCrypto.bind(this),
      onIdentityRepaired: this.handleLocalIdentityRepaired.bind(this),
    })
    this.sessionManager = new SessionManager({
      uid: this.uid,
      deviceId: this.deviceId,
      apiClient: this.apiClient,
      store: this.store,
      isSuccessResponse: this.isSuccessResponse.bind(this),
      getResponseData: this.getResponseData.bind(this),
      toBase64: this.toBase64.bind(this),
      fromBase64: this.fromBase64.bind(this),
      stringToArrayBuffer: this.stringToArrayBuffer.bind(this),
      arrayBufferToString: this.arrayBufferToString.bind(this),
      ensureWebCrypto: this.ensureWebCrypto.bind(this),
      maybeCheckAndRefillPreKeys: this.maybeCheckAndRefillPreKeys.bind(this),
      useOnetimePreKeys: this.useOnetimePreKeys.bind(this),
      getRemoteKeyBundle: this.getRemoteKeyBundle.bind(this),
    })
    this.groupManager = new GroupManager(this, this.uid, this.deviceId)
  }

  get remoteDevicesCacheTtlMs() {
    return this.deviceDirectory.remoteDevicesCacheTtlMs
  }
  set remoteDevicesCacheTtlMs(value: number) {
    this.deviceDirectory.remoteDevicesCacheTtlMs = value
  }
  get channelDevicesCacheTtlMs() {
    return this.deviceDirectory.channelDevicesCacheTtlMs
  }
  set channelDevicesCacheTtlMs(value: number) {
    this.deviceDirectory.channelDevicesCacheTtlMs = value
  }

  isSuccessResponse(resp: any) {
    if (!resp) return false
    if (typeof resp.code === "number") {
      return resp.code === 0 || resp.code === 200
    }
    if (typeof (resp as any).status === "number") {
      const status = (resp as any).status
      return status >= 200 && status < 300
    }
    return true
  }

  getResponseData(resp: any) {
    if (!resp) return null
    if (Object.prototype.hasOwnProperty.call(resp, 'data')) {
      return resp.data
    }
    return resp
  }

  async initialize() {
    const result = await this.preKeyManager.initialize()
    if (result && (result as any).uploadedKeys) {
      this.handleLocalKeyRegistrationComplete()
    }
    await this.applySessionCompatibilityMigration()
    this.preKeyManager.startMaintenance()
    return result
  }

  getSessionCompatibilityMigrationKey() {
    return `signal_session_migration_${SESSION_COMPATIBILITY_MIGRATION_VERSION}_${this.uid}_${this.deviceId}`
  }

  async applySessionCompatibilityMigration() {
    const key = this.getSessionCompatibilityMigrationKey()
    if (StorageService.shared.getItem(key) === '1') {
      return
    }
    if (this.store && typeof this.store.clearSessions === 'function') {
      await this.store.clearSessions()
    }
    if (this.sessionManager && typeof (this.sessionManager as any).clearSessionCache === 'function') {
      ;(this.sessionManager as any).clearSessionCache()
    }
    StorageService.shared.setItem(key, '1')
  }

  async clearLocalData() {
    if (this.store && typeof this.store.clearLocalData === 'function') {
      await this.store.clearLocalData()
    }
    if (this.sessionManager && typeof (this.sessionManager as any).clearSessionCache === 'function') {
      ;(this.sessionManager as any).clearSessionCache()
    }
    if (this.groupManager) {
      ;(this.groupManager as any).senderKeyCache?.clear?.()
      ;(this.groupManager as any).senderKeyStateCache?.clear?.()
      ;(this.groupManager as any).senderKeyEnvelopeMissingCache?.clear?.()
    }
  }

  handleLocalIdentityRepaired() {
    this.handleLocalKeyRegistrationComplete()
  }

  handleLocalKeyRegistrationComplete() {
    if (this.keyBundleDirectory && typeof (this.keyBundleDirectory as any).clearCache === 'function') {
      ;(this.keyBundleDirectory as any).clearCache()
    }
    if (this.groupManager && typeof (this.groupManager as any).markFirstLoginKeyRegistrationComplete === 'function') {
      ;(this.groupManager as any).markFirstLoginKeyRegistrationComplete()
    } else if (this.groupManager && typeof (this.groupManager as any).markLocalIdentityRepaired === 'function') {
      ;(this.groupManager as any).markLocalIdentityRepaired()
    }
  }

  generateRegistrationId() {
    return this.preKeyManager.generateRegistrationId()
  }

  getPreKeyNextIdStorageKey() {
    return this.preKeyManager.getPreKeyNextIdStorageKey()
  }

  async generateSignedPreKey(keyId: any, identityKeyPair: any) {
    return this.preKeyManager.generateSignedPreKey(keyId, identityKeyPair)
  }

  async generatePreKeys(startId: number, count: number) {
    return this.preKeyManager.generatePreKeys(startId, count)
  }

  async generatePreKeyBundle() {
    return this.preKeyManager.generatePreKeyBundle()
  }

  async uploadPreKeys(bundle: any) {
    return this.preKeyManager.uploadPreKeys(bundle)
  }

  async uploadOnetimePreKeys(bundle: any) {
    return this.preKeyManager.uploadOnetimePreKeys(bundle)
  }

  async useOnetimePreKeys(bundle: any) {
    return this.preKeyManager.useOnetimePreKeys(bundle)
  }

  maybeCheckAndRefillPreKeys() {
    return this.preKeyManager.maybeCheckAndRefillPreKeys()
  }

  async checkAndRefillPreKeys() {
    return this.preKeyManager.checkAndRefillPreKeys()
  }

  async rotateSignedPreKey() {
    return this.preKeyManager.rotateSignedPreKey()
  }

  startMaintenance() {
    return this.preKeyManager.startMaintenance()
  }

  stopMaintenance() {
    return this.preKeyManager.stopMaintenance()
  }

  async buildSession(remoteUid: string, remoteDeviceId: any) {
    return this.sessionManager.buildSession(remoteUid, remoteDeviceId)
  }

  async hasSession(remoteUid: string, remoteDeviceId: any) {
    return this.sessionManager.hasSession(remoteUid, remoteDeviceId)
  }

  async deleteSession(remoteUid: string, remoteDeviceId: any) {
    return this.sessionManager.deleteSession(remoteUid, remoteDeviceId)
  }

  async encryptMessage(remoteUid: string, remoteDeviceId: any, plaintext: string) {
    return this.sessionManager.encryptMessage(remoteUid, remoteDeviceId, plaintext)
  }

  async decryptSignalCipherMessage(remoteUid: string, remoteDeviceId: any, messageType: any, ciphertext: any) {
    return this.sessionManager.decryptSignalCipherMessage(remoteUid, remoteDeviceId, messageType, ciphertext)
  }

  async ensureTrustedIdentityKey(remoteUid: string, remoteDeviceId: any, identityKey: any) {
    return this.sessionManager.ensureTrustedIdentityKey(remoteUid, remoteDeviceId, identityKey)
  }

  async getRemoteKeyBundle(remoteUid: string, remoteDeviceId: any) {
    const bundle = await this.keyBundleDirectory.getDeviceKeyBundle(remoteUid, remoteDeviceId)
    if (!bundle) {
      const response = await this.apiClient.get(`/e2e/keys/${remoteUid}/${remoteDeviceId}`)
      if (!this.isSuccessResponse(response)) {
        throw new Error(`Failed to get prekey bundle: ${response && ((response as any).msg ?? (response as any).code)}`)
      }
      const raw = this.getResponseData(response)
      const normalized = this.keyBundleDirectory.normalize(raw)
      if (normalized) {
        return normalized
      }
      console.warn("[SignalProtocolManager] Failed to normalize remote key bundle", raw)
      return raw
    }
    return {
      uid: bundle.uid,
      deviceID: bundle.deviceId,
      identityKey: bundle.identityKey,
      registrationID: bundle.registrationId,
      signedPrekey: bundle.signedPrekey
        ? { keyId: bundle.signedPrekey.keyId, publicKey: bundle.signedPrekey.publicKey, signature: bundle.signedPrekey.signature }
        : undefined,
      prekey: bundle.prekey ? { keyId: bundle.prekey.keyId, publicKey: bundle.prekey.publicKey } : undefined,
      protocolVersion: bundle.protocolVersion,
    }
  }

  async decryptMessage(remoteUid: string, remoteDeviceId: any, messageType: any, ciphertext: any) {
    let obj: any = null
    if (ciphertext && typeof ciphertext === "object") {
      obj = ciphertext
    } else if (typeof ciphertext === "string") {
      try {
        obj = JSON.parse(ciphertext)
      } catch (e) {
        console.error("[SignalProtocolManager] Failed to parse ciphertext JSON", e)
        obj = null
      }
    }
    if (obj && obj.type === "signal_group") {
      return await this.decryptGroupMessageObject(obj, remoteUid, remoteDeviceId)
    }
    if (obj && obj.type === "signal_group_distribution") {
      await this.decryptGroupDistributionObject(obj, remoteUid, remoteDeviceId)
      return JSON.stringify({
        type: MessageContentType.cmd,
        cmd: "signal_group_distribution",
        param: { group_id: obj.group_id },
      })
    }
    if (obj && obj.type === "signal_multi" && Array.isArray(obj.ciphertexts)) {
      const matched = this.selectCiphertextForDevice(obj.ciphertexts, null, this.deviceId)
      if (!matched) {
        throw new Error("No ciphertext for this device")
      }
      return await this.decryptSignalCipherMessage(remoteUid, remoteDeviceId, matched.type, matched.body)
    }
    return await this.decryptSignalCipherMessage(remoteUid, remoteDeviceId, messageType, ciphertext)
  }

  async encryptGroupMessage(groupId: any, plaintext: string, members: any, memberHash: any) {
    return this.groupManager.encryptGroupMessage(groupId, plaintext, members, memberHash)
  }

  async prepareGroupSend(groupId: any, members: any, memberHash: any) {
    return this.groupManager.prepareGroupSend(groupId, members, memberHash)
  }

  async buildGroupDistributionMessage(groupId: any, memberHash: any, forceNewKey: boolean) {
    return this.groupManager.buildGroupDistributionMessage(groupId, memberHash, forceNewKey)
  }

  async encryptGroupDistribution(groupId: any, members: any, memberHash: any, forceNewKey: boolean) {
    return this.groupManager.encryptGroupDistribution(groupId, members, memberHash, forceNewKey)
  }

  async decryptGroupMessageObject(obj: any, remoteUid: string, remoteDeviceId: any) {
    return this.groupManager.decryptGroupMessageObject(obj, remoteUid, remoteDeviceId)
  }

  async recoverGroupMessageDecryptFailure(obj: any, remoteUid: string, remoteDeviceId: any) {
    if (!obj || obj.type !== "signal_group") {
      return false
    }
    return this.groupManager.recoverSenderKeyFromEnvelope(obj, remoteUid, remoteDeviceId, {
      force: true,
      reason: "realtime_decrypt_failure",
    })
  }

  async decryptGroupDistributionObject(obj: any, remoteUid: string, remoteDeviceId: any) {
    return this.groupManager.decryptGroupDistributionObject(obj, remoteUid, remoteDeviceId)
  }

  async uploadGroupSenderKeyEnvelopes(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    return this.apiClient.post('/e2e/group_sender_keys/envelopes', payload)
  }

  async lookupGroupSenderKeyEnvelope(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    const resp = await this.apiClient.post('/e2e/group_sender_keys/envelope/lookup', payload)
    return this.getResponseData(resp)
  }

  async lookupGroupSenderKeyEnvelopeBatch(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    const resp = await this.apiClient.post('/e2e/group_sender_keys/envelope/lookup/batch', payload)
    return this.getResponseData(resp)
  }

  async requestGroupSenderKeyRepair(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    const resp = await this.apiClient.post('/e2e/group_sender_keys/repair_requests', payload)
    return this.getResponseData(resp)
  }

  async requestGroupSenderKeyRepairBatch(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    const resp = await this.apiClient.post('/e2e/group_sender_keys/repair_requests/batch', payload)
    return this.getResponseData(resp)
  }

  async lookupGroupSenderKeyRepairRequests(payload: any) {
    if (!this.apiClient || typeof this.apiClient.post !== 'function') {
      return null
    }
    const resp = await this.apiClient.post('/e2e/group_sender_keys/repair_requests/pending', payload)
    return this.getResponseData(resp)
  }

  normalizeMemberHash(memberHash: any, members: any) {
    return this.groupManager.normalizeMemberHash(memberHash, members)
  }

  async createSenderKeyRecord(groupId: any, memberHash: any, existingRecord: any) {
    return this.groupManager.createSenderKeyRecord(groupId, memberHash, existingRecord)
  }

  async createSenderKeyState(existingRecord: any) {
    return this.groupManager.createSenderKeyState(existingRecord)
  }

  loadSenderKeyRecord(groupId: any, senderUid: any, senderDeviceId: any) {
    return this.groupManager.loadSenderKeyRecord(groupId, senderUid, senderDeviceId)
  }

  saveSenderKeyRecord(groupId: any, senderUid: any, record: any, senderDeviceId: any) {
    return this.groupManager.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId)
  }

  /**
   * 删除指定的 sender key 记录
   * @param groupId 群组 ID
   * @param senderUid 发送者用户 ID
   * @param senderDeviceId 发送者设备 ID（可选）
   */
  deleteSenderKeyRecord(groupId: any, senderUid: any, senderDeviceId?: any) {
    return this.groupManager.deleteSenderKeyRecord(groupId, senderUid, senderDeviceId)
  }

  /**
   * 删除指定群组的所有 sender keys
   * @param groupId 群组 ID
   */
  deleteGroupSenderKeys(groupId: string) {
    return this.groupManager.deleteGroupSenderKeys(groupId)
  }

  /**
   * 删除指定用户的所有 sender keys（跨所有群组）
   * @param senderUid 发送者用户 ID
   */
  deleteUserSenderKeys(senderUid: string) {
    return this.groupManager.deleteUserSenderKeys(senderUid)
  }

  async getRemoteDevices(uid: string, forceRefresh?: boolean) {
    return this.deviceDirectory.getRemoteDevices(uid, forceRefresh)
  }

  async getChanelSubscribersDevices(channelId: string, channelType: any, forceRefresh?: boolean, options?: { awaitFreshness?: boolean }) {
    return this.deviceDirectory.getChanelSubscribersDevices(channelId, channelType, forceRefresh, options)
  }

  invalidateChannelDevicesCache(channelId: string, channelType?: any) {
    if (this.deviceDirectory && typeof (this.deviceDirectory as any).invalidateChannelDevicesCache === 'function') {
      ;(this.deviceDirectory as any).invalidateChannelDevicesCache(channelId, channelType)
    }
  }

  invalidateGroupRepairRequestCache(groupId: string) {
    if (this.groupManager && typeof (this.groupManager as any).invalidateGroupRepairRequestCache === 'function') {
      ;(this.groupManager as any).invalidateGroupRepairRequestCache(groupId)
    }
  }

  ensureWebCrypto() {
    let webcrypto: any = typeof globalThis !== "undefined" ? (globalThis as any).crypto : null
    if (!webcrypto || !webcrypto.subtle) {
      if (typeof globalThis !== "undefined" && (globalThis as any).msrCrypto) {
        webcrypto = (globalThis as any).msrCrypto
      } else {
        try {
          if (typeof require !== "undefined") {
            webcrypto = require("@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto")
          }
        } catch (e) {
          console.warn("[SignalProtocolManager] Failed to load msrcrypto", e)
        }
      }
    }
    if (webcrypto && webcrypto.subtle) {
      this.webcrypto = webcrypto
      try {
        ; (libsignal as any).setWebCrypto(webcrypto)
      } catch (e) {
        console.error("[SignalProtocolManager] Failed to setWebCrypto", e)
      }
    }
  }

  getSubtleCrypto() {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto && (globalThis as any).crypto.subtle) {
      return (globalThis as any).crypto.subtle
    }
    if (typeof globalThis !== "undefined" && (globalThis as any).msrCrypto && (globalThis as any).msrCrypto.subtle) {
      return (globalThis as any).msrCrypto.subtle
    }
    if (this.webcrypto && this.webcrypto.subtle) {
      return this.webcrypto.subtle
    }
    return null
  }

  async getCurve() {
    if (this.curve) {
      return this.curve
    }
    const lib: any = await (libsignal as any).default()
    this.curve = lib.Curve
    return this.curve
  }

  selectCiphertextForDevice(ciphertexts: any[], uid: any, deviceId: any) {
    if (!Array.isArray(ciphertexts) || ciphertexts.length === 0) {
      return null
    }
    let matched: any = null
    for (const item of ciphertexts) {
      const did = item && ((item as any).device_id ?? (item as any).deviceId ?? (item as any).id)
      const cuid = item && ((item as any).uid ?? (item as any).user_id ?? (item as any).userId)
      if (uid !== null && uid !== undefined && cuid !== undefined && cuid !== null && String(cuid) !== String(uid)) {
        continue
      }
      if (did !== undefined && did !== null && String(did) === String(deviceId)) {
        matched = item
        break
      }
    }
    return matched
  }

  async encryptGroupDistributionForDevice(recipientUid: string, distributionPlain: string, devices?: any[]) {
    if (!recipientUid) {
      throw new Error("Missing recipient")
    }
    this.ensureWebCrypto()
    const subtle = this.getSubtleCrypto()
    if (!subtle) {
      throw new Error("Missing AES-GCM support")
    }
    let resp = this.normalizeProvidedKeyBundles(recipientUid, devices)
    if (resp.length === 0) {
      resp = await this.keyBundleDirectory.getUserKeyBundles(recipientUid, true)
    }
    if (!resp || resp.length === 0) {
      console.warn("[SignalProtocolManager] encryptGroupDistributionForDevice no key bundles", {
        recipientUid,
      })
    }
    const ciphertexts: any[] = []
    for (const bundle of resp) {
      // const bundleData: any = await this.getRemoteKeyBundle(recipientUid, recipientDeviceId)
      const identityKeyRaw = bundle.identityKey
      if (!identityKeyRaw) {
        console.error("[SignalProtocolManager] Missing identity key in bundle", bundle)
        throw new Error("Missing identity key")
      }
      const identityPubKey = this.fromBase64(identityKeyRaw)
      if (identityPubKey.byteLength === 0) {
        console.error("[SignalProtocolManager] Invalid identity key length (0)", identityKeyRaw)
        throw new Error("Invalid identity key")
      }
      // await this.ensureTrustedIdentityKey(recipientUid, recipientDeviceId, identityPubKey)
      const curve = await this.getCurve()
      const ephemeral = curve.generateKeyPair()
      const sharedSecret = curve.calculateAgreement(identityPubKey, ephemeral.privKey)
      const keyBytes = this.hkdfSha256Bytes(sharedSecret, "wukong_group_distribution_v1", "aes-256-gcm", 32)
      const key = await subtle.importKey("raw", keyBytes.buffer, { name: "AES-GCM" }, false, ["encrypt"])
      const ivBytes = this.randomBytes(12)
      const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, key, this.stringToArrayBuffer(distributionPlain))
      const cipherBytes = new Uint8Array(cipherBuffer)
      const tagBytes = cipherBytes.slice(cipherBytes.length - 16)
      const bodyBytes = cipherBytes.slice(0, cipherBytes.length - 16)
      ciphertexts.push({
        uid: recipientUid,
        device_id: bundle.deviceId,
        enc: "aes-256-gcm",
        kdf: "hkdf-sha256",
        eph_pub: this.toBase64(ephemeral.pubKey),
        iv: this.toBase64(ivBytes),
        body: this.toBase64(bodyBytes),
        tag: this.toBase64(tagBytes),
      })
    }
    return ciphertexts
  }

  normalizeProvidedKeyBundles(recipientUid: string, devices?: any[]) {
    if (!Array.isArray(devices) || devices.length === 0) {
      return []
    }
    const bundles: any[] = []
    for (const device of devices) {
      const raw = device && typeof device === "object"
        ? { uid: recipientUid, ...device }
        : { uid: recipientUid, device_id: device }
      const normalized = this.keyBundleDirectory.normalize(raw)
      if (normalized) {
        bundles.push(normalized)
      }
    }
    return bundles
  }
  async encryptGroupDistributionForDeviceIdentity(recipientUid: string, recipientDeviceId: string, identityKey: string, distributionPlain: string) {
    if (!recipientUid) {
      throw new Error("Missing recipient")
    }
    this.ensureWebCrypto()
    const subtle = this.getSubtleCrypto()
    if (!subtle) {
      throw new Error("Missing AES-GCM support")
    }

    const ciphertexts: any[] = []
      // const bundleData: any = await this.getRemoteKeyBundle(recipientUid, recipientDeviceId)
      const identityKeyRaw = identityKey
      if (!identityKeyRaw) {
        console.error("[SignalProtocolManager] Missing identity key in bundle")
        return
      }
      const identityPubKey = this.fromBase64(identityKeyRaw)
      if (identityPubKey.byteLength === 0) {
        console.error("[SignalProtocolManager] Invalid identity key length (0)", identityKeyRaw)
        throw new Error("Invalid identity key")
      }
      // await this.ensureTrustedIdentityKey(recipientUid, recipientDeviceId, identityPubKey)
      const curve = await this.getCurve()
      const ephemeral = curve.generateKeyPair()
      const sharedSecret = curve.calculateAgreement(identityPubKey, ephemeral.privKey)
      const keyBytes = this.hkdfSha256Bytes(sharedSecret, "wukong_group_distribution_v1", "aes-256-gcm", 32)
      const key = await subtle.importKey("raw", keyBytes.buffer, { name: "AES-GCM" }, false, ["encrypt"])
      const ivBytes = this.randomBytes(12)
      const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, key, this.stringToArrayBuffer(distributionPlain))
      const cipherBytes = new Uint8Array(cipherBuffer)
      const tagBytes = cipherBytes.slice(cipherBytes.length - 16)
      const bodyBytes = cipherBytes.slice(0, cipherBytes.length - 16)
      ciphertexts.push({
        uid: recipientUid,
        device_id: recipientDeviceId,
        enc: "aes-256-gcm",
        kdf: "hkdf-sha256",
        eph_pub: this.toBase64(ephemeral.pubKey),
        iv: this.toBase64(ivBytes),
        body: this.toBase64(bodyBytes),
        tag: this.toBase64(tagBytes),
      })
    
    return ciphertexts
  }
  async decryptGroupDistributionForDevice(ciphertext: any) {
    if (!ciphertext) {
      throw new Error("Missing distribution ciphertext")
    }
    this.ensureWebCrypto()
    const subtle = this.getSubtleCrypto()
    if (!subtle) {
      throw new Error("Missing AES-GCM support")
    }
    const ephPubKey = this.fromBase64(ciphertext.eph_pub)
    const ivBytes = new Uint8Array(this.fromBase64(ciphertext.iv) as any)
    const bodyBytes = new Uint8Array(this.fromBase64(ciphertext.body) as any)
    const tagBytes = new Uint8Array(this.fromBase64(ciphertext.tag || "") as any)
    // console.log("[SignalProtocolManager] decryptGroupDistributionForDevice input", {
    //   uid: ciphertext.uid,
    //   device_id: ciphertext.device_id,
    //   enc: ciphertext.enc,
    //   kdf: ciphertext.kdf,
    //   iv_len: ivBytes.length,
    //   body_len: bodyBytes.length,
    //   tag_len: tagBytes.length,
    // })
    const identityKeyPair = await this.store.getIdentityKeyPair()
    if (!identityKeyPair || !identityKeyPair.privKey) {
      throw new Error("Missing identity key pair")
    }
    const curve = await this.getCurve()
    const sharedSecret = curve.calculateAgreement(ephPubKey, identityKeyPair.privKey)
    const keyBytes = this.hkdfSha256Bytes(sharedSecret, "wukong_group_distribution_v1", "aes-256-gcm", 32)
    const key = await subtle.importKey("raw", keyBytes.buffer, { name: "AES-GCM" }, false, ["decrypt"])
    const combined = new Uint8Array(bodyBytes.length + tagBytes.length)
    combined.set(bodyBytes, 0)
    combined.set(tagBytes, bodyBytes.length)
    try {
      const plainBuffer = await subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, combined)
      return this.arrayBufferToString(plainBuffer)
    } catch (e) {
      const config = E2EEConfigManager.getInstance().getConfig()
      if (config.debugEnabled || config.verboseLogging) {
        console.warn("[SignalProtocolManager] stale group distribution envelope skipped", {
          uid: ciphertext.uid,
          device_id: ciphertext.device_id,
          enc: ciphertext.enc,
          kdf: ciphertext.kdf,
          iv_len: ivBytes.length,
          body_len: bodyBytes.length,
          tag_len: tagBytes.length,
        }, e)
      }
      throw e
    }
  }

  async signGroupPayload(signingPrivKeyBase64: string, groupId: any, senderUid: any, msgIndex: any, ivBase64: any, bodyBase64: any, macBase64: any, enc: any, tagBase64: any) {
    if (!signingPrivKeyBase64) {
      throw new Error("Missing signing private key")
    }
    const curve = await this.getCurve()
    const token = enc ? enc : "aes-256-cbc"
    const tail = enc ? (tagBase64 || "") : (macBase64 || "")
    const message = `${token}|${msgIndex}|${ivBase64}|${bodyBase64}|${tail}`
    const messageBytes = this.stringToArrayBuffer(message)
    const signature = curve.calculateSignature(this.fromBase64(signingPrivKeyBase64), messageBytes)
    return this.toBase64(signature)
  }

  async verifyGroupSignature(signingPubKeyBase64: string, groupId: any, senderUid: any, msgIndex: any, ivBase64: any, bodyBase64: any, macBase64: any, signatureBase64: string, enc: any, tagBase64: any) {
    if (!signingPubKeyBase64 || !signatureBase64) {
      return false
    }
    const curve = await this.getCurve()
    const token = enc ? enc : "aes-256-cbc"
    const tail = enc ? (tagBase64 || "") : (macBase64 || "")
    const primary = `${token}|${msgIndex}|${ivBase64}|${bodyBase64}|${tail}`
    const primaryBytes = this.stringToArrayBuffer(primary)
    const okPrimary = curve.verifySignature(this.fromBase64(signingPubKeyBase64), primaryBytes, this.fromBase64(signatureBase64))
    if (okPrimary) {
      return true
    }
    const legacy = enc
      ? `${groupId}|${senderUid}|${msgIndex}|${token}|${ivBase64}|${bodyBase64}|${tail}`
      : `${groupId}|${senderUid}|${msgIndex}|${ivBase64}|${bodyBase64}|${tail}`
    const legacyBytes = this.stringToArrayBuffer(legacy)
    return curve.verifySignature(this.fromBase64(signingPubKeyBase64), legacyBytes, this.fromBase64(signatureBase64))
  }

  async encryptGroupPayload(messageKeyBase64: string, msgIndex: any, plaintext: string, kdfVersion: string) {
    const subtle = this.getSubtleCrypto()
    if (subtle && kdfVersion === "v2") {
      const keyBytes: any = this.fromBase64(messageKeyBase64)
      const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
      const gcmIvBytes = this.randomBytes(12)
      const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv: gcmIvBytes }, key, this.stringToArrayBuffer(plaintext))
      const cipherBytes = new Uint8Array(cipherBuffer)
      const tagBytes = cipherBytes.slice(cipherBytes.length - 16)
      const bodyBytes = cipherBytes.slice(0, cipherBytes.length - 16)
      return {
        iv: this.toBase64(gcmIvBytes),
        body: this.toBase64(bodyBytes),
        tag: this.toBase64(tagBytes),
        enc: "aes-256-gcm",
      }
    }
    const keyWord = CryptoJS.enc.Base64.parse(messageKeyBase64)
    const cbcIvBytes = this.randomBytes(16)
    const ivBase64 = this.toBase64(cbcIvBytes)
    const ivWord = CryptoJS.enc.Base64.parse(ivBase64)
    const encrypted = CryptoJS.AES.encrypt(plaintext, keyWord, {
      iv: ivWord,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    })
    const body = encrypted.ciphertext.toString(CryptoJS.enc.Base64)
    const mac = CryptoJS.HmacSHA256(ivBase64 + "." + body + "." + msgIndex, keyWord).toString(CryptoJS.enc.Base64)
    return { iv: ivBase64, body, mac, enc: "aes-256-cbc" }
  }

  async decryptGroupPayload(messageKeyBase64: string, msgIndex: any, ivBase64: any, bodyBase64: any, macBase64: any, tagBase64: any, enc: any) {
    if (enc === "aes-256-gcm" || tagBase64) {
      const subtle = this.getSubtleCrypto()
      if (!subtle) {
        throw new Error("Missing AES-GCM support")
      }
      const keyBytes: any = this.fromBase64(messageKeyBase64)
      const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])
      const ivBytes = new Uint8Array(this.fromBase64(ivBase64) as any)
      const bodyBytes = new Uint8Array(this.fromBase64(bodyBase64) as any)
      const tagBytes = new Uint8Array(this.fromBase64(tagBase64 || "") as any)
      const combined = new Uint8Array(bodyBytes.length + tagBytes.length)
      combined.set(bodyBytes, 0)
      combined.set(tagBytes, bodyBytes.length)
      const plainBuffer = await subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, combined)
      return this.arrayBufferToString(plainBuffer)
    }
    const keyWord = CryptoJS.enc.Base64.parse(messageKeyBase64)
    const mac = CryptoJS.HmacSHA256(ivBase64 + "." + bodyBase64 + "." + msgIndex, keyWord).toString(CryptoJS.enc.Base64)
    if (mac !== macBase64) {
      throw new Error("Invalid group message MAC")
    }
    const ivWord = CryptoJS.enc.Base64.parse(ivBase64)
    const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(bodyBase64) })
    const decrypted = CryptoJS.AES.decrypt(cipherParams, keyWord, {
      iv: ivWord,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    })
    return decrypted.toString(CryptoJS.enc.Utf8)
  }

  randomBytes(length: number) {
    return randomBytes(length)
  }
  hkdfSha256Bytes(ikmBuffer: any, saltText: any, infoText: any, lengthBytes: number) {
    return hkdfSha256Bytes(ikmBuffer, saltText, infoText, lengthBytes)
  }
  hkdfExpandWord(prkWord: any, info: any, lengthBytes: number) {
    return hkdfExpandWord(prkWord, info, lengthBytes)
  }
  arrayBufferToWordArray(buffer: any) {
    return arrayBufferToWordArray(buffer)
  }
  wordArrayToUint8Array(wordArray: any) {
    return wordArrayToUint8Array(wordArray)
  }
  toBase64(buffer: any) {
    return toBase64(buffer)
  }
  fromBase64(str: any) {
    return fromBase64(str)
  }
  stringToArrayBuffer(str: string) {
    return stringToArrayBuffer(str)
  }
  arrayBufferToString(buffer: any) {
    return arrayBufferToString(buffer)
  }

  getDeviceIdFromStorage() {
    return getDeviceIdFromStorage()
  }

  generateUUID() {
    return generateUUID()
  }

  getOSAndVersion() {
    return getOSAndVersion()
  }
}
