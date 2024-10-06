import { FullNodePeer } from "./FullNodePeer";
import { FileCache, USER_DIR_PATH } from "../utils";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { DataStore } from "./DataStore";
import { getCoinId } from "@dignetwork/datalayer-driver";
import { Environment } from "../utils";

/**
 * Represents the structure of cached store information.
 */
interface StoreCacheEntry {
  latestStore: ReturnType<DataStoreSerializer["serialize"]>;
  latestHeight: number;
  latestHash: string;
}

/**
 * Callback type to be invoked when the store is updated.
 */
type StoreUpdateCallback = (
  storeId: string,
  updatedStore: StoreCacheEntry
) => void;

/**
 * StoreMonitorRegistry manages monitoring of multiple storeIds.
 * It encapsulates cache management and ensures only one monitor runs per storeId.
 */
export class StoreMonitorRegistry {
  // Singleton instance
  private static instance: StoreMonitorRegistry;

  // Map to track active monitors and their callbacks
  private activeMonitors: Map<string, StoreUpdateCallback>;

  // Internal cache to store the latest store information
  private storeCoinCache: FileCache<StoreCacheEntry>;

  // Map to track ongoing cache population promises to prevent duplicate fetches
  private cachePopulationPromises: Map<string, Promise<StoreCacheEntry>>;

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor() {
    this.activeMonitors = new Map();
    this.storeCoinCache = new FileCache<StoreCacheEntry>(
      "stores",
      USER_DIR_PATH
    );
    this.cachePopulationPromises = new Map();
  }

  /**
   * Retrieves the singleton instance of the registry.
   * @returns {StoreMonitorRegistry} The singleton instance.
   */
  public static getInstance(): StoreMonitorRegistry {
    if (!StoreMonitorRegistry.instance) {
      StoreMonitorRegistry.instance = new StoreMonitorRegistry();
    }
    return StoreMonitorRegistry.instance;
  }

  /**
   * Registers a storeId with a callback to be invoked upon updates.
   * Immediately updates the cache and invokes the callback before starting the monitor.
   * @param {string} storeId - The store identifier to monitor.
   * @param {StoreUpdateCallback} callback - The callback to execute when the store is updated.
   */
  public async registerStore(
    storeId: string,
    callback: StoreUpdateCallback
  ): Promise<void> {
    if (this.activeMonitors.has(storeId)) {
      return;
    }

    console.log(`Registry: Registering monitor for storeId: ${storeId}`);
    this.activeMonitors.set(storeId, callback);

    try {
      // Immediately fetch and cache the latest store info
      const initialStore = await this.fetchAndCacheStoreInfo(storeId);
      // Invoke the callback with the initial store info
      callback(storeId, initialStore);
    } catch (error: any) {
      console.error(
        `Registry: Failed to perform initial cache update for storeId: ${storeId} - ${error.message}`
      );
      // Decide whether to unregister the monitor or proceed
      // For this example, we'll proceed to start the monitor
    }

    // No monitoring in cli mode
    if (!Environment.CLI_MODE) {
      // Start monitoring asynchronously
      this.startMonitor(storeId, callback).catch((error) => {
        console.error(
          `Registry: Unexpected error in startMonitor for storeId: ${storeId} - ${error.message}`
        );
      });
    }
  }

  /**
   * Retrieves the latest cached entry for a given storeId.
   * If no cache exists, it fetches and caches the store info before returning.
   * @param {string} storeId - The store identifier.
   * @returns {Promise<StoreCacheEntry>} The latest cached entry.
   */
  public async getLatestCache(storeId: string): Promise<StoreCacheEntry> {
    // if in CLI mode, always fetch the latest store info directly
    if (!Environment.CLI_MODE) {
      let cachedInfo = this.storeCoinCache.get(storeId);
      if (cachedInfo) {
        return cachedInfo;
      }

      // If cache is missing, fetch and cache it
      console.log(
        `getLatestCache: No cache found for storeId: ${storeId}. Fetching...`
      );

      // Prevent duplicate fetches for the same storeId
      if (this.cachePopulationPromises.has(storeId)) {
        return this.cachePopulationPromises.get(storeId)!;
      }
    }

    const fetchPromise = this.fetchAndCacheStoreInfo(storeId)
      .then((store) => {
        this.cachePopulationPromises.delete(storeId);
        return store;
      })
      .catch((error) => {
        this.cachePopulationPromises.delete(storeId);
        throw error;
      });

    this.cachePopulationPromises.set(storeId, fetchPromise);

    return fetchPromise;
  }

  /**
   * Starts the monitor for a specific storeId.
   * Ensures that the monitor restarts upon any error.
   * Implements an exponential backoff strategy for retries.
   * @param {string} storeId - The store identifier to monitor.
   * @param {StoreUpdateCallback} callback - The callback to invoke upon updates.
   */
  private async startMonitor(
    storeId: string,
    callback: StoreUpdateCallback
  ): Promise<void> {
    let retryCount = 0;
    const maxRetryDelay = 60000; // 60 seconds

    while (this.activeMonitors.has(storeId)) {
      try {
        await this.monitorStore(storeId, callback);
        retryCount = 0; // Reset on success
      } catch (error: any) {
        console.error(
          `Registry: Monitor for storeId: ${storeId} encountered an error: ${error.message}. Restarting monitor...`
        );

        const delayTime = maxRetryDelay;
        console.log(
          `Registry: Waiting for ${delayTime / 1000} seconds before retrying...`
        );
        await this.delay(delayTime);
        retryCount++;
      }
    }

    console.log(`Registry: Monitor for storeId: ${storeId} has been stopped.`);
  }

  /**
   * Monitors a single store indefinitely.
   * Executes a single iteration of the monitoring logic.
   * @param {string} storeId - The store identifier to monitor.
   * @param {StoreUpdateCallback} callback - The callback to invoke upon updates.
   */
  private async monitorStore(
    storeId: string,
    callback: StoreUpdateCallback
  ): Promise<void> {
    console.log(`Monitor: Starting monitor iteration for storeId: ${storeId}`);

    try {
      console.log(`Monitor: Connecting to peer for storeId: ${storeId}`);
      const peer = await FullNodePeer.connect();
      const cachedInfo = this.storeCoinCache.get(storeId);

      if (cachedInfo) {
        // Log cached store info retrieval
        console.log(
          `Monitor: Cached store info found for storeId: ${storeId}, syncing...`
        );

        // Deserialize cached info and wait for the coin to be spent
        const previousStore = DataStoreSerializer.deserialize({
          latestStore: cachedInfo.latestStore,
          latestHeight: cachedInfo.latestHeight.toString(),
          latestHash: cachedInfo.latestHash,
        });

        console.log(
          `Monitor: Waiting for coin to be spent for storeId: ${storeId}...`
        );

        const dataStore = DataStore.from(storeId);
        const { createdAtHeight, createdAtHash } =
          await dataStore.getCreationHeight();

        await peer.waitForCoinToBeSpent(
          getCoinId(previousStore.latestStore.coin),
          createdAtHeight,
          createdAtHash
        );

        // Sync store and get updated details
        console.log(`Monitor: Syncing store for storeId: ${storeId}`);
        const { latestStore, latestHeight } = await peer.syncStore(
          previousStore.latestStore,
          createdAtHeight,
          createdAtHash,
          false
        );
        const latestHash = await peer.getHeaderHash(latestHeight);

        console.log(
          `Monitor: Store synced for storeId: ${storeId}, coin id: ${getCoinId(
            latestStore.coin
          ).toString("hex")}`
        );

        // Serialize and cache the updated store info
        const serializedLatestStore = new DataStoreSerializer(
          latestStore,
          latestHeight,
          latestHash
        ).serialize();

        console.log(
          `Monitor: Caching updated store info for storeId: ${storeId}`
        );
        this.storeCoinCache.set(storeId, {
          latestStore: serializedLatestStore,
          latestHeight,
          latestHash: latestHash.toString("hex"),
        });

        // Invoke the callback with updated store info
        const updatedStore = this.storeCoinCache.get(storeId);
        if (updatedStore) {
          callback(storeId, updatedStore);
        } else {
          console.warn(
            `Monitor: Updated store info for storeId: ${storeId} is missing after caching.`
          );
        }

        return; // Successful iteration
      }

      // If no cached info exists, fetch initial store info
      console.log(
        `Monitor: No cached info found for storeId: ${storeId}. Fetching initial store info.`
      );

      // Fetch and cache the latest store info
      const newStore = await this.fetchAndCacheStoreInfo(storeId);

      // Invoke the callback with the new store info
      callback(storeId, newStore);
    } catch (error: any) {
      console.error(
        `Monitor: Error monitoring storeId: ${storeId} - ${error.message}`
      );

      // Propagate the error to trigger a restart in startMonitor
      throw error;
    }
  }

  /**
   * Fetches the latest store information and updates the cache.
   * @param {string} storeId - The store identifier.
   * @returns {Promise<StoreCacheEntry>} The latest store information.
   */
  private async fetchAndCacheStoreInfo(
    storeId: string
  ): Promise<StoreCacheEntry> {
    console.log(
      `Monitor: Fetching and caching latest store info for storeId: ${storeId}`
    );

    const peer = await FullNodePeer.connect();
    const dataStore = DataStore.from(storeId);
    const { createdAtHeight, createdAtHash } =
      await dataStore.getCreationHeight();

    // Sync store from the peer using launcher ID
    console.log(
      `Monitor: Syncing store from launcher ID for storeId: ${storeId}`
    );
    const { latestStore, latestHeight } = await peer.syncStoreFromLauncherId(
      Buffer.from(storeId, "hex"),
      createdAtHeight,
      createdAtHash,
      false
    );

    const latestHash = await peer.getHeaderHash(latestHeight);

    // Serialize and cache the new store info
    const serializedLatestStore = new DataStoreSerializer(
      latestStore,
      latestHeight,
      latestHash
    ).serialize();

    console.log(`Monitor: Caching new store info for storeId: ${storeId}`);
    this.storeCoinCache.set(storeId, {
      latestStore: serializedLatestStore,
      latestHeight,
      latestHash: latestHash.toString("hex"),
    });

    // Return the cached store info
    const newStore = this.storeCoinCache.get(storeId);
    if (!newStore) {
      throw new Error(
        `Failed to cache store info for storeId: ${storeId} after fetching.`
      );
    }

    return newStore;
  }

  /**
   * Utility method to introduce a delay.
   * @param {number} ms - The delay duration in milliseconds.
   * @returns {Promise<void>} Resolves after the specified delay.
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Unregisters a storeId, stopping its monitor.
   * @param {string} storeId - The store identifier to stop monitoring.
   */
  public unregisterStore(storeId: string): void {
    if (this.activeMonitors.has(storeId)) {
      this.activeMonitors.delete(storeId);
      console.log(`Registry: Unregistered monitor for storeId: ${storeId}`);
    } else {
      console.log(`Registry: No active monitor found for storeId: ${storeId}`);
    }
  }

  /**
   * Stops all active monitors and clears the registry.
   * Useful for graceful shutdowns.
   */
  public stopAllMonitors(): void {
    this.activeMonitors.clear();
    console.log(`Registry: All monitors have been stopped.`);
  }
}
