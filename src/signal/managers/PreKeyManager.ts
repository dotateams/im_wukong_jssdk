import * as libsignal from '@privacyresearch/libsignal-protocol-typescript'
import StorageService from '../storage/StorageService'

export class PreKeyManager {
  uid: any
  deviceId: any
  deviceName: any
  apiClient: any
  store: any
  toBase64: (data: any) => string
  ensureWebCrypto: () => void
  preKeyTimer: any
  signedPreKeyTimer: any
  lastPreKeyCheckAt: any

  constructor(params: {
    uid: any
    deviceId: any
    deviceName: any
    apiClient: any
    store: any
    toBase64: (data: any) => string
    ensureWebCrypto: () => void
  }) {
    this.uid = params.uid
    this.deviceId = params.deviceId
    this.deviceName = params.deviceName
    this.apiClient = params.apiClient
    this.store = params.store
    this.toBase64 = params.toBase64
    this.ensureWebCrypto = params.ensureWebCrypto
    this.preKeyTimer = null
    this.signedPreKeyTimer = null
    this.lastPreKeyCheckAt = 0
  }

  async initialize() {
    this.ensureWebCrypto()
    await this.store.init()
    const identityKeyPair = await this.store.getIdentityKeyPair()
    if (identityKeyPair) {
      const currentDevice = await this.getCurrentDeviceRegistration()
      if (!currentDevice.registered) {
        const bundle = await this.generateBundleForExistingIdentity(identityKeyPair)
        await this.uploadPreKeys(bundle)
      } else if (!(await this.hasLocalSignedPreKey(currentDevice.signedPreKeyId))) {
        const bundle = await this.generateBundleForExistingIdentity(identityKeyPair, currentDevice.signedPreKeyId)
        await this.uploadPreKeys(bundle)
      }
      console.log('Signal Protocol already initialized')
      return
    }
    console.log("初始化信号协议")
    const bundle = await this.generatePreKeyBundle()
    await this.uploadPreKeys(bundle)
    console.log('Signal Protocol initialized successfully')
  }

  generateRegistrationId() {
    return Math.floor(Math.random() * 16384)
  }

  generateSignedPreKeyId() {
    return Math.floor(Date.now() / 1000) % 0x7fffffff
  }

  getPreKeyNextIdStorageKey() {
    return `signal_prekey_next_id_${this.uid}_${this.deviceId}`
  }

  isSuccessResponse(resp: any) {
    if (!resp) return false
    if (typeof resp.code === 'number') {
      return resp.code === 0 || resp.code === 200
    }
    if (typeof resp.status === 'number') {
      return resp.status >= 200 && resp.status < 300
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

  async generateSignedPreKey(keyId: any, identityKeyPair: any) {
    const KeyHelper: any = (libsignal as any).KeyHelper
    return KeyHelper.generateSignedPreKey(identityKeyPair, keyId)
  }

  async generatePreKeys(startId: number, count: number) {
    const KeyHelper: any = (libsignal as any).KeyHelper
    const preKeys: any[] = []
    for (let i = 0; i < count; i++) {
      const keyId = startId + i
      const preKey = await KeyHelper.generatePreKey(keyId)
      await this.store.storePreKey(preKey.keyId, preKey.keyPair)
      preKeys.push(preKey)
    }
    return preKeys
  }

  async generatePreKeyBundle() {
    const KeyHelper: any = (libsignal as any).KeyHelper
    const identityKeyPair = await KeyHelper.generateIdentityKeyPair()
    await this.store.saveIdentityKeyPair(identityKeyPair)
    const registrationId = this.generateRegistrationId()
    await this.store.saveLocalRegistrationId(registrationId)
    const signedPreKeyId = 1
    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId)
    await this.store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair)
    const preKeys: any[] = []
    for (let i = 0; i < 100; i++) {
      const id = i + 1
      const preKey = await KeyHelper.generatePreKey(id)
      await this.store.storePreKey(preKey.keyId, preKey.keyPair)
      preKeys.push({
        keyId: preKey.keyId,
        publicKey: preKey.keyPair.pubKey,
      })
    }
    const nextKeyIdStorageKey = this.getPreKeyNextIdStorageKey()
    const existingNextIdRaw = StorageService.shared.getItem(nextKeyIdStorageKey)
    const existingNextId = existingNextIdRaw ? parseInt(existingNextIdRaw, 10) : 0
    if (!existingNextId || existingNextId < 101) {
      StorageService.shared.setItem(nextKeyIdStorageKey, "101")
    }
    return {
      uid: this.uid,
      device_id: this.deviceId,
      device_name: this.deviceName,
      platform: 'web',
      identity_key: this.toBase64(identityKeyPair.pubKey),
      registration_id: registrationId,
      signed_prekey: {
        key_id: signedPreKeyId,
        public_key: this.toBase64(signedPreKey.keyPair.pubKey),
        signature: this.toBase64(signedPreKey.signature),
      },
      prekeys: preKeys.map(pk => ({
        key_id: pk.keyId,
        public_key: this.toBase64(pk.publicKey),
      })),
    }
  }

  async isCurrentDeviceRegistered() {
    const registration = await this.getCurrentDeviceRegistration()
    return registration.registered
  }

  async getCurrentDeviceRegistration() {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return { registered: true, signedPreKeyId: 1 }
    }
    try {
      const response = await this.apiClient.get(`/e2e/keys/${this.uid}/${this.deviceId}`)
      if (!this.isSuccessResponse(response)) {
        return { registered: false, signedPreKeyId: 1 }
      }
      const data = this.getResponseData(response)
      return {
        registered: true,
        signedPreKeyId: this.getSignedPreKeyIdFromBundle(data) || 1,
      }
    } catch (error) {
      const status = error && ((error as any).status || (error as any).response?.status)
      if (status === 404) {
        return { registered: false, signedPreKeyId: 1 }
      }
      throw error
    }
  }

  getSignedPreKeyIdFromBundle(bundle: any) {
    if (!bundle) {
      return 0
    }
    const signedPreKey = bundle.signed_prekey ?? bundle.SignedPrekey ?? bundle.SignedPreKey ?? bundle.signedPrekey
    const keyId = signedPreKey && (signedPreKey.key_id ?? signedPreKey.KeyID ?? signedPreKey.keyId)
    const numeric = Number(keyId)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
  }

  async hasLocalSignedPreKey(keyId: any) {
    if (!this.store || typeof this.store.loadSignedPreKey !== 'function') {
      return true
    }
    const signedPreKey = await this.store.loadSignedPreKey(keyId || 1)
    return !!signedPreKey
  }

  async generateBundleForExistingIdentity(identityKeyPair: any, signedPreKeyId: any = 1) {
    let registrationId = await this.store.getLocalRegistrationId()
    if (!registrationId) {
      registrationId = this.generateRegistrationId()
      await this.store.saveLocalRegistrationId(registrationId)
    }
    const signedPreKey = await this.generateSignedPreKey(signedPreKeyId, identityKeyPair)
    await this.store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair)

    const storageKey = this.getPreKeyNextIdStorageKey()
    const nextIdRaw = StorageService.shared.getItem(storageKey)
    let nextId = nextIdRaw ? parseInt(nextIdRaw, 10) : 101
    if (!nextId || nextId < 101) {
      nextId = 101
    }
    const preKeys = await this.generatePreKeys(nextId, 50)
    StorageService.shared.setItem(storageKey, String(nextId + 50))

    return {
      uid: this.uid,
      device_id: this.deviceId,
      device_name: this.deviceName,
      platform: 'web',
      identity_key: this.toBase64(identityKeyPair.pubKey),
      registration_id: registrationId,
      signed_prekey: {
        key_id: signedPreKeyId,
        public_key: this.toBase64(signedPreKey.keyPair.pubKey),
        signature: this.toBase64(signedPreKey.signature),
      },
      prekeys: preKeys.map((pk: any) => ({
        key_id: pk.keyId,
        public_key: this.toBase64(pk.keyPair.pubKey),
      })),
    }
  }

  async uploadPreKeys(bundle: any) {
    const response = await this.apiClient.post('/e2e/keys', bundle)
    if (!this.isSuccessResponse(response)) {
      throw new Error(`Failed to upload prekeys: ${response && ((response as any).msg ?? (response as any).code)}`)
    }
    const data = this.getResponseData(response)
    console.log('PreKeys uploaded:', data)
    return data
  }

  async uploadOnetimePreKeys(bundle: any) {
    console.log("上传一次性预密钥", bundle)
    const response = await this.apiClient.post(`/cluster/e2e/keys/replenish/${this.uid}`, bundle)
    if (!this.isSuccessResponse(response)) {
      throw new Error(`Failed to upload prekeys: ${response && ((response as any).msg ?? (response as any).code)}`)
    }
    const data = this.getResponseData(response)
    console.log('PreKeys uploaded:', data)
    return data
  }

  async useOnetimePreKeys(bundle: any) {
    console.log("声明/使用一次性预密钥", bundle)
    const response = await this.apiClient.post(`/e2e/keys/prekey/claim`, bundle)
    if (!this.isSuccessResponse(response)) {
      throw new Error(`Failed to use prekeys: ${response && ((response as any).msg ?? (response as any).code)}`)
    }
    return this.getResponseData(response)
  }

  maybeCheckAndRefillPreKeys() {
    const now = Date.now()
    if (this.lastPreKeyCheckAt && now - this.lastPreKeyCheckAt < 60 * 1000) {
      return
    }
    this.lastPreKeyCheckAt = now
    this.checkAndRefillPreKeys().catch(() => undefined)
  }

  async checkAndRefillPreKeys() {
    const stats = await this.apiClient.get(`/cluster/e2e/keys/stats/${this.uid}/${this.deviceId}`)
    if (!this.isSuccessResponse(stats)) {
      throw new Error(`Failed to get prekey stats: ${stats && ((stats as any).msg ?? (stats as any).code)}`)
    }
    const statsData: any = this.getResponseData(stats)
    const { remaining, total } = statsData
    if (remaining < 20) {
      console.log(`Refilling prekeys (remaining: ${remaining})`)
      const storageKey = this.getPreKeyNextIdStorageKey()
      const candidateBase = typeof total === "number" && total > 0 ? total + 1 : 1
      const nextIdRaw = StorageService.shared.getItem(storageKey)
      let nextId = nextIdRaw ? parseInt(nextIdRaw, 10) : 0
      if (!nextId || nextId < candidateBase) {
        nextId = candidateBase
      }
      const newPreKeys = await this.generatePreKeys(nextId, 50)
      StorageService.shared.setItem(storageKey, String(nextId + 50))
      await this.uploadOnetimePreKeys({
        uid: this.uid,
        device_id: this.deviceId,
        one_time_prekeys: newPreKeys.map((pk: any) => ({
          key_id: pk.keyId,
          public_key: this.toBase64(pk.keyPair.pubKey),
        })),
      })
      console.log('PreKeys refilled successfully')
    }
    this.lastPreKeyCheckAt = Date.now()
  }

  async rotateSignedPreKey() {
    const identityKeyPair = await this.store.getIdentityKeyPair()
    if (!identityKeyPair) {
      throw new Error('Cannot rotate signed prekey before identity key is initialized')
    }
    let registrationId = await this.store.getLocalRegistrationId()
    if (!registrationId) {
      registrationId = this.generateRegistrationId()
      await this.store.saveLocalRegistrationId(registrationId)
    }
    const newKeyId = this.generateSignedPreKeyId()
    const newSignedPreKey = await this.generateSignedPreKey(newKeyId, identityKeyPair)
    await this.store.storeSignedPreKey(newKeyId, newSignedPreKey.keyPair)
    await this.uploadPreKeys({
      uid: this.uid,
      device_id: this.deviceId,
      device_name: this.deviceName,
      platform: 'web',
      identity_key: this.toBase64(identityKeyPair.pubKey),
      registration_id: registrationId,
      signed_prekey: {
        key_id: newKeyId,
        public_key: this.toBase64(newSignedPreKey.keyPair.pubKey),
        signature: this.toBase64(newSignedPreKey.signature),
      },
    })
    console.log('SignedPreKey rotated successfully')
  }

  startMaintenance() {
    console.log("开始维护预密钥和签名预密钥")
    if (this.preKeyTimer || this.signedPreKeyTimer) {
      return
    }
    this.preKeyTimer = setInterval(() => {
      this.checkAndRefillPreKeys().catch(() => undefined)
    }, 10 * 60 * 1000)
    this.signedPreKeyTimer = setInterval(() => {
      this.rotateSignedPreKey().catch(() => undefined)
    }, 7 * 24 * 60 * 60 * 1000)
  }

  stopMaintenance() {
    if (this.preKeyTimer) {
      clearInterval(this.preKeyTimer)
      this.preKeyTimer = null
    }
    if (this.signedPreKeyTimer) {
      clearInterval(this.signedPreKeyTimer)
      this.signedPreKeyTimer = null
    }
  }
}
