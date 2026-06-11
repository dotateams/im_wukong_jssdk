export class DeviceDirectory {
  apiClient: any;
  isSuccessResponse: (resp: any) => boolean;
  getResponseData: (resp: any) => any;
  remoteDevicesCache: Map<any, any>;
  remoteDevicesInFlight: Map<any, any>;
  remoteDevicesCacheTtlMs: number;
  channelDevicesCache: Map<any, any>;
  channelDevicesInFlight: Map<any, any>;
  channelDevicesCacheTtlMs: number;

  constructor(apiClient: any, isSuccessResponse: (resp: any) => boolean, getResponseData: (resp: any) => any) {
    this.apiClient = apiClient;
    this.isSuccessResponse = isSuccessResponse;
    this.getResponseData = getResponseData;
    this.remoteDevicesCache = new Map();
    this.remoteDevicesInFlight = new Map();
    this.remoteDevicesCacheTtlMs = 30 * 1000;
    this.channelDevicesCache = new Map();
    this.channelDevicesInFlight = new Map();
    this.channelDevicesCacheTtlMs = 5 * 1000;
  }

  async getRemoteDevices(uid: string, forceRefresh?: boolean) {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return [];
    }
    if (!uid) {
      return [];
    }
    const now = Date.now();
    if (!forceRefresh) {
      const cached: any = this.remoteDevicesCache.get(uid);
      if (cached && cached.devices && cached.fetchedAt && now - cached.fetchedAt < this.remoteDevicesCacheTtlMs) {
        return cached.devices;
      }
      const inflight = this.remoteDevicesInFlight.get(uid);
      if (inflight) {
        return await inflight;
      }
    }
    const reqPromise = (async () => {
      const resp = await this.apiClient.get(`/e2e/devices/${uid}`);
      if (!this.isSuccessResponse(resp)) {
        throw new Error(`Failed to get devices: ${resp && ((resp as any).msg ?? (resp as any).code)}`);
      }
      const data: any = this.getResponseData(resp);
      let devices: any[] = [];
      if (Array.isArray(data)) {
        devices = data;
      } else if (data && Array.isArray(data.devices)) {
        devices = data.devices;
      }
      this.remoteDevicesCache.set(uid, { devices, fetchedAt: Date.now() });
      return devices;
    })();
    this.remoteDevicesInFlight.set(uid, reqPromise);
    try {
      return await reqPromise;
    } finally {
      this.remoteDevicesInFlight.delete(uid);
    }
  }

  async getChanelSubscribersDevices(channelId: string, channelType: any, forceRefresh?: boolean) {
    if (!this.apiClient || typeof this.apiClient.get !== 'function') {
      return [];
    }
    if (!channelId) {
      return [];
    }
    const cacheKey = `${channelId}_${channelType}`;
    const now = Date.now();
    if (!forceRefresh) {
      const cached: any = this.channelDevicesCache.get(cacheKey);
      if (cached && cached.devices && cached.fetchedAt && now - cached.fetchedAt < this.channelDevicesCacheTtlMs) {
        return cached.devices;
      }
      const inflight = this.channelDevicesInFlight.get(cacheKey);
      if (inflight) {
        return await inflight;
      }
    }
    const reqPromise = (async () => {
      const resp = await this.apiClient.get(
        `/channel/subscribers/e2e_devices?channel_id=${channelId}&channel_type=${channelType}`,
      );
      // console.log("getChanelSubscribersDevices resp", resp)
      if (!this.isSuccessResponse(resp)) {
        throw new Error(`Failed to get devices: ${resp && ((resp as any).msg ?? (resp as any).code)}`);
      }
      const data: any = this.getResponseData(resp);
      let devices: { uid?: string; e2e_devices?: any[]; devices?: any[] }[] = [];
      if (Array.isArray(data)) {
        devices = data;
      } else if (data && Array.isArray(data.devices)) {
        devices = data.devices;
      }
      // 规范化字段名：将 e2e_devices 统一为 devices，确保下游 GroupKeyDistributionManager 能正确读取
      const normalized = devices.map((item: any) => {
        if (item && item.e2e_devices && !item.devices) {
          return { ...item, devices: item.e2e_devices };
        }
        return item;
      });
      this.channelDevicesCache.set(cacheKey, { devices: normalized, fetchedAt: Date.now() });
      return normalized;
    })();
    this.channelDevicesInFlight.set(cacheKey, reqPromise);
    try {
      return await reqPromise;
    } finally {
      this.channelDevicesInFlight.delete(cacheKey);
    }
  }
}
