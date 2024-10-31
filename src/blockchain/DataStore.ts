import fs from "fs";
import path from "path";
import {
  writerDelegatedPuzzleFromKey,
  adminDelegatedPuzzleFromKey,
  oracleDelegatedPuzzle,
  mintStore,
  signCoinSpends,
  CoinSpend,
  DataStore as DataStoreDriver,
  getCoinId,
  DataStoreMetadata,
  addFee,
  updateStoreMetadata,
  syntheticKeyToPuzzleHash,
} from "@dignetwork/datalayer-driver";
import { promisify } from "util";
import { FullNodePeer } from "./FullNodePeer";
import { Wallet } from "./Wallet";
import {
  MIN_HEIGHT,
  MIN_HEIGHT_HEADER_HASH,
  getActiveStoreId,
  STORE_PATH,
} from "../utils/config";
import { calculateFeeForCoinSpends } from "./coins";
import { RootHistoryItem } from "../types";
import { red } from "colorette";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import {
  DataIntegrityTree,
  DataIntegrityTreeOptions,
} from "../DataIntegrityTree";
import { CreateStoreUserInputs } from "../types";
import { askForStoreDetails } from "../prompts";
import { FileCache } from "../utils/FileCache";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { MAIN_NET_GENISES_CHALLENGE } from "../utils/config";
import { StoreMonitorRegistry } from "./StoreMonitorRegistry";
import NodeCache from "node-cache";

// Initialize the cache with a TTL of 180 seconds (3 minutes)
const rootHistoryCache = new NodeCache({ stdTTL: 180 });

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

export class DataStore {
  private storeId: string;
  private tree: DataIntegrityTree;
  private static activeMonitors: Map<string, boolean> = new Map();

  constructor(storeId: string, options?: DataIntegrityTreeOptions) {
    this.storeId = storeId;

    let _options: DataIntegrityTreeOptions;

    if (options) {
      _options = options;
    } else {
      _options = {
        storageMode: "local",
        storeDir: STORE_PATH,
      };
    }

    this.tree = new DataIntegrityTree(storeId, _options);
  }

  public get StoreId(): string {
    return this.storeId;
  }

  public get Tree(): DataIntegrityTree {
    return this.tree;
  }

  public toBuffer(): Buffer {
    return Buffer.from(this.storeId, "hex");
  }

  public toString(): string {
    return this.storeId;
  }

  public serialize(): string {
    return JSON.stringify({
      storeId: this.storeId,
    });
  }

  public static async getActiveStore(): Promise<DataStore | undefined> {
    const storeId = await getActiveStoreId();
    if (storeId) {
      return DataStore.from(storeId.toString("hex"));
    }
  }

  public static deserialize(serialized: string): DataStore {
    const parsed = JSON.parse(serialized);
    return new DataStore(parsed.storeId);
  }

  public static from(storeId: string | Buffer, rootHash?: string): DataStore {
    if (!fs.existsSync(path.join(STORE_PATH, storeId.toString("hex")))) {
      throw new Error(`Store with ID ${storeId.toString("hex")} does not exist.`);
    }

    const existingTreeOptions: DataIntegrityTreeOptions = {
      storageMode: "local",
      storeDir: STORE_PATH,
      disableInitialize: true,
    };

    if (rootHash) {
      existingTreeOptions.rootHash = rootHash;
    }

    if (storeId instanceof Buffer) {
      return new DataStore(storeId.toString("hex"), existingTreeOptions);
    }
    return new DataStore(storeId, existingTreeOptions);
  }

  public static async create(
    inputs: CreateStoreUserInputs = {}
  ): Promise<DataStore> {
    const finalInputs = await askForStoreDetails(inputs);

    try {
      const peer = await FullNodePeer.connect();
      const height = await peer.getPeak();
      if (!height) {
        throw new Error("Failed to get peak height");
      }
      const hash = await peer.getHeaderHash(height);

      const newStoreCoin: DataStoreDriver = await this.mint(
        finalInputs.label!,
        finalInputs.description!,
        BigInt(0),
        finalInputs.authorizedWriter
      );

      console.log("Store submitted to mempool");
      console.log(`Store ID: ${newStoreCoin.launcherId.toString("hex")}`);

      try {
        console.log(`Coin ID: ${getCoinId(newStoreCoin.coin).toString("hex")}`);
        await FullNodePeer.waitForConfirmation(
          newStoreCoin.coin.parentCoinInfo
        );
      } catch (error: any) {
        console.error(error.message);
      }

      const dataStore = new DataStore(newStoreCoin.launcherId.toString("hex"));

      await dataStore.setCreationHeight(height, hash);

      return dataStore;
    } catch (error) {
      console.error("Failed to mint Data Layer Store:", error);
      throw error;
    }
  }

  private static async mint(
    label?: string,
    description?: string,
    sizeInBytes?: bigint,
    authorizedWriterPublicSyntheticKey?: string,
    adminPublicSyntheticKey?: string
  ): Promise<DataStoreDriver> {
    try {
      const peer = await FullNodePeer.connect();
      const wallet = await Wallet.load("default");
      const publicSyntheticKey = await wallet.getPublicSyntheticKey();
      const ownerSyntheicPuzzleHash =
        syntheticKeyToPuzzleHash(publicSyntheticKey);
      const storeCreationCoins = await wallet.selectUnspentCoins(
        peer,
        BigInt(1),
        BigInt(0)
      );

      const delegationLayers = [];
      if (adminPublicSyntheticKey) {
        delegationLayers.push(
          adminDelegatedPuzzleFromKey(
            Buffer.from(adminPublicSyntheticKey, "hex")
          )
        );
      }
      if (authorizedWriterPublicSyntheticKey) {
        delegationLayers.push(
          writerDelegatedPuzzleFromKey(
            Buffer.from(authorizedWriterPublicSyntheticKey, "hex")
          )
        );
      }
      delegationLayers.push(
        oracleDelegatedPuzzle(ownerSyntheicPuzzleHash, BigInt(100000))
      );

      const rootHash = Buffer.from(
        "0000000000000000000000000000000000000000000000000000000000000000",
        "hex"
      );

      const mintStoreParams = [
        publicSyntheticKey,
        storeCreationCoins,
        rootHash,
        label || undefined,
        description || undefined,
        sizeInBytes || BigInt(0),
        ownerSyntheicPuzzleHash,
        delegationLayers,
      ];

      const { coinSpends: preflightCoinSpends } = await mintStore(
        // @ts-ignore
        ...mintStoreParams,
        // @ts-ignore
        BigInt(0)
      );
      const fee = await calculateFeeForCoinSpends(peer, preflightCoinSpends);

      const storeCreationResponse = await mintStore.apply(null, [
        // @ts-ignore
        ...mintStoreParams,
        // @ts-ignore
        fee,
      ]);

      const sig = signCoinSpends(
        storeCreationResponse.coinSpends,
        [await wallet.getPrivateSyntheticKey()],
        false
      );
      const err = await peer.broadcastSpend(
        storeCreationResponse.coinSpends as CoinSpend[],
        [sig]
      );

      if (err) {
        throw new Error(err);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));

      return storeCreationResponse.newStore;
    } catch (error) {
      console.error("Unable to mint store");
      throw error;
    }
  }

  /**
   * Instance method to calculate the disk space used by the store/storeId folder.
   * @returns {Promise<number>} - The total disk space used by the store in bytes.
   */
  public async getDiskSpace(): Promise<bigint> {
    const storePath = path.join(STORE_PATH, this.storeId);
    return await DataStore.calculateFolderSize(storePath);
  }

  /**
   * Static method to calculate the total disk space used by all stores in the store folder.
   * @returns {Promise<number>} - The total disk space used by the store folder in bytes.
   */
  public static async getTotalDiskSpace(): Promise<bigint> {
    return await DataStore.calculateFolderSize(STORE_PATH);
  }

  /**
   * Helper method to calculate the size of a folder and its subfolders recursively.
   * @param folderPath - The path of the folder to calculate the size of.
   * @returns {Promise<number>} - The total size of the folder in bytes.
   */
  private static async calculateFolderSize(
    folderPath: string
  ): Promise<bigint> {
    let totalSize = BigInt(0);

    const files = await readdir(folderPath);

    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const fileStat = await stat(filePath);

      if (fileStat.isDirectory()) {
        totalSize += await this.calculateFolderSize(filePath); // Recursive call for subdirectories
      } else {
        totalSize += BigInt(fileStat.size); // Add file size to total
      }
    }

    return totalSize;
  }

  public static getAllStores(): DataStore[] {
    const storeFolders = fs.readdirSync(STORE_PATH);
    const storeIds = storeFolders.filter(
      (folder) =>
        /^[a-f0-9]{64}$/.test(folder) &&
        fs.lstatSync(path.join(STORE_PATH, folder)).isDirectory()
    );

    return storeIds.map((storeId) => DataStore.from(storeId));
  }

  /**
   * Fetches the latest coin information using the StoreMonitorRegistry.
   * Registers the storeId if it's not already registered, retrieves the cached value, and returns it.
   *
   * @returns {Promise<{ latestStore: DataStoreDriver; latestHeight: number; latestHash: Buffer }>}
   */
  public async fetchCoinInfo(): Promise<{
    latestStore: DataStoreDriver;
    latestHeight: number;
    latestHash: Buffer;
  }> {
    const storeMonitor = StoreMonitorRegistry.getInstance();

    try {
      // Register the storeId with a no-op callback. If already registered, the registry will handle it.
      await storeMonitor.registerStore(this.storeId, () => {
        // No operation callback since we're fetching the cache directly
      });

      // Retrieve the latest cached store information
      const cachedInfo = await storeMonitor.getLatestCache(this.storeId);

      if (!cachedInfo) {
        throw new Error(`No cached info found for storeId: ${this.storeId}`);
      }

      const deserializedStore = DataStoreSerializer.deserialize({
        latestStore: cachedInfo.latestStore,
        latestHeight: cachedInfo.latestHeight.toString(),
        latestHash: cachedInfo.latestHash,
      });

      return {
        latestStore: deserializedStore.latestStore,
        latestHeight: deserializedStore.latestHeight,
        latestHash: deserializedStore.latestHash,
      };
    } catch (error: any) {
      throw new Error(
        `Failed to fetch coin info for storeId ${this.storeId}: ${error.message}`
      );
    }
  }

  public async cacheStoreCreationHeight(): Promise<{
    createdAtHeight: number;
    createdAtHash: Buffer;
  }> {
    const peer = await FullNodePeer.connect();
    const createdAtHeight = await peer.getStoreCreationHeight(
      Buffer.from(this.storeId, "hex"),
      null,
      Buffer.from(MAIN_NET_GENISES_CHALLENGE, "hex")
    );

    // Get just before created at height so we can find the coin
    const justBeforeCreatedAtHeight = Number(createdAtHeight) - 1;
    const createdAtHash = await peer.getHeaderHash(justBeforeCreatedAtHeight);

    await this.setCreationHeight(justBeforeCreatedAtHeight, createdAtHash);

    return { createdAtHeight: justBeforeCreatedAtHeight, createdAtHash };
  }

  public async getCreationHeight(): Promise<{
    createdAtHeight: number;
    createdAtHash: Buffer;
  }> {
    // Initialize the FileCache for the height file
    const fileCache = new FileCache<{ height: number; hash: string }>(
      `stores/${this.storeId}`
    );

    // Try to retrieve the cached height information
    const cachedHeightInfo = fileCache.get("height");

    if (!cachedHeightInfo) {
      // If no cache, regenerate the cache
      return this.cacheStoreCreationHeight();
    }

    // Parse the cached height and hash values
    const { height, hash } = cachedHeightInfo;

    const defaultHeight = MIN_HEIGHT;
    const defaultHash = Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex");

    return {
      createdAtHeight: height || defaultHeight,
      createdAtHash: hash ? Buffer.from(hash, "hex") : defaultHash,
    };
  }

  private async setCreationHeight(height: number, hash: Buffer): Promise<void> {
    const fileCache = new FileCache<{ height: number; hash: string }>(
      `stores/${this.storeId}`
    );

    // Cache the height and hash information
    fileCache.set("height", {
      height,
      hash: hash.toString("hex"),
    });
  }

  public async getRootHistory(bustCache?: boolean): Promise<RootHistoryItem[]> {
    if (bustCache) {
      rootHistoryCache.del(this.storeId);
    }

    // Check if the root history is cached for this storeId
    const cachedHistory = await rootHistoryCache.get<RootHistoryItem[]>(
      this.storeId
    );
    if (cachedHistory) {
      return cachedHistory;
    }

    // Fetch root history from peer if not cached
    const peer = await FullNodePeer.connect();
    const { createdAtHeight, createdAtHash } = await this.getCreationHeight();

    const { rootHashes, rootHashesTimestamps } =
      await peer.syncStoreFromLauncherId(
        Buffer.from(this.storeId, "hex"),
        createdAtHeight,
        createdAtHash,
        true
      );

    if (!rootHashes) {
      return [];
    }

    // Build the root history list
    const rootHistory = rootHashes.map((rootHash, index) => ({
      root_hash: rootHash.toString("hex"),
      timestamp: Number(rootHashesTimestamps?.[index].toString()),
      synced: fs.existsSync(
        path.join(STORE_PATH, this.storeId, `${rootHash.toString("hex")}.dat`)
      ),
    }));

    // Store the root history in the cache
    rootHistoryCache.set(this.storeId, rootHistory);

    return rootHistory;
  }

  // Generates a fresh manifest file based on the current root history
  // and what is currently on disk
  public async generateManifestFile(folderPath?: string): Promise<void> {
    if (!folderPath) {
      folderPath = path.join(STORE_PATH, this.storeId, "data");
    }
    const rootHistory = await this.getRootHistory();
    // Need this for the dataintegrity tree to work properly
    fs.writeFileSync(
      path.join(folderPath, "manifest.dat"),
      rootHistory
        .filter((root) => root.synced)
        .map((root) => root.root_hash)
        .join("\n")
    );
  }

  public async getMetaData(): Promise<DataStoreMetadata> {
    const { latestStore } = await this.fetchCoinInfo();
    return latestStore.metadata;
  }

  public async isSynced(): Promise<boolean> {
    const dataStore = await DataStore.from(this.storeId);
    const rootHistory = await dataStore.getRootHistory();
    return !rootHistory.some((root) => !root.synced);
  }

  public async hasMetaWritePermissions(
    publicSyntheticKey?: Buffer
  ): Promise<boolean> {
    const wallet = await Wallet.load("default");
    const { latestStore } = await this.fetchCoinInfo();

    let ownerPuzzleHash = publicSyntheticKey
      ? syntheticKeyToPuzzleHash(publicSyntheticKey)
      : await wallet.getOwnerPuzzleHash();

    const isStoreOwner = latestStore.ownerPuzzleHash.equals(ownerPuzzleHash);
    const hasWriteAccess = latestStore.delegatedPuzzles.some(
      (puzzle) =>
        puzzle.adminInnerPuzzleHash?.equals(ownerPuzzleHash) ||
        puzzle.writerInnerPuzzleHash?.equals(ownerPuzzleHash)
    );

    return isStoreOwner || hasWriteAccess;
  }

  public async updateMetadata(
    metadata: DataStoreMetadata
  ): Promise<DataStoreDriver> {
    const peer = await FullNodePeer.connect();
    const wallet = await Wallet.load("default");
    const publicSyntheticKey = await wallet.getPublicSyntheticKey();

    const { latestStore } = await this.fetchCoinInfo();

    const updateStoreResponse = updateStoreMetadata(
      latestStore,
      metadata.rootHash,
      metadata.label,
      metadata.description,
      metadata.bytes,
      publicSyntheticKey,
      null,
      null
    );

    const fee = await calculateFeeForCoinSpends(peer, null);
    const unspentCoins = await wallet.selectUnspentCoins(peer, BigInt(0), fee);
    const feeCoinSpends = await addFee(
      publicSyntheticKey,
      unspentCoins,
      updateStoreResponse.coinSpends.map((coinSpend) =>
        getCoinId(coinSpend.coin)
      ),
      fee
    );

    const combinedCoinSpends = [
      ...(updateStoreResponse.coinSpends as CoinSpend[]),
      ...(feeCoinSpends as CoinSpend[]),
    ];

    const sig = signCoinSpends(
      combinedCoinSpends,
      [await wallet.getPrivateSyntheticKey()],
      false
    );
    const err = await peer.broadcastSpend(combinedCoinSpends, [sig]);

    if (err) {
      throw new Error(err);
    }

    return updateStoreResponse.newStore;
  }

  /**
   * Retrieve the file set for a given root hash and validate file integrity.
   *
   * @param {string} rootHash - The root hash to fetch the file set.
   * @returns {Promise<{ fileName: string, file: string }[]>} - An array of unique file objects.
   */
  public async getFileSetForRootHash(
    rootHash: string,
    skipIntegirtyCheck: boolean = false
  ): Promise<{ name: string; path: string }[]> {
    const datFilePath = path.join(STORE_PATH, this.storeId, `${rootHash}.dat`);
    const datFileContent = JSON.parse(fs.readFileSync(datFilePath, "utf-8"));

    // Use a Set to ensure uniqueness
    const filesInvolved = new Set<{ name: string; path: string }>();

    // Iterate over each file and perform an integrity check
    for (const [fileKey, fileData] of Object.entries(datFileContent.files)) {
      const filePath = getFilePathFromSha256(
        datFileContent.files[fileKey].sha256,
        "data"
      );

      // Perform the integrity check
      let integrityCheck;

      if (!skipIntegirtyCheck) {
        integrityCheck =
          await DataIntegrityTree.validateKeyIntegrityWithForeignTree(
            fileKey,
            datFileContent.files[fileKey].sha256,
            datFileContent,
            rootHash,
            path.join(STORE_PATH, this.storeId, "data")
          );
      }

      if (integrityCheck || skipIntegirtyCheck) {
        // Add the file to the Set
        filesInvolved.add({
          name: Buffer.from(fileKey, "hex").toString("utf-8"),
          path: filePath,
        });
      } else {
        console.error(red(`File ${fileKey} failed the integrity check.`));
        throw new Error(
          `Integrity check failed for file: ${fileKey}. Aborting.`
        );
      }
    }

    // Convert Set to Array and return
    return Array.from(filesInvolved);
  }
}
