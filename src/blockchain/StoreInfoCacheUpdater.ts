import fs from "fs";
import { FullNodePeer } from "./FullNodePeer";
import { FileCache, USER_DIR_PATH, DIG_FOLDER_PATH } from "../utils";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { withTimeout } from "../utils";
import * as lockfile from "proper-lockfile";
import * as path from "path";
import {
  getCoinId,
  Peer,
  getMainnetGenesisChallenge,
} from "@dignetwork/datalayer-driver";

export class StoreInfoCacheUpdater {
  private static instance: StoreInfoCacheUpdater;
  private storeCoinCache: FileCache<{
    latestStore: ReturnType<DataStoreSerializer["serialize"]>;
    latestHeight: number;
    latestHash: string;
  }>;
  private monitors: Map<string, Promise<void>> = new Map();
  private lockFilePath: string;
  private releaseLock: (() => Promise<void>) | null = null;
  private isMonitoring: boolean = true;

  private constructor() {
    this.storeCoinCache = new FileCache(`stores`, USER_DIR_PATH);

    // Construct lock file path using the path module
    this.lockFilePath = path.join(DIG_FOLDER_PATH, "store-info-cache.lock");

    const lockDir = path.dirname(this.lockFilePath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Start monitors for existing storeIds
    this.startMonitors();
  }

  public static initInstance(): StoreInfoCacheUpdater {
    if (!StoreInfoCacheUpdater.instance) {
      console.log("Initializing DataStore Monitor");
      StoreInfoCacheUpdater.instance = new StoreInfoCacheUpdater();
    }
    return StoreInfoCacheUpdater.instance;
  }

  private async startMonitors() {
    try {
      // Check if the lockfile is already held
      const isLocked = await lockfile.check(this.lockFilePath, {
        realpath: false,
      });
      if (isLocked) {
        // Another process is already running the monitors; skip starting monitors
        console.log(
          "Another process is already running the StoreInfoCacheUpdater."
        );
        return;
      }

      // Attempt to acquire the lock
      this.releaseLock = await lockfile.lock(this.lockFilePath, {
        retries: {
          retries: 0, // No retries since we only need one lock
        },
        stale: 60000, // Lock expires after 1 minute (adjust as needed)
        realpath: false, // Ensure lockfile uses the exact path
      });

      const storeIds = this.storeCoinCache.getCachedKeys();

      for (const storeId of storeIds) {
        // Check if a monitor is already running for this storeId
        if (!this.monitors.has(storeId)) {
          // Start monitoring in the background
          const monitorPromise = this.monitorStore(storeId);
          this.monitors.set(storeId, monitorPromise);
        }
      }

      // Wait for all monitors to settle
      const monitorPromises = Array.from(this.monitors.values());

      await Promise.all(monitorPromises);
    } catch (error: any) {
      console.error("Monitor system encountered an error:", error);
    } finally {
      // Release the lock
      if (this.releaseLock) {
        try {
          await this.releaseLock();
          console.log("Lock released successfully.");
        } catch (releaseError) {
          console.error("Error releasing the lock:", releaseError);
        }
      }
    }
  }

  // Monitor a single store's coin
  private async monitorStore(storeId: string): Promise<void> {
    while (this.isMonitoring) {
      let peer: Peer | null = null;
      try {
        // Connect to a peer
        peer = await withTimeout(
          FullNodePeer.connect(),
          60000,
          "Timeout connecting to FullNodePeer"
        );

        // Get the latest store info (from cache if available)
        const cachedInfo = this.storeCoinCache.get(storeId);
        if (!cachedInfo) {
          // If no cached info, skip and wait before retrying
          console.error(`No cached info for storeId ${storeId}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        const {
          latestStore: serializedStore,
          latestHeight,
          latestHash,
        } = cachedInfo;

        const { latestStore } = DataStoreSerializer.deserialize({
          latestStore: serializedStore,
          latestHeight: latestHeight.toString(),
          latestHash: latestHash,
        });

        // Get the coinId associated with the store
        const coinId = getCoinId(latestStore.coin);

        console.log(`Waiting for coin to be spent: ${coinId.toString("hex")}`);

        // Wait for the coin to be spent
        await peer.waitForCoinToBeSpent(
          coinId,
          latestHeight,
          Buffer.from(latestHash, "hex")
        );

        console.log(`Detected Coin Spend: ${coinId.toString("hex")}`);

        let updatedStore, newHeight;

        try {
          // When resolved, sync the store
          //const { latestStore: updatedStore, latestHeight: newHeight } = await withTimeout(
          const storeInfo = await withTimeout(
            peer.syncStore(
              latestStore,
              latestHeight,
              Buffer.from(latestHash, "hex"),
              false // withHistory
            ),
            60000,
            `Timeout syncing store for storeId ${storeId}`
          );

          updatedStore = storeInfo.latestStore;
          newHeight = storeInfo.latestHeight;
        } catch {
          const genesisChallenge = await getMainnetGenesisChallenge();
          const storeInfo = await withTimeout(
            peer.syncStore(latestStore, null, genesisChallenge, false),
            60000,
            `Timeout syncing store for storeId ${storeId}`
          );

          updatedStore = storeInfo.latestStore;
          newHeight = storeInfo.latestHeight;
        }

        // Get the latest header hash
        const latestHashBuffer = await withTimeout(
          peer.getHeaderHash(newHeight),
          60000,
          `Timeout getting header hash for height ${newHeight}`
        );

        // Serialize the updated store data for caching
        const serializedLatestStore = new DataStoreSerializer(
          updatedStore,
          newHeight,
          latestHashBuffer
        ).serialize();

        // Update the cache
        this.storeCoinCache.set(storeId, {
          latestStore: serializedLatestStore,
          latestHeight: newHeight,
          latestHash: latestHashBuffer.toString("hex"),
        });

        peer = null;

        // Continue monitoring
      } catch (error) {
        console.error(`Error monitoring store ${storeId}:`, error);

        // Close the peer connection if it's open
        if (peer) {
          peer = null;
        }

        // Determine if the error is unrecoverable
        if (this.isUnrecoverableError(error)) {
          this.isMonitoring = false; // Signal other monitors to stop
          throw error; // Propagate error up to stop monitoring
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private isUnrecoverableError(error: any): boolean {
    // Determine whether the error is unrecoverable
    // For this example, we'll treat any unexpected error as unrecoverable
    // You can customize this logic based on your application's needs
    return true;
  }
}
