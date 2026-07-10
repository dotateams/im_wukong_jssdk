import StorageService from '../storage/StorageService'

type DeviceDirectoryOptions = {
  uid?: string
  deviceId?: string | number
}

export class DeviceDirectory {
  apiClient: any
  isSuccessResponse: (resp: any) => boolean
  getResponseData: (resp: any) => any
  uid?: string
  deviceId?: string | number
  remoteDevicesCache: Map<any, any>
  remoteDevicesInFlight: Map<any, any>
  remoteDevicesCacheTtlMs: number
  channelDevicesCache: Map<any, any>
  channelDevicesInFlight: Map<any, any>
  channelDevicesRefreshGeneration: Map<any, number>
  channelDevicesVersionCheckedAt: Map<any, number>
  channelDevicesCacheTtlMs: number
  channelDevicesVersionCheckIntervalMs: number

  constructor(
    apiClient: any,
    isSuccessResponse: (resp: any) => boolean,
    getResponseData: (resp: any) => any,
    options?: DeviceDirectoryOptions,
  ) {
    this.apiClient = apiClient
    this.isSuccessResponse = isSuccessResponse
    this.getResponseData = getResponseData
    this.uid = options?.uid
    this.deviceId = options?.deviceId
    this.remoteDevicesCache = new Map()
    this.remoteDevicesInFlight = new Map()
    this.remoteDevicesCacheTtlMs = 30 * 1000
    this.channelDevicesCache = new Map()
    this.channelDevicesInFlight = new Map()
    this.channelDevicesRefreshGeneration = new Map()
    this.channelDevicesVersionCheckedAt = new Map()
    // 0 means long-lived. It is invalidated by member changes or forceRefresh.
    this.channelDevicesCacheTtlMs = 0
    this.channelDevicesVersionCheckIntervalMs = 30 * 1000
  }

  async getRemoteDevices(uid: string, forceRefresh?: boolean) {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return []
    }
    if (!uid) {
      return []
    }
    const now = Date.now()
    if (!forceRefresh) {
      const cached: any = this.remoteDevicesCache.get(uid)
      if (cached && cached.devices && cached.fetchedAt && now - cached.fetchedAt < this.remoteDevicesCacheTtlMs) {
        return cached.devices
      }
      const inflight = this.remoteDevicesInFlight.get(uid)
      if (inflight) {
        return await inflight
      }
    }
    const reqPromise = (async () => {
      const resp = await this.apiClient.get(`/e2e/devices/${uid}`)
      if (!this.isSuccessResponse(resp)) {
        throw new Error(`Failed to get devices: ${resp && ((resp as any).msg ?? (resp as any).code)}`)
      }
      const data: any = this.getResponseData(resp)
      let devices: any[] = []
      if (Array.isArray(data)) {
        devices = data
      } else if (data && Array.isArray(data.devices)) {
        devices = data.devices
      }
      this.remoteDevicesCache.set(uid, { devices, fetchedAt: Date.now() })
      return devices
    })()
    this.remoteDevicesInFlight.set(uid, reqPromise)
    try {
      return await reqPromise
    } finally {
      this.remoteDevicesInFlight.delete(uid)
    }
  }

  // options.awaitFreshness: 在命中缓存时，同步（await）做一次轻量版本校验，若 devices_version/member_version 变化
  // 则先刷新设备目录再返回。用于“构建群 sender key 分发”这类正确性攸关的路径，避免用陈旧成员/设备集导致
  // 新登录设备被静默漏掉。相比后台 setTimeout(0) 的尽力而为刷新，这里保证发消息前拿到最新设备集。
  async getChanelSubscribersDevices(
    channelId: string,
    channelType: any,
    forceRefresh?: boolean,
    options?: { awaitFreshness?: boolean },
  ) {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return []
    }
    if (!channelId) {
      return []
    }
    const cacheKey = this.getChannelDevicesCacheKey(channelId, channelType)
    const inflight = this.channelDevicesInFlight.get(cacheKey)
    if (inflight && (forceRefresh || !this.getChannelDevicesCacheEntry(cacheKey))) {
      return await inflight
    }

    if (!forceRefresh) {
      const cached = this.getChannelDevicesCacheEntry(cacheKey)
      if (cached && Array.isArray(cached.devices) && !this.isChannelDevicesCacheExpired(cached)) {
        if (options && options.awaitFreshness) {
          if (!this.shouldCheckChannelDevicesVersion(cacheKey)) {
            return cached.devices
          }
          // 同步校验版本并按需刷新（只在版本变化时才全量拉设备），保证分发使用最新设备集。
          const generation = this.channelDevicesRefreshGeneration.get(cacheKey) || 0
          try {
            return await this.validateChannelDevicesVersionAndRefresh(channelId, channelType, cacheKey, generation, true)
          } catch (error) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[E2EE] await-fresh channel device version check failed; forcing full refresh', { channelId, channelType }, error)
            }
            try {
              return await this.fetchAndStoreChannelDevices(channelId, channelType, cacheKey, generation)
            } catch (refreshError) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[E2EE] await-fresh full channel device refresh failed; using cached devices', { channelId, channelType }, refreshError)
              }
              return cached.devices
            }
          }
        }
        this.scheduleChannelDevicesRefresh(channelId, channelType, cacheKey)
        return cached.devices
      }
    }

    return await this.refreshChannelDevices(channelId, channelType, cacheKey)
  }

  getChannelDevicesRefreshPromise(channelId: string, channelType: any) {
    const cacheKey = this.getChannelDevicesCacheKey(channelId, channelType)
    return this.channelDevicesInFlight.get(cacheKey) || Promise.resolve()
  }

  invalidateChannelDevicesCache(channelId: string, channelType?: any) {
    const keys = typeof channelType === 'undefined'
      ? Array.from(this.channelDevicesCache.keys()).filter((key) => String(key).startsWith(`${channelId}_`))
      : [this.getChannelDevicesCacheKey(channelId, channelType)]
    const groupFallbackKey = this.getChannelDevicesCacheKey(channelId, 2)
    if (typeof channelType === 'undefined' && keys.indexOf(groupFallbackKey) < 0) {
      keys.push(groupFallbackKey)
    }

    keys.forEach((cacheKey) => {
      this.channelDevicesCache.delete(cacheKey)
      this.channelDevicesInFlight.delete(cacheKey)
      this.channelDevicesVersionCheckedAt.delete(cacheKey)
      this.channelDevicesRefreshGeneration.set(cacheKey, (this.channelDevicesRefreshGeneration.get(cacheKey) || 0) + 1)
      this.removePersistentChannelDevices(cacheKey)
    })
  }

  clearLocalData() {
    this.remoteDevicesCache.clear()
    this.remoteDevicesInFlight.clear()
    this.channelDevicesCache.clear()
    this.channelDevicesInFlight.clear()
    this.channelDevicesRefreshGeneration.clear()
    this.channelDevicesVersionCheckedAt.clear()
    this.clearPersistentChannelDevices()
  }

  private scheduleChannelDevicesRefresh(channelId: string, channelType: any, cacheKey: string) {
    if (this.channelDevicesInFlight.has(cacheKey)) {
      return
    }
    if (!this.shouldCheckChannelDevicesVersion(cacheKey)) {
      return
    }
    const generation = this.channelDevicesRefreshGeneration.get(cacheKey) || 0
    const reqPromise = new Promise<any[]>((resolve) => {
      setTimeout(() => {
        this.validateChannelDevicesVersionAndRefresh(channelId, channelType, cacheKey, generation)
          .then(resolve)
          .catch((error) => {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[E2EE] refresh channel device directory failed', { channelId, channelType }, error)
            }
            const cached = this.getChannelDevicesCacheEntry(cacheKey)
            resolve(cached && Array.isArray(cached.devices) ? cached.devices : [])
          })
      }, 0)
    })
    this.channelDevicesInFlight.set(cacheKey, reqPromise)
    reqPromise.finally(() => {
      if (this.channelDevicesInFlight.get(cacheKey) === reqPromise) {
        this.channelDevicesInFlight.delete(cacheKey)
      }
    })
  }

  private async refreshChannelDevices(channelId: string, channelType: any, cacheKey: string) {
    const inflight = this.channelDevicesInFlight.get(cacheKey)
    if (inflight) {
      return inflight
    }
    const generation = this.channelDevicesRefreshGeneration.get(cacheKey) || 0
    const reqPromise = this.fetchAndStoreChannelDevices(channelId, channelType, cacheKey, generation)
    this.channelDevicesInFlight.set(cacheKey, reqPromise)
    try {
      return await reqPromise
    } finally {
      if (this.channelDevicesInFlight.get(cacheKey) === reqPromise) {
        this.channelDevicesInFlight.delete(cacheKey)
      }
    }
  }

  private async fetchAndStoreChannelDevices(channelId: string, channelType: any, cacheKey: string, generation: number, versionInfo?: any) {
    const resp = await this.apiClient.get(
      `/channel/subscribers/e2e_devices?channel_id=${encodeURIComponent(channelId)}&channel_type=${encodeURIComponent(String(channelType))}`,
    )
    if (!this.isSuccessResponse(resp)) {
      throw new Error(`Failed to get devices: ${resp && ((resp as any).msg ?? (resp as any).code)}`)
    }
    const data: any = this.getResponseData(resp)
    const normalized = this.normalizeChannelDevices(data)
    if ((this.channelDevicesRefreshGeneration.get(cacheKey) || 0) === generation) {
      const entry = {
        devices: normalized,
        fetchedAt: Date.now(),
        memberVersion: (data && (data.member_version || data.memberVersion)) || versionInfo?.memberVersion,
        devicesVersion: (data && (data.devices_version || data.devicesVersion)) || versionInfo?.devicesVersion,
      }
      this.channelDevicesCache.set(cacheKey, entry)
      this.setPersistentChannelDevices(cacheKey, entry)
      this.markChannelDevicesVersionChecked(cacheKey)
    }
    return normalized
  }

  private async validateChannelDevicesVersionAndRefresh(channelId: string, channelType: any, cacheKey: string, generation: number, refreshWhenVersionMissing?: boolean) {
    this.markChannelDevicesVersionChecked(cacheKey)
    const cached = this.getChannelDevicesCacheEntry(cacheKey)
    if (!cached) {
      return await this.fetchAndStoreChannelDevices(channelId, channelType, cacheKey, generation)
    }
    const version = await this.fetchChannelDevicesVersion(channelId, channelType)
    if (!version) {
      if (refreshWhenVersionMissing) {
        return await this.fetchAndStoreChannelDevices(channelId, channelType, cacheKey, generation)
      }
      return cached.devices
    }
    const localMemberVersion = cached.memberVersion || cached.member_version
    const localDevicesVersion = cached.devicesVersion || cached.devices_version
    const memberChanged = version.memberVersion !== undefined && String(version.memberVersion) !== String(localMemberVersion || '')
    const devicesChanged = version.devicesVersion !== undefined && String(version.devicesVersion) !== String(localDevicesVersion || '')
    if (memberChanged || devicesChanged) {
      return await this.fetchAndStoreChannelDevices(channelId, channelType, cacheKey, generation, version)
    }
    return cached.devices
  }

  private async fetchChannelDevicesVersion(channelId: string, channelType: any) {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return null
    }
    try {
      const resp = await this.apiClient.get(
        `/channel/subscribers/e2e_devices/version?channel_id=${encodeURIComponent(channelId)}&channel_type=${encodeURIComponent(String(channelType))}`,
      )
      if (!this.isSuccessResponse(resp)) {
        return null
      }
      const data: any = this.getResponseData(resp)
      if (!data) {
        return null
      }
      return {
        memberVersion: data.member_version || data.memberVersion || data.version,
        devicesVersion: data.devices_version || data.devicesVersion || data.version,
      }
    } catch (error) {
      return null
    }
  }

  private shouldCheckChannelDevicesVersion(cacheKey: string) {
    const lastAt = this.channelDevicesVersionCheckedAt.get(cacheKey) || 0
    const interval = Math.max(0, Number(this.channelDevicesVersionCheckIntervalMs || 0))
    return !lastAt || interval <= 0 || Date.now() - lastAt >= interval
  }

  private markChannelDevicesVersionChecked(cacheKey: string) {
    this.channelDevicesVersionCheckedAt.set(cacheKey, Date.now())
  }

  private normalizeChannelDevices(data: any) {
    let devices: { uid?: string; e2e_devices?: any[]; devices?: any[] }[] = []
    if (Array.isArray(data)) {
      devices = data
    } else if (data && Array.isArray(data.devices)) {
      devices = data.devices
    }
    return devices.map((item: any) => {
      if (item && item.e2e_devices && !item.devices) {
        return { ...item, devices: item.e2e_devices }
      }
      return item
    })
  }

  private isChannelDevicesCacheExpired(entry: any) {
    if (!entry || !entry.fetchedAt) {
      return true
    }
    if (!this.channelDevicesCacheTtlMs || !Number.isFinite(this.channelDevicesCacheTtlMs)) {
      return false
    }
    return Date.now() - entry.fetchedAt >= this.channelDevicesCacheTtlMs
  }

  private getChannelDevicesCacheEntry(cacheKey: string) {
    const cached = this.channelDevicesCache.get(cacheKey)
    if (cached && Array.isArray(cached.devices)) {
      return cached
    }
    const persistent = this.getPersistentChannelDevices(cacheKey)
    if (persistent && Array.isArray(persistent.devices)) {
      this.channelDevicesCache.set(cacheKey, persistent)
      return persistent
    }
    return null
  }

  private getChannelDevicesCacheKey(channelId: string, channelType: any) {
    return `${channelId}_${channelType}`
  }

  private getPersistentChannelDevicesKey(cacheKey: string) {
    if (!this.uid || !this.deviceId) {
      return ''
    }
    return [
      'wk_signal_channel_devices',
      encodeURIComponent(String(this.uid)),
      encodeURIComponent(String(this.deviceId)),
      encodeURIComponent(cacheKey),
    ].join('_')
  }

  private getPersistentChannelDevicesPrefix() {
    if (!this.uid || !this.deviceId) {
      return ''
    }
    return [
      'wk_signal_channel_devices',
      encodeURIComponent(String(this.uid)),
      encodeURIComponent(String(this.deviceId)),
      '',
    ].join('_')
  }

  private getPersistentChannelDevices(cacheKey: string) {
    const key = this.getPersistentChannelDevicesKey(cacheKey)
    if (!key) {
      return null
    }
    const raw = StorageService.shared.getItem(key)
    if (!raw) {
      return null
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && Array.isArray(parsed.devices) ? parsed : null
    } catch (error) {
      StorageService.shared.removeItem(key)
      return null
    }
  }

  private setPersistentChannelDevices(cacheKey: string, entry: any) {
    const key = this.getPersistentChannelDevicesKey(cacheKey)
    if (!key) {
      return
    }
    try {
      StorageService.shared.setItem(key, JSON.stringify(entry))
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[E2EE] persist channel device directory failed', error)
      }
    }
  }

  private removePersistentChannelDevices(cacheKey: string) {
    const key = this.getPersistentChannelDevicesKey(cacheKey)
    if (key) {
      StorageService.shared.removeItem(key)
    }
  }

  private clearPersistentChannelDevices() {
    const prefix = this.getPersistentChannelDevicesPrefix()
    if (!prefix || typeof localStorage === 'undefined') {
      return
    }
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.indexOf(prefix) === 0) {
        keys.push(key)
      }
    }
    keys.forEach((key) => StorageService.shared.removeItem(key))
  }
}
