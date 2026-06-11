/**
 * 智能LRU缓存实现
 * 支持TTL过期、LRU淘汰、统计信息
 */
export class SmartLRUCache<K, V> {
  private cache: Map<K, { value: V; timestamp: number; accessCount: number }>;
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(options: { maxSize?: number; ttlMs?: number } = {}) {
    this.cache = new Map();
    this.maxSize = options.maxSize || 1000;
    this.ttlMs = options.ttlMs || 5 * 60 * 1000; // 默认5分钟
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // 更新访问信息
    entry.timestamp = Date.now();
    entry.accessCount++;
    this.hits++;

    return entry.value;
  }

  set(key: K, value: V): void {
    // 如果已存在，更新
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.value = value;
      entry.timestamp = Date.now();
      entry.accessCount++;
      return;
    }

    // 如果达到最大大小，淘汰最久未使用的
    if (this.cache.size >= this.maxSize) {
      this.evict();
    }

    // 添加新条目
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 1,
    });
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 获取所有键
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取所有值
   */
  values(): V[] {
    return Array.from(this.cache.values()).map((entry) => entry.value);
  }

  /**
   * 获取所有条目
   */
  entries(): [K, V][] {
    return Array.from(this.cache.entries()).map(([key, entry]) => [key, entry.value]);
  }

  private evict(): void {
    // 找到最久未访问的条目
    let oldestKey: K | null = null;
    let oldestTime = Infinity;

    Array.from(this.cache.entries()).forEach(([key, entry]) => {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    });

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
    }
  }

  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }

  get size(): number {
    return this.cache.size;
  }
}
