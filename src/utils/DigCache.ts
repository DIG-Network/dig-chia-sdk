// src/cache/DigCache.ts
import NodeCache from "node-cache";
import { createClient, RedisClientType } from "redis";

export interface ICache {
  set<T>(key: string, value: T, ttl?: number): Promise<boolean>;
  get<T>(key: string): Promise<T | undefined>;
  del(key: string): Promise<number>;
  has(key: string): Promise<boolean>;
  flushAll(): Promise<boolean>;
  keys(pattern?: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  // Add other NodeCache methods as needed
}

class DigCache implements ICache {
  private cache: NodeCache | RedisClientType;
  private useRedis: boolean;

  /**
   * Constructor with the same signature as NodeCache.
   * @param options - NodeCache options
   */
  constructor(options?: NodeCache.Options) {
    // Determine whether to use Redis based on the environment variable
    this.useRedis = process.env.USE_REDIS === 'true';

    if (this.useRedis) {
      // Ensure REDIS_URL is provided
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error("REDIS_URL environment variable is not set.");
      }

      const client: RedisClientType = createClient({ url: redisUrl });
      client.on("error", (err) => console.error("Redis Client Error", err));
      // Initialize connection in the initialize method
      this.cache = client;
    } else {
      // Initialize NodeCache with provided options
      this.cache = new NodeCache(options);
    }
  }

  /**
   * Initializes the Redis connection if Redis is being used.
   * Call this method before performing any cache operations.
   */
  async initialize(): Promise<void> {
    if (this.useRedis) {
      try {
        await (this.cache as RedisClientType).connect();
        console.log("Connected to Redis successfully.");
      } catch (error) {
        console.error("Failed to connect to Redis:", error);
        throw error;
      }
    }
  }

  /**
   * Gracefully disconnects the Redis client if Redis is being used.
   * Call this method when your application is shutting down.
   */
  async disconnect(): Promise<void> {
    if (this.useRedis) {
      try {
        await (this.cache as RedisClientType).quit();
        console.log("Disconnected from Redis successfully.");
      } catch (error) {
        console.error("Error disconnecting Redis:", error);
      }
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    if (this.useRedis) {
      try {
        const serializedValue = JSON.stringify(value);
        if (ttl !== undefined) {
          // Redis TTL is in seconds
          const result = await (this.cache as RedisClientType).set(
            key,
            serializedValue,
            { EX: ttl }
          );
          return result === "OK";
        } else {
          const result = await (this.cache as RedisClientType).set(
            key,
            serializedValue
          );
          return result === "OK";
        }
      } catch (error) {
        console.error(`Redis set error for key "${key}":`, error);
        return false;
      }
    } else {
      try {
        const result = (this.cache as NodeCache).set(key, value, ttl ?? 0);
        return result;
      } catch (error) {
        console.error(`NodeCache set error for key "${key}":`, error);
        return false;
      }
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.useRedis) {
      try {
        const value = await (this.cache as RedisClientType).get(key);
        if (value === null) {
          return undefined;
        }
        return JSON.parse(value) as T;
      } catch (error) {
        console.error(`Redis get error for key "${key}":`, error);
        return undefined;
      }
    } else {
      try {
        const value = (this.cache as NodeCache).get<T>(key);
        return value;
      } catch (error) {
        console.error(`NodeCache get error for key "${key}":`, error);
        return undefined;
      }
    }
  }

  async del(key: string): Promise<number> {
    if (this.useRedis) {
      try {
        const result = await (this.cache as RedisClientType).del(key);
        return result;
      } catch (error) {
        console.error(`Redis del error for key "${key}":`, error);
        return 0;
      }
    } else {
      try {
        const result = (this.cache as NodeCache).del(key);
        return result;
      } catch (error) {
        console.error(`NodeCache del error for key "${key}":`, error);
        return 0;
      }
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.useRedis) {
      try {
        const result = await (this.cache as RedisClientType).exists(key);
        return result > 0;
      } catch (error) {
        console.error(`Redis exists error for key "${key}":`, error);
        return false;
      }
    } else {
      try {
        const result = (this.cache as NodeCache).has(key);
        return result;
      } catch (error) {
        console.error(`NodeCache has error for key "${key}":`, error);
        return false;
      }
    }
  }

  async flushAll(): Promise<boolean> {
    if (this.useRedis) {
      try {
        await (this.cache as RedisClientType).flushAll();
        return true;
      } catch (error) {
        console.error("Redis flushAll error:", error);
        return false;
      }
    } else {
      try {
        (this.cache as NodeCache).flushAll();
        return true;
      } catch (error) {
        console.error("NodeCache flushAll error:", error);
        return false;
      }
    }
  }

  async keys(pattern: string = "*"): Promise<string[]> {
    if (this.useRedis) {
      try {
        const result = await (this.cache as RedisClientType).keys(pattern);
        return result;
      } catch (error) {
        console.error(`Redis keys error with pattern "${pattern}":`, error);
        return [];
      }
    } else {
      try {
        const result = (this.cache as NodeCache).keys();
        return result;
      } catch (error) {
        return [];
      }
    }
  }

  async ttl(key: string): Promise<number> {
    if (this.useRedis) {
      try {
        const result = await (this.cache as RedisClientType).ttl(key);
        return result; // TTL in seconds. -2: key does not exist, -1: no TTL
      } catch (error) {
        console.error(`Redis ttl error for key "${key}":`, error);
        return -2;
      }
    } else {
      const ttlMs = (this.cache as NodeCache).getTtl(key);
      
      if (ttlMs === undefined || ttlMs === 0) {
        return -1; // No TTL set
      }

      if (ttlMs < 0) {
        return ttlMs; // Key does not exist or other Redis-specific responses
      }

      const ttlSec = Math.floor((ttlMs - Date.now()) / 1000);
      return ttlSec > 0 ? ttlSec : -2;
    }
  }

  // Implement other NodeCache methods as needed
}

export { DigCache };
