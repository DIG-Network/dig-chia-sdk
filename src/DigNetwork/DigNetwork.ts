import * as fs from "fs";
import * as path from "path";
import { MultiBar, Presets } from "cli-progress";
import { DigPeer } from "./DigPeer";
import { getDeltaFiles } from "../utils/deltaUtils";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { DataStore, ServerCoin } from "../blockchain";
import { DIG_FOLDER_PATH } from "../utils/config";
import { RootHistoryItem } from "../types";
import { promisify } from "util";
import { DataIntegrityTree } from "../DataIntegrityTree";

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

  private async uploadPreflight(
    digPeer: DigPeer
  ): Promise<{ generationIndex: number; lastLocalRootHash: string }> {
    // Preflight check is handled internally by PropagationServer if needed
    const { lastUploadedHash, generationIndex } =
      await digPeer.propagationServer.getUploadDetails();

    const rootHistory = await this.dataStore.getLocalRootHistory();

    if (!rootHistory || rootHistory.length === 0) {
      throw new Error(
        "No root hashes found. Please commit your changes first."
      );
    }

    const lastLocalRootHash = rootHistory[rootHistory.length - 1].root_hash;
    const localGenerationIndex = rootHistory.length - 1;

    // Handle conditions based on the upload details
    if (
      lastUploadedHash !== lastLocalRootHash &&
      generationIndex === localGenerationIndex
    ) {
      throw new Error(
        "The repository seems to be corrupted. Please pull the latest changes before pushing."
      );
    }

    if (
      lastUploadedHash === lastLocalRootHash &&
      generationIndex === localGenerationIndex
    ) {
      throw new Error("No changes detected. Skipping push.");
    }

    if (
      lastUploadedHash !== lastLocalRootHash &&
      generationIndex > localGenerationIndex
    ) {
      throw new Error(
        "Remote repository is ahead of the local repository. Please pull the latest changes before pushing."
      );
    }
    return { generationIndex, lastLocalRootHash };
  }

  public async uploadStoreHead(digPeer: DigPeer): Promise<void> {
    // First make sure that the remote store is up to date.
    const rootHistory = await this.dataStore.getRootHistory();
    const localManifestHashes = await this.dataStore.getManifestHashes();
    const remoteManifestFile = await digPeer.propagationServer.getStoreData(
      "manifest.dat"
    );

    const remoteManifestHashes = remoteManifestFile.split("\n").filter(Boolean);
    const onChainRootHashes = rootHistory.map((root) => root.root_hash);

    // Check that remote manifest is one behind on-chain root hashes
    if (remoteManifestHashes.length !== onChainRootHashes.length - 1) {
      throw new Error(
        "Remote manifest should be one behind the on-chain root. Cannot push head."
      );
    }

    // Compare each remote manifest hash with the corresponding on-chain root hash
    for (let i = 0; i < remoteManifestHashes.length; i++) {
      if (remoteManifestHashes[i] !== onChainRootHashes[i]) {
        throw new Error(
          `Remote manifest does not match on-chain root at index ${i}. Cannot push head.`
        );
      }
    }

    // Get the files for the latest local manifest hash
    const filesToUpload = await this.dataStore.getFileSetForRootHash(
      localManifestHashes[localManifestHashes.length - 1]
    );

    if (!filesToUpload.length) {
      console.log("No files to upload.");
      return;
    }

    // Upload files to the remote peer with a progress bar
    await this.runProgressBar(
      filesToUpload.length,
      "Store Data",
      async (progress) => {
        for (const filePath of filesToUpload) {
          const relativePath = path
            .relative(this.storeDir, filePath)
            .replace(/\\/g, "/");
          await digPeer.propagationServer.pushFile(filePath, relativePath);
          progress.increment();
        }
      }
    );
  }

  // Uploads the store to a specific peer
  public async uploadStore(digPeer: DigPeer): Promise<void> {
    const { generationIndex } = await this.uploadPreflight(digPeer);

    const filesToUpload = await getDeltaFiles(
      this.dataStore.StoreId,
      generationIndex,
      path.resolve(DIG_FOLDER_PATH, "stores")
    );

    if (!filesToUpload.length) {
      console.log("No files to upload.");
      return;
    }

    await this.runProgressBar(
      filesToUpload.length,
      "Store Data",
      async (progress) => {
        for (const filePath of filesToUpload) {
          const relativePath = path
            .relative(this.storeDir, filePath)
            .replace(/\\/g, "/");
          await digPeer.propagationServer.pushFile(filePath, relativePath);
          progress.increment();
        }
      }
    );
  }

  public static async subscribeToStore(storeId: string): Promise<void> {
    fs.mkdirSync(path.join(DIG_FOLDER_PATH, "stores", storeId), {
      recursive: true,
    });
    const digNetwork = new DigNetwork(storeId);
    await digNetwork.downloadFiles(true);
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
        const storeResponse = await digPeer.contentServer.headStore({
          hasRootHash: rootHash,
        });

        // If the peer has the correct root hash, check if key is required
        if (storeResponse.headers?.["x-has-roothash"] === "true") {
          console.log(
            `Found Peer at ${peerIp} for storeId: ${storeId}, root hash ${rootHash}`
          );

          // If no key is provided, return the peer
          if (!key) {
            return digPeer;
          }

          // If key is provided, check if the peer has it
          const keyResponse = await digPeer.contentServer.headKey(key);
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

  // Downloads files from the network based on the manifest
  public async downloadFiles(
    forceDownload: boolean = false,
    renderProgressBar: boolean = true,
    skipData: boolean = false
  ): Promise<void> {
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

      await this.downloadHeightFile(true);

      // Filter out rootInfo entries where the .dat file already exists
      const rootHistoryFiltered = rootHistory
        .filter((item) => item.timestamp !== undefined)
        .filter(
          (item) => !fs.existsSync(`${this.storeDir}/${item.root_hash}.dat`)
        )
        .reverse();

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
            selectedPeer = await DigNetwork.findPeerWithStoreKey(
              this.dataStore.StoreId,
              rootInfo.root_hash,
              undefined,
              peerBlackList
            );

            if (!selectedPeer) {
              console.error(
                `No peer found with root hash ${rootInfo.root_hash}. Skipping download.`
              );
              break; // Exit loop if no more peers are found
            }

            const rootResponse =
              await selectedPeer.propagationServer.getStoreData(
                `${rootInfo.root_hash}.dat`
              );

            const root = JSON.parse(rootResponse);

            if (!skipData) {
              // Explicitly define the type for file entries
              interface FileEntry {
                sha256: string;
              }

              // Sequential file download
              for (const [storeKey, file] of Object.entries<FileEntry>(
                root.files
              )) {
                const filePath = getFilePathFromSha256(
                  file.sha256,
                  `${this.storeDir}/data`
                );

                if (!fs.existsSync(filePath) || forceDownload) {
                  console.log(
                    `Downloading file with sha256: ${file.sha256}...`
                  );

                  await selectedPeer.downloadData(
                    this.dataStore.StoreId,
                    `data/${file.sha256.match(/.{1,2}/g)!.join("/")}`
                  );

                  const integrityCheck =
                    await DataIntegrityTree.validateKeyIntegrityWithForeignTree(
                      storeKey,
                      file.sha256,
                      root,
                      rootInfo.root_hash,
                      `${this.storeDir}/data`
                    );

                  if (integrityCheck) {
                    console.log(
                      `\x1b[32mIntegrity check passed for file with sha256: ${file.sha256}.\x1b[0m`
                    );
                    continue;
                  }

                  console.error(
                    `\x1b[31mIntegrity check failed for file with sha256: ${file.sha256}.\x1b[0m`
                  );
                  await unlink(filePath);
                  throw new Error(`Store Integrity check failed. Syncing file from another peer.`);
                }
              }
            }

            fs.writeFileSync(
              `${this.storeDir}/${rootInfo.root_hash}.dat`,
              rootResponse
            );
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
      }

      await this.downloadManifestFile(true);

      console.log("Syncing store complete.");
    } catch (error: any) {
      if (selectedPeer) {
        peerBlackList.push(selectedPeer.IpAddress);
      }

      console.trace(error);
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

  private async downloadHeightFile(forceDownload: boolean): Promise<void> {
    const heightFilePath = path.join(this.storeDir, "height.json");
    await this.downloadFileFromPeers(
      "height.json",
      heightFilePath,
      forceDownload
    );
  }

  private async downloadManifestFile(forceDownload: boolean): Promise<void> {
    const heightFilePath = path.join(this.storeDir, "manifest.dat");
    await this.downloadFileFromPeers(
      "manifest.dat",
      heightFilePath,
      forceDownload
    );
  }

  private async downloadFileFromPeers(
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

          const response = await digPeer.propagationServer.headStore();

          if (!response.success) {
            continue;
          }

          // Create directory if it doesn't exist
          const directory = path.dirname(tempFilePath);
          if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
          }

          // Stream the file data to a temporary file
          const fileStream = fs.createWriteStream(tempFilePath);

          // Start streaming the data from the peer
          const peerStream = await digPeer.propagationServer.streamStoreData(
            dataPath
          );

          // Pipe the peer stream to the temp file
          await new Promise<void>((resolve, reject) => {
            peerStream.pipe(fileStream);

            peerStream.on("end", resolve);
            peerStream.on("error", reject);
            fileStream.on("error", reject);
          });

          // Rename the temp file to the final file path after successful download
          await rename(tempFilePath, filePath);

          if (process.env.DIG_DEBUG === "1") {
            console.log(`Downloaded ${dataPath} from ${digPeer.IpAddress}`);
          }

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

      this.peerBlacklist.set(dataPath, blacklist);

      if (blacklist.size >= digPeers.length) {
        if (process.env.DIG_DEBUG === "1") {
          console.warn(
            `All peers blacklisted for ${dataPath}. Refreshing peers...`
          );
        }

        digPeers = await this.fetchAvailablePeers();
        if (!digPeers.length) {
          throw new Error(
            `Failed to download ${dataPath}: no peers available.`
          );
        }
      }
    }
  }

  private async runProgressBar(
    total: number,
    name: string,
    task: (progress: any) => Promise<void>
  ): Promise<void> {
    // Using 'any' to work around TypeScript issues
    const multiBar = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: "{bar} | {percentage}% | {name}",
        noTTYOutput: true,
      },
      Presets.shades_classic
    );
    const progress = multiBar.create(total, 0, { name });
    await task(progress).finally(() => {
      multiBar.stop();
    });
  }
}
