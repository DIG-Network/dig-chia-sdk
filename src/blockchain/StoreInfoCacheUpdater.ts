import { setInterval } from "timers";
import { FullNodePeer } from "./FullNodePeer";
import { FileCache } from "../utils";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { withTimeout } from "../utils";
import * as lockfile from 'proper-lockfile';
import * as fs from 'fs';
import * as path from 'path';
import { DIG_FOLDER_PATH } from "../utils";

export class StoreInfoCacheUpdater {
  private static instance: StoreInfoCacheUpdater;
  private storeCoinCache: FileCache<{
    latestStore: ReturnType<DataStoreSerializer["serialize"]>;
    latestHeight: number;
    latestHash: string;
  }>;
  private updateInterval: number;
  private lockFilePath: string; // Lock file path in DIG_FOLDER_PATH
  private releaseLock: (() => Promise<void>) | null = null; // Holds the release function for cleanup

  private constructor(updateIntervalInMinutes: number = 5) {
    this.storeCoinCache = new FileCache(`stores`);
    this.updateInterval = updateIntervalInMinutes * 60 * 1000; // Convert minutes to milliseconds

    // Construct lock file path using the path module
    this.lockFilePath = path.join(DIG_FOLDER_PATH, 'store-info-cache.lock');

    this.startCacheUpdater();

    // Set up process exit handlers for cleanup
    this.setupExitHandlers();
  }

  public static initInstance(): StoreInfoCacheUpdater {
    if (!StoreInfoCacheUpdater.instance) {
      StoreInfoCacheUpdater.instance = new StoreInfoCacheUpdater();
    }
    return StoreInfoCacheUpdater.instance;
  }

  private startCacheUpdater() {
    setInterval(() => this.updateCache(), this.updateInterval);
  }

  private async updateCache() {
    try {
      // Ensure the lock file exists before attempting to lock
      if (!fs.existsSync(this.lockFilePath)) {
        fs.writeFileSync(this.lockFilePath, '');
      }

      // Acquire a file lock with stale lock duration matching the update interval
      const release = await lockfile.lock(this.lockFilePath, {
        retries: {
          retries: 10, // Retry 10 times to acquire the lock
          factor: 2,
          minTimeout: 100,
          maxTimeout: 1000,
        },
        stale: this.updateInterval, // Lock expires after the update interval
      });

      // Store the release function for cleanup during process exit
      this.releaseLock = release;

      try {
        const storeIds = this.storeCoinCache.getCachedKeys();

        for (const storeId of storeIds) {
          try {
            const cachedInfo = this.storeCoinCache.get(storeId);

            if (!cachedInfo) {
              continue;
            }

            // Deserialize the cached store info
            const { latestStore: serializedStore, latestHeight, latestHash } =
              cachedInfo;

            const { latestStore: previousInfo } = DataStoreSerializer.deserialize({
              latestStore: serializedStore,
              latestHeight: latestHeight.toString(),
              latestHash: latestHash,
            });

            // Wrap the connection with a timeout
            const peer = await withTimeout(
              FullNodePeer.connect(),
              60000,
              "Timeout connecting to FullNodePeer"
            );

            // Wrap the syncStore call with a timeout
            const { latestStore, latestHeight: newHeight } = await withTimeout(
              peer.syncStore(
                previousInfo,
                latestHeight,
                Buffer.from(latestHash, "hex"),
                false
              ),
              60000,
              `Timeout syncing store for storeId ${storeId}`
            );

            // Wrap the getHeaderHash call with a timeout
            const latestHashBuffer = await withTimeout(
              peer.getHeaderHash(newHeight),
              60000,
              `Timeout getting header hash for height ${newHeight}`
            );

            // Serialize the updated store data for caching
            const serializedLatestStore = new DataStoreSerializer(
              latestStore,
              newHeight,
              latestHashBuffer
            ).serialize();

            // Recache the updated store info
            this.storeCoinCache.set(storeId, {
              latestStore: serializedLatestStore,
              latestHeight: newHeight,
              latestHash: latestHashBuffer.toString("hex"),
            });
          } catch (error) {
            console.error(`Failed to update cache for storeId ${storeId}:`, error);
            // Optionally handle specific errors or continue with the next storeId
          }
        }
      } finally {
        // Always release the lock after finishing the update
        await this.releaseLock?.();
        this.releaseLock = null;
      }
    } catch (error) {
      console.error("Failed to update store cache:", error);
    }
  }

  private setupExitHandlers() {
    const cleanup = async () => {
      if (this.releaseLock) {
        try {
          await this.releaseLock();
          console.log("Lock released successfully on process exit.");
        } catch (error) {
          console.error("Failed to release lock on exit:", error);
        }
      }
    };

    // Listen for process exit events and call cleanup
    process.on('SIGINT', cleanup);  // Catch CTRL+C
    process.on('SIGTERM', cleanup); // Catch termination signals
    process.on('exit', cleanup);    // On normal exit
    process.on('uncaughtException', async (error) => {
      console.error("Uncaught exception, cleaning up:", error);
      await cleanup();
      process.exit(1); // Ensure process exits after handling exception
    });
  }
}
