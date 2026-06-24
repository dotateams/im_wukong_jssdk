import { openDatabase, STORES } from './schema'
import { SenderKeyRecord } from '../models/SenderKeyRecord'

export class SignalProtocolStore {
  uid: string
  deviceId: string | number
  db: IDBDatabase | null

  constructor(uid: string, deviceId: string | number) {
    this.uid = uid
    this.deviceId = deviceId
    this.db = null
  }

  async init() {
    this.db = await openDatabase(this.uid, this.deviceId)
  }

  private _identityKey(key: string) {
    const uid = this.uid ? String(this.uid) : ''
    return uid ? `${uid}:${key}` : key
  }

  async getIdentityKeyPair(): Promise<any> {
    const data: any = await this._get(STORES.IDENTITY_KEYS, this._identityKey('identityKeyPair'))
    if (!data) return null
    return {
      pubKey: data.publicKey,
      privKey: data.privateKey,
    }
  }

  async saveIdentityKeyPair(keyPair: any) {
    await this._put(STORES.IDENTITY_KEYS, this._identityKey('identityKeyPair'), {
      publicKey: keyPair.pubKey,
      privateKey: keyPair.privKey,
    })
  }

  async getLocalRegistrationId(): Promise<any> {
    return await this._get(STORES.IDENTITY_KEYS, this._identityKey('registrationId'))
  }

  async saveLocalRegistrationId(id: any) {
    await this._put(STORES.IDENTITY_KEYS, this._identityKey('registrationId'), id)
  }

  async saveIdentity(encodedAddress: string, identityKey: any) {
    await this._put(STORES.IDENTITY_KEYS, this._identityKey(encodedAddress), {
      publicKey: identityKey,
    })
    return true
  }

  async isTrustedIdentity(encodedAddress: string, identityKey: any, direction: any) {
    const stored: any = await this._get(STORES.IDENTITY_KEYS, this._identityKey(encodedAddress))
    if (!stored) return true
    const storedKey = new Uint8Array(stored.publicKey)
    const newKey = new Uint8Array(identityKey)
    if (storedKey.byteLength !== newKey.byteLength) return false
    for (let i = 0; i < storedKey.byteLength; i++) {
      if (storedKey[i] !== newKey[i]) return false
    }
    return true
  }

  async getIdentity(encodedAddress: string) {
    const stored: any = await this._get(STORES.IDENTITY_KEYS, this._identityKey(encodedAddress))
    if (!stored) return null
    return stored.publicKey
  }

  async loadPreKey(preKeyId: any) {
    const data = await this._getWithKeyAliases(STORES.PRE_KEYS, preKeyId)
    if (data) {
      return data
    }
    const used: any = await this._getWithKeyAliases(STORES.USED_PRE_KEYS, preKeyId)
    if (!used) {
      return undefined
    }
    const removedAt = used.removedAt
    if (!removedAt || typeof removedAt !== "number") {
      return undefined
    }
    if (Date.now() - removedAt > 24 * 60 * 60 * 1000) {
      return undefined
    }
    return used.keyPair || undefined
  }

  async storePreKey(preKeyId: any, keyPair: any) {
    await this._put(STORES.PRE_KEYS, preKeyId, keyPair)
  }

  async removePreKey(preKeyId: any) {
    const existing = await this._get(STORES.PRE_KEYS, preKeyId)
    if (existing) {
      await this._put(STORES.USED_PRE_KEYS, preKeyId, {
        keyPair: existing,
        removedAt: Date.now(),
      })
    }
    await this._delete(STORES.PRE_KEYS, preKeyId)
  }

  async loadSignedPreKey(signedPreKeyId: any) {
    const data = await this._getWithKeyAliases(STORES.SIGNED_PRE_KEYS, signedPreKeyId)
    return data || undefined
  }

  async storeSignedPreKey(signedPreKeyId: any, keyPair: any) {
    await this._put(STORES.SIGNED_PRE_KEYS, signedPreKeyId, keyPair)
  }

  async removeSignedPreKey(signedPreKeyId: any) {
    await this._delete(STORES.SIGNED_PRE_KEYS, signedPreKeyId)
  }

  async loadSession(encodedAddress: string) {
    const data = await this._get(STORES.SESSIONS, encodedAddress)
    return data || undefined
  }

  async storeSession(encodedAddress: string, record: any) {
    await this._put(STORES.SESSIONS, encodedAddress, record)
  }

  async deleteSession(encodedAddress: string) {
    await this._delete(STORES.SESSIONS, encodedAddress)
  }

  async clearSessions() {
    await this._clear(STORES.SESSIONS)
  }

  async clearLocalData() {
    await this._clear(STORES.IDENTITY_KEYS)
    await this._clear(STORES.PRE_KEYS)
    await this._clear(STORES.USED_PRE_KEYS)
    await this._clear(STORES.SIGNED_PRE_KEYS)
    await this._clear(STORES.SESSIONS)
    await this._clear(STORES.KYBER_PRE_KEYS)
    await this._clear(STORES.SENDER_KEYS)
  }

  async loadKyberPreKey(kyberPreKeyId: any) {
    const data = await this._get(STORES.KYBER_PRE_KEYS, kyberPreKeyId)
    if (!data) {
      throw new Error(`KyberPreKey not found: ${kyberPreKeyId}`)
    }
    return data
  }

  async saveKyberPreKey(kyberPreKeyId: any, record: any) {
    await this._put(
      STORES.KYBER_PRE_KEYS,
      kyberPreKeyId,
      record
    )
  }

  async _get(storeName: string, key: any): Promise<any> {
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = (this.db as IDBDatabase).transaction([storeName], 'readonly')
      } catch (e) {
        if (e && (e as any).name === 'InvalidStateError') {
          this.init()
            .then(() => {
              this._get(storeName, key).then(resolve).catch(reject)
            })
            .catch(reject)
          return
        }
        reject(e)
        return
      }
      const store = transaction.objectStore(storeName)
      const request = store.get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async _getWithKeyAliases(storeName: string, key: any): Promise<any> {
    for (const candidate of this._keyAliases(key)) {
      const data = await this._get(storeName, candidate)
      if (data !== undefined && data !== null) {
        return data
      }
    }
    return undefined
  }

  private _keyAliases(key: any): any[] {
    const aliases = [key]
    if (typeof key === 'number' && Number.isFinite(key)) {
      aliases.push(String(key))
    } else if (typeof key === 'string' && key.trim() !== '') {
      const numeric = Number(key)
      if (Number.isFinite(numeric)) {
        aliases.push(numeric)
      }
    } else if (key && typeof key === 'object') {
      if (typeof key.toNumber === 'function') {
        const numeric = key.toNumber()
        if (Number.isFinite(numeric)) {
          aliases.push(numeric, String(numeric))
        }
      }
      if (typeof key.toString === 'function') {
        const text = key.toString()
        if (text && text !== '[object Object]') {
          aliases.push(text)
          const numeric = Number(text)
          if (Number.isFinite(numeric)) {
            aliases.push(numeric)
          }
        }
      }
      if (typeof key.low === 'number' && (!key.high || key.high === 0)) {
        const numeric = key.low >>> 0
        aliases.push(numeric, String(numeric))
      }
    }
    return aliases.filter((item, index) => aliases.findIndex(existing => existing === item) === index)
  }

  async _put(storeName: string, key: any, value: any): Promise<void> {
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = (this.db as IDBDatabase).transaction([storeName], 'readwrite')
      } catch (e) {
        if (e && (e as any).name === 'InvalidStateError') {
          this.init()
            .then(() => {
              this._put(storeName, key, value).then(resolve).catch(reject)
            })
            .catch(reject)
          return
        }
        reject(e)
        return
      }
      const store = transaction.objectStore(storeName)
      const request = store.put(value, key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async _delete(storeName: string, key: any): Promise<void> {
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = (this.db as IDBDatabase).transaction([storeName], 'readwrite')
      } catch (e) {
        if (e && (e as any).name === 'InvalidStateError') {
          this.init()
            .then(() => {
              this._delete(storeName, key).then(resolve).catch(reject)
            })
            .catch(reject)
          return
        }
        reject(e)
        return
      }
      const store = transaction.objectStore(storeName)
      const request = store.delete(key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  // 专门用于 senderKeys 表的 put 方法（使用 keyPath）
  async _clear(storeName: string): Promise<void> {
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = (this.db as IDBDatabase).transaction([storeName], 'readwrite')
      } catch (e) {
        if (e && (e as any).name === 'InvalidStateError') {
          this.init()
            .then(() => {
              this._clear(storeName).then(resolve).catch(reject)
            })
            .catch(reject)
          return
        }
        reject(e)
        return
      }
      const store = transaction.objectStore(storeName)
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async _putForSenderKeys(value: any): Promise<void> {
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = (this.db as IDBDatabase).transaction([STORES.SENDER_KEYS], 'readwrite')
      } catch (e) {
        if (e && (e as any).name === 'InvalidStateError') {
          this.init()
            .then(() => {
              this._putForSenderKeys(value).then(resolve).catch(reject)
            })
            .catch(reject)
          return
        }
        reject(e)
        return
      }
      const store = transaction.objectStore(STORES.SENDER_KEYS)
      const request = store.put(value)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  // ========== Sender Key Management ==========

  async saveSenderKeyRecord(
    groupId: string,
    senderUid: string,
    record: SenderKeyRecord,
    senderDeviceId: string | number
  ): Promise<void> {
    if (!groupId || !senderUid || !record) {
      return
    }
    const deviceId = senderDeviceId !== undefined && senderDeviceId !== null && senderDeviceId !== ''
      ? String(senderDeviceId)
      : ''
    const key = `${groupId}:${senderUid}:${deviceId}`
    // 更新时间戳
    record.touch()
    // 使用专门的 put 方法处理 keyPath
    const value = {
      key,
      groupId,
      senderUid,
      ...record.serialize()
    }
    await this._putForSenderKeys(value)
  }

  async loadSenderKeyRecord(
    groupId: string,
    senderUid: string,
    senderDeviceId?: string | number
  ): Promise<SenderKeyRecord | null> {
    if (!groupId || !senderUid) {
      return null
    }
    const deviceId = senderDeviceId !== undefined && senderDeviceId !== null && senderDeviceId !== ''
      ? String(senderDeviceId)
      : ''
    const key = `${groupId}:${senderUid}:${deviceId}`
    let data = await this._get(STORES.SENDER_KEYS, key)

    // 如果指定了 deviceId 但没找到，尝试找不带 deviceId 的旧数据
    if (!data && deviceId) {
      const emptyDeviceKey = `${groupId}:${senderUid}:`
      data = await this._get(STORES.SENDER_KEYS, emptyDeviceKey)
    }

    if (!data) {
      return null
    }
    // 提取实际的记录数据（去除 key 属性）
    const recordData = data.key ? data : { key, ...data }
    try {
      return SenderKeyRecord.fromStorage(recordData)
    } catch (e) {
      console.error(`[SignalProtocolStore] loadSenderKeyRecord failed for ${groupId}:${senderUid}:${deviceId}`, e)
      return null
    }
  }
  /**
   * 删除指定的 sender key 记录
   * @param groupId 群组 ID
   * @param senderUid 发送者用户 ID
   * @param senderDeviceId 发送者设备 ID（可选）
   */
  async deleteSenderKeyRecord(
    groupId: string,
    senderUid: string,
    senderDeviceId?: string | number
  ): Promise<void> {
    if (!groupId || !senderUid) {
      return
    }
    const deviceId = senderDeviceId !== undefined && senderDeviceId !== null && senderDeviceId !== ''
      ? String(senderDeviceId)
      : ''
    const key = `${groupId}:${senderUid}:${deviceId}`
    await this._delete(STORES.SENDER_KEYS, key)
  }
  /**
   * 删除指定群组的所有 sender keys
   * @param groupId 群组 ID
   */
  async deleteGroupSenderKeys(groupId: string): Promise<void> {
    if (!groupId) {
      return
    }
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      const transaction = (this.db as IDBDatabase).transaction([STORES.SENDER_KEYS], 'readwrite')
      const store = transaction.objectStore(STORES.SENDER_KEYS)
      const index = store.index('by-group')
      const keyRange = IDBKeyRange.bound([groupId], [groupId + '\uffff'])
      const request = index.openCursor(keyRange)

      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }
  /**
   * 删除指定用户的所有 sender keys（跨所有群组）
   * @param senderUid 发送者用户 ID
   */
  async deleteUserSenderKeys(senderUid: string): Promise<void> {
    if (!senderUid) {
      return
    }
    if (!this.db) {
      await this.init()
    }
    return new Promise((resolve, reject) => {
      const transaction = (this.db as IDBDatabase).transaction([STORES.SENDER_KEYS], 'readwrite')
      const store = transaction.objectStore(STORES.SENDER_KEYS)
      const index = store.index('by-sender')
      const keyRange = IDBKeyRange.bound([senderUid], [senderUid + '\uffff'])
      const request = index.openCursor(keyRange)

      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * 删除过期的 sender keys 记录
   * @param expiryTime 过期时间戳（毫秒），所有 updatedAt 小于该时间的记录将被删除
   */
  async deleteExpiredSenderKeys(expiryTime: number): Promise<number> {
    if (!this.db) {
      await this.init()
    }

    return new Promise((resolve, reject) => {
      const transaction = (this.db as IDBDatabase).transaction([STORES.SENDER_KEYS], 'readwrite')
      const store = transaction.objectStore(STORES.SENDER_KEYS)
      const index = store.index('by-updatedAt')
      const request = index.openCursor(IDBKeyRange.upperBound(expiryTime))

      let count = 0
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          cursor.delete()
          count++
          cursor.continue()
        }
      }

      transaction.oncomplete = () => resolve(count)
      transaction.onerror = () => reject(transaction.error)
    })
  }
}
