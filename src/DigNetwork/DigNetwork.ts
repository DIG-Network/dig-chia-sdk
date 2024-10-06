import * as fs from "fs";
import * as path from "path";
import { DigPeer } from "./DigPeer";
import { DataStore, ServerCoin } from "../blockchain";
import { DIG_FOLDER_PATH } from "../utils/config";
import { withTimeout, PeerRanker, PeerMetrics } from "../utils";

export class DigNetwork {
  private dataStore: DataStore;
  private serverCoin: ServerCoin;
  private storeDir: string;
  private peerBlacklist: Map<string, Set<string>>; // Map of file keys to blacklists
  private static networkSyncMap: Map<string, boolean> = new Map();

  constructor(storeId: string) {
    this.dataStore = DataStore.from(storeId);
    this.serverCoin = new ServerCoin(storeId);
    this.storeDir = path.resolve(DIG_FOLDER_PATH, "stores", storeId);
    this.peerBlacklist = new Map<string, Set<string>>(); // Initialize empty map for blacklists
  }

  public static async subscribeToStore(storeId: string): Promise<void> {
    fs.mkdirSync(path.join(DIG_FOLDER_PATH, "stores", storeId), {
      recursive: true,
    });
    const digNetwork = new DigNetwork(storeId);
    await digNetwork.syncStoreFromPeers();
  }

  public static getAllNetworkDataStoreIds(): string[] {
    throw new Error("Method not implemented.");
  }

  public static async getUdiContent(udi: string) {
    throw new Error("Method not implemented.");
  }

  /**
   * Find a peer that has the store key and root hash, using ranked peers first and searching in groups of 5.
   *
   * @param {string} storeId - The ID of the store.
   * @param {string} rootHash - The root hash of the store.
   * @param {string} [key] - Optional key to check for in the store.
   * @returns {Promise<DigPeer | null>} - A valid peer or null if none found.
   */
  public static async findPeerWithStoreKey(
    storeId: string,
    rootHash: string,
    key?: string
  ): Promise<DigPeer | null> {
    const serverCoin = new ServerCoin(storeId);

    try {
      // Fetch all active peers for the current epoch
      const digPeers = await serverCoin.getActiveEpochPeers();

      // If no peers are returned, exit early
      if (digPeers.length === 0) {
        console.log("No peers found.");
        return null;
      }

      // Initialize PeerRanker with the list of digPeers (IP addresses)
      const peerRanker = new PeerRanker(digPeers);

      // Rank the peers based on latency and bandwidth
      const rankedPeers = await peerRanker.rankPeers();

      // If no peers are returned after ranking, exit early
      if (rankedPeers.length === 0) {
        console.log("No valid peers found after ranking.");
        return null;
      }

      // Define the iterator function to process each peer
      const iteratorFn = async (
        peerMetrics: PeerMetrics
      ): Promise<DigPeer | null> => {
        const peerIp = peerMetrics.ip;
        try {
          const digPeer = new DigPeer(peerIp, storeId);

          // Wrap the store check with a 10-second timeout
          const { storeExists, rootHashExists } = await withTimeout(
            digPeer.propagationServer.checkStoreExists(rootHash),
            10000,
            `Timeout while checking store on peer ${peerIp}`
          );

          // Check if the store and root hash exist on the peer
          if (storeExists && rootHashExists) {
            console.log(
              `Found Peer at ${peerIp} for storeId: ${storeId}, root hash ${rootHash}`
            );

            // If no key is provided, return the peer
            if (!key) {
              return digPeer;
            }

            // If key is provided, wrap key check with a 10-second timeout
            const keyResponse = await withTimeout(
              digPeer.contentServer.headKey(key, rootHash),
              10000,
              `Timeout while checking key on peer ${peerIp}`
            );

            if (keyResponse.headers?.["x-key-exists"] === "true") {
              return digPeer;
            }
          }
        } catch (error: any) {
          console.error(
            `Error connecting to DIG Peer ${peerIp}:`,
            error.message
          );
        }

        // If the peer does not meet the criteria, return null
        return null;
      };

      // Use Promise.race to return the first valid peer found
      const validPeer = await Promise.race(
        rankedPeers.map((peer) => iteratorFn(peer))
      );

      // Return the first valid peer or null if none is found
      return validPeer || null;
    } catch (error) {
      console.error("Error sampling peers:", error);
      return null;
    }
  }

  public static unsubscribeFromStore(storeId: string): void {
    fs.rmdirSync(path.join(DIG_FOLDER_PATH, "stores", storeId), {
      recursive: true,
    });
    fs.unlinkSync(path.join(DIG_FOLDER_PATH, "stores", storeId + ".json"));
  }

  public static async pingNetworkOfUpdate(
    storeId: string,
    rootHash: string
  ): Promise<void> {
    const serverCoin = new ServerCoin(storeId);
    // When an update is made, ping 10 network peers to pull updates from this store
    const digPeers = await serverCoin.sampleCurrentEpoch(10);
    for (const peer of digPeers) {
      const digPeer = new DigPeer(peer, storeId);
      await withTimeout(
        digPeer.propagationServer.pingUpdate(rootHash),
        5000,
        `headKey timed out for peer ${digPeer.IpAddress}`
      );
    }
  }

  public async syncStoreFromPeers(
    prioritizedPeer?: DigPeer,
    maxRootsToProcess?: number
  ): Promise<void> {
    // Check if synchronization is already active for this storeId
    if (DigNetwork.networkSyncMap.get(this.dataStore.StoreId)) {
      return;
    }
    console.log("Starting network sync for store:", this.dataStore.StoreId);
    DigNetwork.networkSyncMap.set(this.dataStore.StoreId, true);

    try {
      const rootHistory = await this.dataStore.getRootHistory();

      if (!rootHistory.length) {
        throw new Error(
          "No roots found in rootHistory. Cannot proceed with file download."
        );
      }

      // Filter out rootInfo entries where the .dat file already exists
      const rootHistoryFiltered = rootHistory
        .filter((item) => item.timestamp !== undefined)
        .filter(
          (item) => !fs.existsSync(`${this.storeDir}/${item.root_hash}.dat`)
        )
        .reverse(); // Reverse to download the latest first

      if (!rootHistoryFiltered.length) {
        console.log(
          "All root hashes already exist locally. No need for download."
        );
        return;
      }

      // If maxRootsToProcess is specified, limit the number of roots processed
      const rootsToProcess = maxRootsToProcess
        ? rootHistoryFiltered.slice(0, maxRootsToProcess)
        : rootHistoryFiltered;

      // Process the root hashes sequentially
      for (const rootInfo of rootsToProcess) {
        try {
          let selectedPeer: DigPeer | null = prioritizedPeer || null;

          if (!selectedPeer) {
            // Use the `findPeerWithStoreKey` method to find a peer with the store and root hash
            selectedPeer = await DigNetwork.findPeerWithStoreKey(
              this.dataStore.StoreId,
              rootInfo.root_hash
            );
          }

          if (!selectedPeer) {
            console.error(
              `No peer found with root hash ${rootInfo.root_hash}. Moving to next root.`
            );
            continue; // Move to the next rootInfo
          }

          // Download the store root and associated data
          await selectedPeer.downloadStoreRoot(rootInfo.root_hash);

          // Break after successful download to proceed to next root hash
        } catch (error: any) {
          if (error.message)
            console.error(
              `Error downloading from peer ${prioritizedPeer?.IpAddress}. Retrying with another peer.`,
              error
            );
          // Continue to next rootInfo in case of error
        }
      }

      console.log("Syncing store complete.");
    } catch (error: any) {
      console.error("Error during syncing store from peers:", error);
      throw error;
    } finally {
      // Mark synchronization as inactive for this storeId
      DigNetwork.networkSyncMap.set(this.dataStore.StoreId, false);
      console.log(
        `Network sync for storeId: ${this.dataStore.StoreId} has completed.`
      );
    }
  }

  // Fetches available peers for the store
  public async fetchAvailablePeers(): Promise<DigPeer[]> {
    //const publicIp: string | null | undefined =
    //   await nconfManager.getConfigValue("publicIp");
    const peers = await this.serverCoin.sampleCurrentEpoch(
      10,
      Array.from(this.peerBlacklist.keys())
    );

    return peers.map((ip: string) => new DigPeer(ip, this.dataStore.StoreId));
  }
}
