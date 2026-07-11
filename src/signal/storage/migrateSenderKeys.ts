import { SignalProtocolStore } from './SignalProtocolStore'
import { SenderKeyRecord } from '../models/SenderKeyRecord'

export function parseSenderKeyStorageKey(key: string): {
  uid: string
  groupId: string
  senderUid: string
  senderDeviceId: string
} | undefined {
  const prefix = 'signal_sender_key_'
  if (!key || key.indexOf(prefix) !== 0) {
    return undefined
  }
  const parts = key.slice(prefix.length).split('_')
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
    return undefined
  }
  return {
    uid: parts[0],
    groupId: parts[1],
    senderUid: parts[2],
    senderDeviceId: parts.slice(3).join('_'),
  }
}

/**
 * 迁移 localStorage 中的 sender keys 到 IndexedDB
 *
 * 迁移策略：
 * 1. 遍历 localStorage 中所有以 'signal_sender_key_' 开头的 key
 * 2. 解析数据并存储到 IndexedDB 的 senderKeys 表
 * 3. 迁移完成后可选择是否删除 localStorage 中的旧数据
 *
 * @param uid 用户 ID
 * @param deviceId 设备 ID
 * @param deleteOldData 是否删除 localStorage 中的旧数据（默认 false）
 * @returns 迁移统计信息
 */
export async function migrateSenderKeysFromLocalStorage(
  uid: string,
  deviceId: string | number,
  deleteOldData: boolean = false
): Promise<{
  total: number
  success: number
  failed: number
  errors: { key: string; error: any }[]
}> {
  const stats = {
    total: 0,
    success: 0,
    failed: 0,
    errors: [] as { key: string; error: any }[],
  }

  if (typeof localStorage === 'undefined') {
    console.warn('[migrateSenderKeys] localStorage is not available')
    return stats
  }

  // 查找所有 sender key 相关的 localStorage key
  const localStorageKeys = Object.keys(localStorage).filter((key) =>
    key.startsWith('signal_sender_key_')
  )

  if (localStorageKeys.length === 0) {
    console.log('[migrateSenderKeys] No sender keys found in localStorage')
    return stats
  }

  console.log(
    `[migrateSenderKeys] Found ${localStorageKeys.length} sender keys to migrate`
  )

  const store = new SignalProtocolStore(uid, deviceId)
  await store.init()

  for (const localStorageKey of localStorageKeys) {
    stats.total++
    try {
      const raw = localStorage.getItem(localStorageKey)
      if (!raw) {
        stats.failed++
        stats.errors.push({ key: localStorageKey, error: 'Empty data' })
        continue
      }

      const obj = JSON.parse(raw)
      const record = SenderKeyRecord.fromStorage(obj)

      if (!record) {
        stats.failed++
        stats.errors.push({ key: localStorageKey, error: 'Invalid record' })
        continue
      }

      // 解析 localStorage key 格式: signal_sender_key_{uid}_{groupId}_{senderUid}_{deviceId}
      // 或者: signal_sender_key_{uid}_{groupId}_{senderUid} (旧格式，没有 deviceId)
      const parsedKey = parseSenderKeyStorageKey(localStorageKey)
      if (!parsedKey) {
        stats.failed++
        stats.errors.push({ key: localStorageKey, error: 'Invalid key format' })
        continue
      }

      const storedUid = parsedKey.uid
      const groupId = parsedKey.groupId
      const senderUid = parsedKey.senderUid
      const senderDeviceId = parsedKey.senderDeviceId

      // 验证 uid 是否匹配
      if (storedUid !== uid) {
        console.warn(
          `[migrateSenderKeys] Skipping key with different uid: ${localStorageKey}`
        )
        stats.failed++
        stats.errors.push({ key: localStorageKey, error: 'UID mismatch' })
        continue
      }

      await store.saveSenderKeyRecord(groupId, senderUid, record, senderDeviceId)
      stats.success++

      if (deleteOldData) {
        localStorage.removeItem(localStorageKey)
      }
    } catch (e) {
      stats.failed++
      stats.errors.push({ key: localStorageKey, error: e })
      console.error(`[migrateSenderKeys] Failed to migrate ${localStorageKey}:`, e)
    }
  }

  console.log(
    `[migrateSenderKeys] Migration complete: ${stats.success} succeeded, ${stats.failed} failed`
  )

  return stats
}

/**
 * 检查 localStorage 中是否还有旧的 sender key 数据
 */
export function hasLocalStorageSenderKeys(): boolean {
  if (typeof localStorage === 'undefined') {
    return false
  }
  return Object.keys(localStorage).some((key) =>
    key.startsWith('signal_sender_key_')
  )
}

/**
 * 删除 localStorage 中所有的旧 sender key 数据
 *
 * @returns 删除的数量
 */
export function clearLocalStorageSenderKeys(): number {
  if (typeof localStorage === 'undefined') {
    return 0
  }

  const keysToDelete = Object.keys(localStorage).filter((key) =>
    key.startsWith('signal_sender_key_')
  )

  keysToDelete.forEach((key) => localStorage.removeItem(key))

  return keysToDelete.length
}
