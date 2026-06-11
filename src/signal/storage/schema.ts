const DB_NAME = 'signal_store'
const DB_VERSION = 4

export const STORES = {
  IDENTITY_KEYS: 'identityKeys',
  PRE_KEYS: 'preKeys',
  USED_PRE_KEYS: 'usedPreKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
  KYBER_PRE_KEYS: 'kyberPreKeys',
  SENDER_KEYS: 'senderKeys',
}

export function openDatabase(uid: string, deviceId: string | number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const dbName = `${DB_NAME}_${uid}_${deviceId}`
    const request = indexedDB.open(dbName, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event: any) => {
      const db: IDBDatabase = event.target.result
      const oldVersion = event.oldVersion || 0

      // 创建所有表（在首次创建或版本升级时）
      if (!db.objectStoreNames.contains(STORES.IDENTITY_KEYS)) {
        db.createObjectStore(STORES.IDENTITY_KEYS)
      }
      if (!db.objectStoreNames.contains(STORES.PRE_KEYS)) {
        db.createObjectStore(STORES.PRE_KEYS)
      }
      if (!db.objectStoreNames.contains(STORES.USED_PRE_KEYS)) {
        db.createObjectStore(STORES.USED_PRE_KEYS)
      }
      if (!db.objectStoreNames.contains(STORES.SIGNED_PRE_KEYS)) {
        db.createObjectStore(STORES.SIGNED_PRE_KEYS)
      }
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        db.createObjectStore(STORES.SESSIONS)
      }
      if (!db.objectStoreNames.contains(STORES.KYBER_PRE_KEYS)) {
        db.createObjectStore(STORES.KYBER_PRE_KEYS)
      }

      // 版本 3 添加 senderKeys 表
      if (oldVersion < 3 && !db.objectStoreNames.contains(STORES.SENDER_KEYS)) {
        const store = db.createObjectStore(STORES.SENDER_KEYS, { keyPath: 'key' })
        store.createIndex('by-group', ['groupId'], { unique: false })
        store.createIndex('by-sender', ['senderUid'], { unique: false })
        store.createIndex('by-group-sender', ['groupId', 'senderUid'], { unique: false })
      }

      // 版本 4 添加 updatedAt 索引
      if (oldVersion < 4) {
        const tx = event.target.transaction
        if (tx && db.objectStoreNames.contains(STORES.SENDER_KEYS)) {
          const senderKeyStore = tx.objectStore(STORES.SENDER_KEYS)
          const senderKeyIndexNames = senderKeyStore.indexNames

          if (!senderKeyIndexNames.contains('by-updatedAt')) {
            senderKeyStore.createIndex('by-updatedAt', 'updated_at', { unique: false })
          }
        }
      }
    }
  })
}

