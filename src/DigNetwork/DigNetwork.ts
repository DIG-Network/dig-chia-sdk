import * as fs from "fs";
import * as path from "path";
import { DigPeer } from "./DigPeer";
import { DataStore, ServerCoin } from "../blockchain";
import { DIG_FOLDER_PATH } from "../utils/config";
import { RootHistoryItem } from "../types";
import { promisify } from "util";

const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);

export class DigNetwork {
  private dataStore: DataStore;
  private serverCoin: ServerCoin;
  private storeDir: string;
  private peerBlacklist: Map<string, Set<string>>; // Map of file keys to blacklists

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
    intialBlackList: string[] = []
  ): Promise<DigPeer | null> {
    const peerBlackList: string[] = intialBlackList;
    const serverCoin = new ServerCoin(storeId);
    let peerIp: string | null = null;

    // Keep sampling peers until an empty array is returned
    while (true) {
      try {
        // Sample a peer from the current epoch
        const digPeers = await serverCoin.sampleCurrentEpoch(1, peerBlackList);

        // If no peers are returned, break out of the loop
        if (digPeers.length === 0) {
          console.log("No more peers found.");
          break;
        }

        peerIp = digPeers[0];
        const digPeer = new DigPeer(peerIp, storeId);

        // Try to fetch the head store information
        const { storeExists, rootHashExists } =
          await digPeer.propagationServer.checkStoreExists(rootHash);

        // If the peer has the correct root hash, check if key is required
        if (storeExists && rootHashExists) {
          console.log(
            `Found Peer at ${peerIp} for storeId: ${storeId}, root hash ${rootHash}`
          );

          // If no key is provided, return the peer
          if (!key) {
            return digPeer;
          }

          // If key is provided, check if the peer has it
          const keyResponse = await digPeer.contentServer.headKey(
            key,
            rootHash
          );
          if (keyResponse.headers?.["x-key-exists"] === "true") {
            return digPeer;
          }
        }

        // Add peer to blacklist if it doesn't meet criteria
        peerBlackList.push(peerIp);
      } catch (error) {
        console.error(`Error connecting to DIG Peer ${peerIp}. Resampling...`);
        if (peerIp) {
          peerBlackList.push(peerIp); // Add to blacklist if error occurs
        }
      }
    }

    // Return null if no valid peer was found
    return null;
  }

  public static unsubscribeFromStore(storeId: string): void {
    fs.rmdirSync(path.join(DIG_FOLDER_PATH, "stores", storeId), {
      recursive: true,
    });
    fs.unlinkSync(path.join(DIG_FOLDER_PATH, "stores", storeId + ".json"));
  }

  public static async pingNetworkOfUpdate(storeId: string, rootHash: string): Promise<void> {
    const serverCoin = new ServerCoin(storeId);
    // When an update is made, ping 10 network peers to pull updates from this store
    const digPeers = await serverCoin.sampleCurrentEpoch(10);
    for (const peer of digPeers) {
      const digPeer = new DigPeer(peer, storeId);
      await digPeer.propagationServer.pingUpdate(rootHash);
    }
  }

  public async syncStoreFromPeers(
    prioritizedPeer?: DigPeer,
    maxRootsToProcess?: number
  ): Promise<void> {
    console.log("Starting file download process...");
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
