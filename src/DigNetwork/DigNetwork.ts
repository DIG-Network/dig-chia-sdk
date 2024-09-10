import * as fs from "fs";
import * as path from "path";
import { MultiBar, Presets } from "cli-progress";
import { DigPeer } from "./DigPeer";
import { getDeltaFiles } from "../utils/deltaUtils";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { DataStore, ServerCoin } from "../blockchain";
import { DIG_FOLDER_PATH } from "../utils/config";

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
    try {
      const rootHistory = await this.dataStore.getRootHistory();
      if (!rootHistory.length)
        throw new Error(
          "No roots found in rootHistory. Cannot proceed with file download."
        );

      await this.downloadHeightFile(forceDownload);

      const localManifestPath = path.join(this.storeDir, "manifest.dat");
      const localManifestHashes = fs.existsSync(localManifestPath)
        ? fs.readFileSync(localManifestPath, "utf-8").trim().split("\n")
        : [];

      const progressBar = renderProgressBar
        ? new MultiBar(
            {
              clearOnComplete: false,
              hideCursor: true,
              format: "Syncing Store | {bar} | {percentage}%",
              noTTYOutput: true,
            },
            Presets.shades_classic
          )
        : null;

      const progress = progressBar
        ? progressBar.create(rootHistory.length, 0)
        : null;
      const newRootHashes: string[] = [];

      for (let i = 0; i < rootHistory.length; i++) {
        const { root_hash: rootHash } = rootHistory[i];
        const datFilePath = path.join(this.storeDir, `${rootHash}.dat`);

        await this.downloadFileFromPeers(
          `${rootHash}.dat`,
          datFilePath,
          forceDownload
        );

        const datFileContent = JSON.parse(
          fs.readFileSync(datFilePath, "utf-8")
        );
        if (datFileContent.root !== rootHash)
          throw new Error("Root hash mismatch");

        if (!skipData) {
          for (const file of Object.keys(datFileContent.files)) {
            const filePath = getFilePathFromSha256(
              datFileContent.files[file].sha256,
              path.join(this.storeDir, "data")
            );
            const isInDataDir = filePath.startsWith(
              path.join(this.storeDir, "data")
            );
            await this.downloadFileFromPeers(
              getFilePathFromSha256(datFileContent.files[file].sha256, "data"),
              filePath,
              forceDownload || !isInDataDir
            );
          }
        }

        if (localManifestHashes[i] !== rootHash) newRootHashes.push(rootHash);

        progress?.increment();
      }

      if (newRootHashes.length)
        fs.appendFileSync(localManifestPath, newRootHashes.join("\n") + "\n");

      await this.downloadManifestFile(forceDownload);

      progressBar?.stop();

      console.log("Syncing store complete.");
    } catch (error: any) {
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

    while (true) {
      if (!overwrite && fs.existsSync(filePath)) return;

      const blacklist = this.peerBlacklist.get(dataPath) || new Set<string>();

      for (const digPeer of digPeers) {
        if (blacklist.has(digPeer.IpAddress)) continue;

        try {
          // Create directory if it doesn't exist
          const directory = path.dirname(filePath);
          if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
          }

          // Stream the file data directly to the file system
          const fileStream = fs.createWriteStream(filePath);

          // Start streaming the data from the peer
          const peerStream = await digPeer.propagationServer.streamStoreData(
            dataPath
          );

          // Pipe the peer stream directly to the file system
          await new Promise<void>((resolve, reject) => {
            peerStream.pipe(fileStream);

            peerStream.on("end", resolve);
            peerStream.on("error", reject);
            fileStream.on("error", reject);
          });

          if (process.env.DIG_DEBUG === "1") {
            console.log(`Downloaded ${dataPath} from ${digPeer.IpAddress}`);
          }

          return; // Exit the method if download succeeds
        } catch (error) {
          console.warn(
            `Failed to download ${dataPath} from ${digPeer.IpAddress}, blacklisting peer and trying next...`
          );
          blacklist.add(digPeer.IpAddress);
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
