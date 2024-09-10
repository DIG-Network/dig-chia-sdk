import fs, { read } from "fs";
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
} from "datalayer-driver";
import { promisify } from "util";
import { FullNodePeer } from "./FullNodePeer";
import { Wallet } from "./Wallet";
import {
  MIN_HEIGHT,
  MIN_HEIGHT_HEADER_HASH,
  getManifestFilePath,
  getActiveStoreId,
  STORE_PATH,
} from "../utils/config";
import { selectUnspentCoins, calculateFeeForCoinSpends } from "./coins";
import { RootHistoryItem, DatFile } from "../types";
import { validateFileSha256 } from "../utils";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import {
  DataIntegrityTree,
  DataIntegrityTreeOptions,
} from "../DataIntegrityTree";
import { CreateStoreUserInputs } from "../types";
import { askForStoreDetails } from "../prompts";
import { FileCache } from "../utils/FileCache";
import { DataStoreSerializer } from "./DataStoreSerializer";
import { h } from "chia-bls";

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

export class DataStore {
  private storeId: string;
  private tree: DataIntegrityTree;

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

  public static from(storeId: string | Buffer): DataStore {
    const existingTreeOptions: DataIntegrityTreeOptions = {
      storageMode: "local",
      storeDir: STORE_PATH,
      disableInitialize: true,
    };
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
      const storeCreationCoins = await selectUnspentCoins(
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
    const storIds = storeFolders.filter(
      (folder) =>
        /^[a-f0-9]{64}$/.test(folder) &&
        fs.lstatSync(path.join(STORE_PATH, folder)).isDirectory()
    );

    return storIds.map((storeId) => DataStore.from(storeId));
  }

  public async fetchCoinInfo(): Promise<{
    latestStore: DataStoreDriver;
    latestHeight: number;
    latestHash: Buffer;
  }> {
    try {
      // Initialize the cache for the current storeId's coin info
      const storeCoinCache = new FileCache<{
        latestStore: ReturnType<DataStoreSerializer["serialize"]>;
        latestHeight: number;
        latestHash: string;
      }>(`stores`);

      // Try to get cached store info
      const cachedInfo = storeCoinCache.get(this.storeId);

      if (cachedInfo) {
        try {
          const {
            latestStore: serializedStore,
            latestHeight: previousHeight,
            latestHash: previousHash,
          } = cachedInfo;

          // Deserialize the stored data using DataStoreSerializer
          const { latestStore: previousInfo } = DataStoreSerializer.deserialize(
            {
              latestStore: serializedStore,
              latestHeight: previousHeight.toString(),
              latestHash: previousHash,
            }
          );

          // Sync with peer if necessary
          const peer = await FullNodePeer.connect();
          const { latestStore, latestHeight } = await peer.syncStore(
            previousInfo,
            previousHeight,
            Buffer.from(previousHash, "hex"),
            false
          );
          const latestHash = await peer.getHeaderHash(latestHeight);

          // Serialize the store data for caching
          const serializedLatestStore = new DataStoreSerializer(
            latestStore,
            latestHeight,
            latestHash
          ).serialize();

          // Cache updated store info
          storeCoinCache.set(this.storeId, {
            latestStore: serializedLatestStore,
            latestHeight,
            latestHash: latestHash.toString("hex"),
          });

          return { latestStore, latestHeight, latestHash };
        } catch {
          // Return cached info if sync fails
          const { latestStore, latestHeight, latestHash } =
            DataStoreSerializer.deserialize({
              latestStore: cachedInfo.latestStore,
              latestHeight: cachedInfo.latestHeight.toString(),
              latestHash: cachedInfo.latestHash,
            });
          return {
            latestStore,
            latestHeight,
            latestHash: latestHash,
          };
        }
      }

      // Use getCreationHeight to retrieve height and hash information
      const { createdAtHeight, createdAtHash } = await this.getCreationHeight();

      // Sync store from peer
      const peer = await FullNodePeer.connect();
      const { latestStore, latestHeight } = await peer.syncStoreFromLauncherId(
        Buffer.from(this.storeId, "hex"),
        createdAtHeight,
        createdAtHash,
        false
      );

      const latestHash = await peer.getHeaderHash(latestHeight);

      // Serialize the latest store info for caching
      const serializedLatestStore = new DataStoreSerializer(
        latestStore,
        latestHeight,
        latestHash
      ).serialize();

      // Cache the latest store info
      storeCoinCache.set(this.storeId, {
        latestStore: serializedLatestStore,
        latestHeight,
        latestHash: latestHash.toString("hex"),
      });

      return { latestStore, latestHeight, latestHash };
    } catch (error) {
      console.trace("Failed to fetch coin info", error);
      throw error;
    }
  }

  public async getCreationHeight(): Promise<{
    createdAtHeight: number;
    createdAtHash: Buffer;
  }> {
    const defaultHeight = MIN_HEIGHT;
    const defaultHash = Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex");

    // Initialize the FileCache for the height file
    const fileCache = new FileCache<{ height: number; hash: string }>(
      `stores/${this.storeId}`
    );

    // Try to retrieve the cached height information
    const cachedHeightInfo = fileCache.get("height");

    if (!cachedHeightInfo) {
      // If no cache, return the default values
      return { createdAtHeight: defaultHeight, createdAtHash: defaultHash };
    }

    // Parse the cached height and hash values
    const { height, hash } = cachedHeightInfo;

    return {
      createdAtHeight: height || defaultHeight,
      createdAtHash: Buffer.from(hash || MIN_HEIGHT_HEADER_HASH, "hex"),
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

  public async getRootHistory(): Promise<RootHistoryItem[]> {
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

    return rootHashes.map((rootHash, index) => ({
      root_hash: rootHash.toString("hex"),
      timestamp: Number(rootHashesTimestamps?.[index].toString()),
    }));
  }

  public async getLocalRootHistory(): Promise<RootHistoryItem[] | undefined> {
    const manifestFilePath = getManifestFilePath(this.storeId);
    if (!fs.existsSync(manifestFilePath)) {
      console.error("Manifest file not found", manifestFilePath);
      return undefined;
    }

    const manifestHashes = fs
      .readFileSync(manifestFilePath, "utf-8")
      .split("\n")
      .filter(Boolean);
    return manifestHashes.map((rootHash) => ({
      root_hash: rootHash,
      timestamp: 0, // Timestamps are not yet included in the manifest
    }));
  }

  public async validate(): Promise<boolean> {
    const rootHistory = await this.getRootHistory();
    const manifestFilePath = getManifestFilePath(this.storeId);

    if (!fs.existsSync(manifestFilePath)) {
      console.error("Manifest file not found", manifestFilePath);
      return false;
    }

    const manifestHashes = fs
      .readFileSync(manifestFilePath, "utf-8")
      .split("\n")
      .filter(Boolean);

    if (manifestHashes.length > rootHistory.length) {
      console.error(
        "The store is corrupted: Manifest file has more hashes than the root history."
      );
      return false;
    }

    if (rootHistory.length > manifestHashes.length) {
      console.error(
        "The store is not synced: Root history has more hashes than the manifest file."
      );
      return false;
    }

    for (let i = 0; i < manifestHashes.length; i++) {
      if (manifestHashes[i] !== rootHistory[i]?.root_hash) {
        console.error(
          `Root hash mismatch at position ${i}: expected ${manifestHashes[i]} but found ${rootHistory[i]?.root_hash}`
        );
        return false;
      }
    }

    let filesIntegrityIntact = true;
    for (const rootHash of manifestHashes) {
      const datFilePath = path.join(
        STORE_PATH,
        this.storeId,
        `${rootHash}.dat`
      );

      if (!fs.existsSync(datFilePath)) {
        console.error(`Data file for root hash ${rootHash} not found`);
        return false;
      }

      const datFileContent = JSON.parse(
        fs.readFileSync(datFilePath, "utf-8")
      ) as DatFile;
      if (datFileContent.root !== rootHash) {
        console.error(
          `Root hash in data file does not match: ${datFileContent.root} !== ${rootHash}`
        );
        return false;
      }

      for (const [fileKey, fileData] of Object.entries(datFileContent.files)) {
        const integrityCheck = validateFileSha256(
          fileData.sha256,
          path.join(STORE_PATH, this.storeId, "data")
        );
        if (!integrityCheck) {
          filesIntegrityIntact = false;
        }
      }
    }

    if (!filesIntegrityIntact) {
      console.error("Store Corrupted: Data failed SHA256 validation.");
      return false;
    }

    return true;
  }

  public async getMetaData(): Promise<DataStoreMetadata> {
    const { latestStore } = await this.fetchCoinInfo();
    return latestStore.metadata;
  }

  public async isSynced(): Promise<boolean> {
    const rootHistory = await this.getRootHistory();
    const manifestFilePath = getManifestFilePath(this.storeId);

    if (!fs.existsSync(manifestFilePath)) {
      return false;
    }

    const manifestHashes = fs
      .readFileSync(manifestFilePath, "utf-8")
      .split("\n")
      .filter(Boolean);

    return rootHistory.length === manifestHashes.length;
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
    const unspentCoins = await selectUnspentCoins(peer, BigInt(0), fee);
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

  public async getFileSetForRootHash(rootHash: string): Promise<string[]> {
    const datFilePath = path.join(STORE_PATH, this.storeId, `${rootHash}.dat`);
    const datFileContent = JSON.parse(fs.readFileSync(datFilePath, "utf-8"));
    const heightDatFilePath = path.join(
      STORE_PATH,
      this.storeId,
      "height.json"
    );
    const manifestFilePath = path.join(
      STORE_PATH,
      this.storeId,
      "manifest.dat"
    );

    const filesInvolved: string[] = [];
    filesInvolved.push(manifestFilePath);
    filesInvolved.push(datFilePath);
    filesInvolved.push(heightDatFilePath);

    for (const [fileKey, fileData] of Object.entries(datFileContent.files)) {
      const filepath = path.join(STORE_PATH, this.storeId, "data", fileKey);

      const filePath = getFilePathFromSha256(
        datFileContent.files[fileKey].sha256,
        path.join(STORE_PATH, this.storeId, "data")
      );

      filesInvolved.push(filePath);
    }

    return filesInvolved;
  }

  public getManifestHashes(): string[] {
    const manifestFilePath = path.join(
      STORE_PATH,
      this.storeId,
      "manifest.dat"
    );
    return fs.existsSync(manifestFilePath)
      ? fs.readFileSync(manifestFilePath, "utf-8").split("\n").filter(Boolean)
      : [];
  }
}
