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
        const { storeExists, rootHashExists} = await digPeer.propagationServer.checkStoreExists(
          rootHash
        );

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
          const keyResponse = await digPeer.contentServer.headKey(key, rootHash);
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

  public async syncStoreFromPeers(): Promise<void> {
    console.log("Starting file download process...");
    let peerBlackList: string[] = [];
    let selectedPeer: DigPeer | null = null;

    try {
      const rootHistory: RootHistoryItem[] =
        await this.dataStore.getRootHistory();

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

      // Process filtered rootHistory sequentially
      for (const rootInfo of rootHistoryFiltered) {
        while (true) {
          try {
            // Find a peer with the store and root hash
            selectedPeer = await DigNetwork.findPeerWithStoreKey(
              this.dataStore.StoreId,
              rootInfo.root_hash,
              undefined,
              peerBlackList
            );

            if (!selectedPeer) {
              console.error(
                `No peer found with root hash ${rootInfo.root_hash}. Abort download.`
              );
              
              throw new Error("No peer found with root hash.");
            }

            // Ensure the selected peer has the store by checking with a HEAD request
            const { storeExists, rootHashExists } =
              await selectedPeer.propagationServer.checkStoreExists(
                rootInfo.root_hash
              );

            if (!storeExists) {
              console.warn(
                `Peer ${selectedPeer.IpAddress} does not have the store. Trying another peer...`
              );
              peerBlackList.push(selectedPeer.IpAddress); // Add peer to blacklist and try again
              continue;
            }

            if (!rootHashExists) {
              console.warn(
                `Peer ${selectedPeer.IpAddress} does not have the root hash. Trying another peer...`
              );
              peerBlackList.push(selectedPeer.IpAddress); // Add peer to blacklist and try again
              continue;
            }

            // Download the store root and all associated data from the selected peer
            await selectedPeer.downloadStoreRoot(rootInfo.root_hash);

            peerBlackList = []; // Clear the blacklist upon successful download

            // Break out of the retry loop if the download succeeds
            break;
          } catch (error: any) {
            console.error(
              `Error downloading from peer. Retrying with another peer.`,
              error
            );

            if (selectedPeer) {
              peerBlackList.push(selectedPeer.IpAddress); // Add peer to blacklist and try again
            }
          }
        }

        // Process the latest root hash first, breaking after each success to handle new incoming roots
        break;
      }

      console.log("Syncing store complete.");
    } catch (error: any) {
      if (selectedPeer) {
        peerBlackList.push((selectedPeer as DigPeer).IpAddress);
      }

      throw error;
    }
  }

  // Fetches available peers for the store
  private async fetchAvailablePeers(): Promise<DigPeer[]> {
    //const publicIp: string | null | undefined =
    //   await nconfManager.getConfigValue("publicIp");
    const peers = await this.serverCoin.sampleCurrentEpoch(
      10,
      Array.from(this.peerBlacklist.keys())
    );

    return peers.map((ip: string) => new DigPeer(ip, this.dataStore.StoreId));
  }

  public async downloadFileFromPeers(
    dataPath: string,
    filePath: string,
    overwrite: boolean
  ): Promise<void> {
    let digPeers = await this.fetchAvailablePeers();
    const tempFilePath = `${filePath}.tmp`;

    while (true) {
      if (!overwrite && fs.existsSync(filePath)) return;

      const blacklist = this.peerBlacklist.get(dataPath) || new Set<string>();

      for (const digPeer of digPeers) {
        try {
          if (blacklist.has(digPeer.IpAddress)) continue;

          // Ensure the selected peer has the store by checking with a HEAD request
          const { storeExists } =
            await digPeer.propagationServer.checkStoreExists();

          if (!storeExists) {
            console.warn(
              `Peer ${digPeer.IpAddress} does not have the store. Trying another peer...`
            );
            blacklist.add(digPeer.IpAddress); // Add peer to blacklist and try again
            continue;
          }

          await digPeer.downloadData(dataPath);

          return; // Exit the method if download succeeds
        } catch (error) {
          console.warn(
            `Failed to download ${dataPath} from ${digPeer.IpAddress}, blacklisting peer and trying next...`
          );

          blacklist.add(digPeer.IpAddress);

          // Clean up the temp file in case of failure
          if (fs.existsSync(tempFilePath)) {
            await unlink(tempFilePath);
          }
        }
      }
    }
  }
}
