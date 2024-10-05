import * as fs from "fs";
import * as path from "path";
import { DigPeer } from "./DigPeer";
import { DataStore, ServerCoin } from "../blockchain";
import { DIG_FOLDER_PATH } from "../utils/config";
import { withTimeout } from "../utils";

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

  public static async getUdiContent(udi: string) {
    // TODO: Implement this method
  }

  public static async findPeerWithStoreKey(
    storeId: string,
    rootHash: string,
    key?: string,
    initialBlackList: string[] = []
  ): Promise<DigPeer | null> {
    const peerBlackList: string[] = initialBlackList;
    const serverCoin = new ServerCoin(storeId);
    const allPeers: string[] = await serverCoin.getActiveEpochPeers();

    while (true) {
      try {
        // Sample 10 peers from the current epoch
        const digPeers = await serverCoin.sampleCurrentEpoch(10, peerBlackList);

        // If no peers are returned, break out of the loop
        if (digPeers.length === 0) {
          console.log("No more peers found.");
          break;
        }

        // Create a race of promises for all peers
        const peerPromises = digPeers.map((peerIp) => {
          return new Promise<DigPeer | null>(async (resolve) => {
            try {
              const digPeer = new DigPeer(peerIp, storeId);
              const { storeExists, rootHashExists } =
                await digPeer.propagationServer.checkStoreExists(rootHash);

              // Check if the store and root hash exist on the peer
              if (storeExists && rootHashExists) {
                console.log(
                  `Found Peer at ${peerIp} for storeId: ${storeId}, root hash ${rootHash}`
                );

                // If no key is provided, resolve the peer
                if (!key) {
                  return resolve(digPeer);
                }

                // If key is provided, check if the peer has it
                const keyResponse = await digPeer.contentServer.headKey(
                  key,
                  rootHash
                );
                if (keyResponse.headers?.["x-key-exists"] === "true") {
                  return resolve(digPeer);
                }
              }
            } catch (error) {
              console.error(`Error connecting to DIG Peer ${peerIp}.`);
            }

            // If the peer does not meet the criteria, resolve with null
            resolve(null);
          });
        });

        // Wait for the first valid peer that resolves
        const firstValidPeer = await Promise.race(peerPromises);

        // If a valid peer is found, return it
        if (firstValidPeer) {
          return firstValidPeer;
        }

        // If none of the peers were valid, add them to the blacklist
        digPeers.forEach((peerIp) => peerBlackList.push(peerIp));

        // Retry with the next set of peers
        console.log("No valid peers found, retrying with new peers...");
      } catch (error) {
        console.error("Error sampling peers. Resampling...");
      }
    }

    // Return null if no valid peer was found after all attempts
    return null;
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
    let peerBlackList: string[] = [];

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
        let selectedPeer: DigPeer | null = null;

        while (true) {
          try {
            // Find a peer with the store and root hash
            if (prioritizedPeer) {
              selectedPeer = prioritizedPeer;
            } else {
              selectedPeer = await DigNetwork.findPeerWithStoreKey(
                this.dataStore.StoreId,
                rootInfo.root_hash,
                undefined,
                peerBlackList
              );
            }

            if (!selectedPeer) {
              console.error(
                `No peer found with root hash ${rootInfo.root_hash}. Moving to next root.`
              );
              break; // Exit the while loop to proceed to the next rootInfo
            }

            // Check if the selected peer has the store and root hash
            const { storeExists, rootHashExists } =
              await selectedPeer.propagationServer.checkStoreExists(
                rootInfo.root_hash
              );

            if (!storeExists || !rootHashExists) {
              console.warn(
                `Peer ${selectedPeer.IpAddress} does not have the required store or root hash. Trying another peer...`
              );
              peerBlackList.push(selectedPeer.IpAddress); // Blacklist and retry
              continue;
            }

            // Download the store root and associated data
            await selectedPeer.downloadStoreRoot(rootInfo.root_hash);

            // Clear the blacklist upon successful download
            peerBlackList = [];

            // Break after successful download to proceed to next root hash
            break;
          } catch (error: any) {
            if (error.message)
              console.error(
                `Error downloading from peer ${selectedPeer?.IpAddress}. Retrying with another peer.`,
                error
              );
            if (selectedPeer) {
              peerBlackList.push(selectedPeer.IpAddress); // Blacklist and retry
            }
          }
        }
      }

      console.log("Syncing store complete.");
    } catch (error: any) {
      console.error("Error during syncing store from peers:", error);
      throw error;
    } finally {
      // Mark synchronization as inactive for this storeId
      DigNetwork.networkSyncMap.set(this.dataStore.StoreId, false);
      console.log(`Network sync for storeId: ${this.dataStore.StoreId} has completed.`);
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
