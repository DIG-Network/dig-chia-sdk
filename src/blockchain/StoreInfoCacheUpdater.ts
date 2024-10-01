import { setInterval } from "timers";
import { FullNodePeer } from "./FullNodePeer";
import { FileCache } from "../utils";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { withTimeout } from "../utils";

export class StoreInfoCacheUpdater {
  private static instance: StoreInfoCacheUpdater;
  private storeCoinCache: FileCache<{
    latestStore: ReturnType<DataStoreSerializer["serialize"]>;
    latestHeight: number;
    latestHash: string;
  }>;
  private updateInterval: number;

  private constructor(updateIntervalInMinutes: number = 5) {
    this.storeCoinCache = new FileCache(`stores`);
    this.updateInterval = updateIntervalInMinutes * 60 * 1000; // Convert minutes to milliseconds
    this.startCacheUpdater();
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
    } catch (error) {
      console.error("Failed to update store cache:", error);
    }
  }
}
