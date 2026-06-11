/**
 * E2EE配置接口和管理器
 */
export interface E2EEConfig {
  // 防抖时间配置
  groupDistributionDebounceMs: number;
  groupRotationDebounceMs: number;

  // 并发控制配置
  groupDistributionConcurrency: number;
  maxBatchSize: number;
  minBatchSize: number;

  // 安全配置
  maxDevicesPerUser: number;
  senderKeyTTL: number;
  sessionCacheTTL: number;
  encryptionPolicy: 'strict' | 'allow_partial' | 'require_majority';

  // 网络配置
  keyRequestRateLimit: number;
  keyRequestMaxDelay: number;
  keyRequestWindowSize: number;

  // 缓存配置
  maxSenderKeyCacheSize: number;
  maxDistributionCacheSize: number;
  distributionCacheTTL: number;
  deviceCacheTTL: number;

  // 重试配置
  maxDecryptRetries: number;
  maxEncryptRetries: number;
  retryDelayMs: number;

  // 监控配置
  metricsEnabled: boolean;
  metricsSampleRate: number;

  // 调试配置
  debugEnabled: boolean;
  verboseLogging: boolean;

  // 文件存储时间
  fileInvalidTTL: number, 
}

export const DEFAULT_E2EE_CONFIG: E2EEConfig = {
  // 防抖时间
  groupDistributionDebounceMs: 2000,
  groupRotationDebounceMs: 5000,

  // 并发控制
  groupDistributionConcurrency: 8,
  maxBatchSize: 16,
  minBatchSize: 4,

  // 安全配置
  maxDevicesPerUser: 10,
  senderKeyTTL: 60 * 24 * 60 * 60 * 1000, // 60天
  sessionCacheTTL: 10 * 60 * 1000, // 10分钟
  encryptionPolicy: 'strict',

  // 网络配置
  keyRequestRateLimit: 10,
  keyRequestMaxDelay: 3000,
  keyRequestWindowSize: 1000,

  // 缓存配置
  maxSenderKeyCacheSize: 1000,
  maxDistributionCacheSize: 500,
  distributionCacheTTL: 10 * 1000,
  deviceCacheTTL: 5 * 60 * 1000,

  // 重试配置
  maxDecryptRetries: 3,
  maxEncryptRetries: 2,
  retryDelayMs: 1000,

  // 监控配置
  metricsEnabled: true,
  metricsSampleRate: 1.0,

  // 调试配置
  debugEnabled: false,
  verboseLogging: false,

  // 文件存储时间
  fileInvalidTTL: Number.MAX_SAFE_INTEGER, 
};

export class E2EEConfigManager {
  private static instance: E2EEConfigManager | null = null;
  private config: E2EEConfig;
  private listeners: ((config: E2EEConfig) => void)[] = [];

  private constructor() {
    this.config = { ...DEFAULT_E2EE_CONFIG };
    this.loadFromStorage();
  }

  static getInstance(): E2EEConfigManager {
    if (!this.instance) {
      this.instance = new E2EEConfigManager();
    }
    return this.instance;
  }

  getConfig(): E2EEConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<E2EEConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveToStorage();
    this.notifyListeners();
  }

  resetToDefault(): void {
    this.config = { ...DEFAULT_E2EE_CONFIG };
    this.saveToStorage();
    this.notifyListeners();
  }

  addListener(listener: (config: E2EEConfig) => void): void {
    this.listeners.push(listener);
  }

  removeListener(listener: (config: E2EEConfig) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      const stored = localStorage.getItem('e2ee_config');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.config = { ...DEFAULT_E2EE_CONFIG, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load E2EE config from storage:', error);
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem('e2ee_config', JSON.stringify(this.config));
    } catch (error) {
      console.warn('Failed to save E2EE config to storage:', error);
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.config);
      } catch (error) {
        console.error('E2EE config listener error:', error);
      }
    }
  }

  validateConfig(config: Partial<E2EEConfig>): string[] {
    const errors: string[] = [];

    if (config.groupDistributionDebounceMs !== undefined && config.groupDistributionDebounceMs < 0) {
      errors.push('groupDistributionDebounceMs must be non-negative');
    }

    if (config.groupRotationDebounceMs !== undefined && config.groupRotationDebounceMs < 0) {
      errors.push('groupRotationDebounceMs must be non-negative');
    }

    if (config.groupDistributionConcurrency !== undefined && config.groupDistributionConcurrency < 1) {
      errors.push('groupDistributionConcurrency must be at least 1');
    }

    if (config.maxDevicesPerUser !== undefined && config.maxDevicesPerUser < 1) {
      errors.push('maxDevicesPerUser must be at least 1');
    }

    return errors;
  }
}
