import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { SHA256 } from "crypto-js";
import { MerkleTree } from "merkletreejs";
import { Readable } from "stream";
import { promisify } from "util";
import DataLayerError from "./DataLayerError";

const unlink = promisify(fs.unlink);

/**
 * Convert a string to hexadecimal representation.
 * @param str - The input string.
 * @returns The hexadecimal representation of the input string.
 */
const toHex = (str: string): string => {
  return Buffer.from(str).toString("hex");
};

/**
 * Remove empty directories recursively.
 * @param dir - The directory path.
 */
const removeEmptyDirectories = (dir: string): void => {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    if (files.length === 0) {
      fs.rmdirSync(dir);
      const parentDir = path.dirname(dir);
      removeEmptyDirectories(parentDir);
    }
  }
};

/**
 * Check if a string is a valid hexadecimal string.
 * @param str - The string to validate.
 * @returns True if the string is a valid hex string, false otherwise.
 */
const isHexString = (str: string): boolean => {
  return /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;
};

export interface DataIntegrityTreeOptions {
  storeDir?: string;
  storageMode?: "local" | "unified";
  rootHash?: string;
  // This is a hack to prevent an empty root hash from
  // being commited in the constructor when the tree is empty
  disableInitialize?: boolean;
}

/**
 * DataStoreManager class to manage Merkle tree operations.
 */
class DataIntegrityTree {
  private storeId: string;
  private storeBaseDir: string;
  private storeDir: string;
  private dataDir: string;
  public files: Map<string, { hash: string; sha256: string }>;
  private tree: MerkleTree;

  constructor(storeId: string, options: DataIntegrityTreeOptions = {}) {
    if (!isHexString(storeId) || storeId.length !== 64) {
      throw new Error("storeId must be a 64 char hex string");
    }
    this.storeId = storeId;
    this.storeBaseDir = options.storeDir || "./";

    if (!fs.existsSync(this.storeBaseDir)) {
      fs.mkdirSync(this.storeBaseDir, { recursive: true });
    }

    if (options.storageMode === "unified") {
      this.dataDir = path.join(this.storeBaseDir, "data");
    } else {
      this.dataDir = path.join(this.storeBaseDir, this.storeId, "data");
    }

    this.storeDir = path.join(this.storeBaseDir, this.storeId);

    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.files = new Map();

    if (options.rootHash) {
      const manifest = this._loadManifest();
      if (manifest.includes(options.rootHash)) {
        this.tree = this.deserializeTree(options.rootHash);
      } else {
        throw new DataLayerError(
          404,
          `Root hash ${options.rootHash} not found`
        );
      }
    } else {
      this.tree = this._loadLatestTree();
    }

    // Commit the empty Merkle tree immediately upon creation
    if (!options.disableInitialize && this.tree.getLeafCount() === 0) {
      this.commit();
    }
  }

  public static from(
    storeId: string,
    options: DataIntegrityTreeOptions
  ): DataIntegrityTree {
    return new DataIntegrityTree(storeId, {
      ...options,
      disableInitialize: true,
    });
  }

  /**
   * Load the manifest file.
   * @private
   */
  private _loadManifest(): string[] {
    const manifestPath = path.join(this.storeDir, "manifest.dat");
    if (fs.existsSync(manifestPath)) {
      return fs.readFileSync(manifestPath, "utf8").trim().split("\n");
    }
    return [];
  }

  /**
   * Load the latest tree from the manifest file.
   * @private
   */
  private _loadLatestTree(): MerkleTree {
    const manifest = this._loadManifest();
    if (manifest.length > 0) {
      const latestRootHash = manifest[manifest.length - 1];
      return this.deserializeTree(latestRootHash);
    } else {
      return new MerkleTree([], SHA256, { sortPairs: true });
    }
  }

  /**
   * Save a binary stream to the store's data directory.
   * @param sha256 - The SHA-256 hash of the buffer.
   * @returns The write stream for the file.
   */
  private _createWriteStream(sha256: string): fs.WriteStream {
    const subDirs = sha256.match(/.{1,2}/g) || [];
    const fileDir = path.join(this.dataDir, ...subDirs.slice(0, -1));
    const fileName = subDirs[subDirs.length - 1];
    const fileSavePath = path.join(fileDir, fileName);

    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }

    return fs.createWriteStream(fileSavePath);
  }

  /**
   * Stream file from one path to another.
   * @param src - The source file path.
   * @param dest - The destination file path.
   */
  private async _streamFile(src: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(src);
      const writeStream = fs.createWriteStream(dest);

      readStream.pipe(writeStream);

      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      readStream.on("error", reject);
    });
  }

  /**
   * Upsert a key with a binary stream to the Merkle tree.
   * Compresses the file, calculates the SHA-256 of the uncompressed file, and stores it.
   * @param readStream - The binary data stream.
   * @param key - The hexadecimal key for the binary data.
   */
  async upsertKey(readStream: Readable, key: string): Promise<void> {
    if (!isHexString(key)) {
      throw new Error(`key must be a valid hex string: ${key}`);
    }
    const uncompressedHash = crypto.createHash("sha256");
    const gzip = zlib.createGzip();

    let sha256: string;
    const tempDir = path.join(this.storeDir, "tmp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempFilePath = path.join(tempDir, `${crypto.randomUUID()}.gz`);

    return new Promise((resolve, reject) => {
      const tempWriteStream = fs.createWriteStream(tempFilePath);

      readStream.on("data", (chunk) => {
        uncompressedHash.update(chunk);
      });

      readStream.pipe(gzip).pipe(tempWriteStream);

      tempWriteStream.on("finish", async () => {
        sha256 = uncompressedHash.digest("hex");

        const finalWriteStream = this._createWriteStream(sha256);
        const finalPath = finalWriteStream.path as string;

        // Ensure the directory exists before copying the file
        const finalDir = path.dirname(finalPath);
        if (!fs.existsSync(finalDir)) {
          fs.mkdirSync(finalDir, { recursive: true });
        }

        try {
          await this._streamFile(tempFilePath, finalPath);
          await unlink(tempFilePath);

          const combinedHash = crypto
            .createHash("sha256")
            .update(`${key}/${sha256}`)
            .digest("hex");

          if (
            Array.from(this.files.values()).some(
              (file) => file.hash === combinedHash
            )
          ) {
            console.log(`No changes detected for key: ${key}`);
            return resolve();
          }

          if (this.files.has(key)) {
            this.deleteKey(key);
          }

          console.log(`Inserted key: ${key}`);
          this.files.set(key, {
            hash: combinedHash,
            sha256: sha256,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          this._rebuildTree();
          await new Promise((resolve) => setTimeout(resolve, 100));
          resolve();
        } catch (err) {
          reject(err);
        }

        tempWriteStream.end();
        finalWriteStream.end();
      });

      tempWriteStream.on("error", (err) => {
        tempWriteStream.end();
        reject(err);
      });

      readStream.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Delete a key from the Merkle tree.
   * @param key - The hexadecimal key to delete.
   */
  deleteKey(key: string): void {
    if (!isHexString(key)) {
      throw new Error("key must be a valid hex string");
    }
    if (this.files.has(key)) {
      this.files.delete(key);
      this._rebuildTree();
      console.log(`Deleted key: ${key}`);
    }
  }

  /**
   * List all keys in the Merkle tree.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns The list of keys.
   */
  listKeys(rootHash: string | null = null): string[] {
    if (rootHash && !isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    if (rootHash) {
      const tree = this.deserializeTree(rootHash);
      // @ts-ignore
      return Array.from(tree.files.keys());
    }
    return Array.from(this.files.keys());
  }

  /**
   * Rebuild the Merkle tree from the current files.
   * @private
   */
  private _rebuildTree(): void {
    const leaves = Array.from(this.files.values()).map(({ hash }) =>
      Buffer.from(hash, "hex")
    );
    this.tree = new MerkleTree(leaves, SHA256, { sortPairs: true });
  }

  /**
   * Get the root of the Merkle tree.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns The Merkle root.
   */
  getRoot(): string {
    return this.tree.getRoot().toString("hex");
  }

  /**
   * Serialize the Merkle tree to a JSON object.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns The serialized Merkle tree.
   */
  serialize(rootHash: string | null = null): object {
    if (rootHash && !isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    if (rootHash) {
      const tree = this.deserializeTree(rootHash);
      return {
        root: tree.getRoot().toString("hex"),
        leaves: tree.getLeaves().map((leaf) => leaf.toString("hex")),
        // @ts-ignore
        files: Object.fromEntries(tree.files),
      };
    }
    return {
      root: this.getRoot(),
      leaves: this.tree.getLeaves().map((leaf) => leaf.toString("hex")),
      files: Object.fromEntries(this.files),
    };
  }

  /**
   * Deserialize a JSON object to a Merkle tree.
   * @param rootHash - The root hash of the tree.
   * @returns The deserialized Merkle tree.
   */
  deserializeTree(rootHash: string): MerkleTree {
    if (!isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    const treeFilePath = path.join(this.storeDir, `${rootHash}.dat`);
    if (!fs.existsSync(treeFilePath)) {
      throw new Error(`Tree file ${treeFilePath} does not exist`);
    }
    const data = JSON.parse(fs.readFileSync(treeFilePath, "utf8"));
    const leaves = data.leaves.map((leaf: string) => Buffer.from(leaf, "hex"));
    const tree = new MerkleTree(leaves, SHA256, { sortPairs: true });
    // @ts-ignore
    tree.files = new Map(
      Object.entries(data.files).map(([key, value]: [string, any]) => [
        key,
        { hash: value.hash, sha256: value.sha256 },
      ])
    );
    // @ts-ignore
    this.files = tree.files;
    return tree;
  }

  private appendRootHashToManifest(rootHash: string): void {
    const manifestPath = path.join(this.storeDir, "manifest.dat");
    // Read the current manifest file
    const manifestContent = fs.existsSync(manifestPath)
      ? fs.readFileSync(manifestPath, "utf-8").trim().split("\n")
      : [];

    // Check if the last entry is the same as the rootHash to avoid duplicates
    const latestRootHash =
      manifestContent.length > 0
        ? manifestContent[manifestContent.length - 1]
        : null;

    if (latestRootHash !== rootHash) {
      // Append the new rootHash if it is not the same as the last one
      fs.appendFileSync(manifestPath, `${rootHash}\n`);
    } else {
      console.log(
        `Root hash ${rootHash} is already at the end of the file. Skipping append.`
      );
    }
  }

  /**
   * Commit the current state of the Merkle tree.
   */
  commit(): string | undefined {
    const emptyRootHash =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const rootHash =
      this.tree.getLeafCount() === 0 ? emptyRootHash : this.getRoot();

    const manifest = this._loadManifest();
    const latestRootHash =
      manifest.length > 0 ? manifest[manifest.length - 1] : null;

    if (rootHash === latestRootHash && rootHash !== emptyRootHash) {
      console.log("No changes to commit. Aborting commit.");
      return undefined;
    }

    this.appendRootHashToManifest(rootHash);

    const treeFilePath = path.join(this.storeDir, `${rootHash}.dat`);
    if (!fs.existsSync(path.dirname(treeFilePath))) {
      fs.mkdirSync(path.dirname(treeFilePath), { recursive: true });
    }
    const serializedTree = this.serialize() as {
      root: string;
      leaves: string[];
      files: object;
    };
    if (rootHash === emptyRootHash) {
      serializedTree.root = emptyRootHash;
    }
    fs.writeFileSync(treeFilePath, JSON.stringify(serializedTree));

    console.log(`Committed new root`);
    console.log(this.tree.toString());
    return rootHash;
  }

  /**
   * Clear pending changes and revert to the latest committed state.
   */
  clearPendingRoot(): void {
    this.tree = this._loadLatestTree();
  }

  /**
   * Check if a file exists for a given key.
   * @param hexKey - The hexadecimal key of the file.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns A boolean indicating if the file exists.
   */
  hasKey(hexKey: string, rootHash: string | null = null): boolean {
    if (!isHexString(hexKey)) {
      throw new Error("key must be a valid hex string");
    }
    if (rootHash && !isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    let sha256: string | undefined;

    if (rootHash) {
      const tree = this.deserializeTree(rootHash);
      // @ts-ignore
      sha256 = tree.files.get(hexKey)?.sha256;
    } else {
      sha256 = this.files.get(hexKey)?.sha256;
    }

    if (!sha256) {
      return false;
    }

    const filePath = path.join(
      this.dataDir,
      sha256.match(/.{1,2}/g)!.join("/")
    );

    // Check if the file exists at the calculated path
    return fs.existsSync(filePath);
  }

  /**
   * Get a readable stream for a file based on its key, with decompression.
   * @param hexKey - The hexadecimal key of the file.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns The readable stream for the file.
   */
  getValueStream(
    hexKey: string,
    rootHash: string | null = null,
    byteOffset: number | null = null,
    length: number | null = null
  ): Readable {
    if (!isHexString(hexKey)) {
      throw new Error("key must be a valid hex string");
    }
    if (rootHash && !isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    let sha256: string | undefined;

    if (rootHash) {
      const tree = this.deserializeTree(rootHash);
      // @ts-ignore
      sha256 = tree.files.get(hexKey)?.sha256;
    } else {
      sha256 = this.files.get(hexKey)?.sha256;
    }

    if (!sha256) {
      throw new Error(`File with key ${hexKey} not found.`);
    }

    const filePath = path.join(
      this.dataDir,
      sha256.match(/.{1,2}/g)!.join("/")
    );

    if (!fs.existsSync(filePath)) {
      throw new Error(`File at path ${filePath} does not exist`);
    }

    const fileSize = fs.statSync(filePath).size;

    // Validate offset and length
    if (byteOffset !== null && length !== null) {
      if (byteOffset + length > fileSize) {
        throw new Error(
          `Offset (${byteOffset}) and length (${length}) exceed the file size (${fileSize}).`
        );
      }
    }

    // Create the read stream with optional byte range
    const options: { start?: number; end?: number } = {};

    if (byteOffset !== null) {
      options.start = byteOffset;
    }

    if (length !== null && byteOffset !== null) {
      options.end = byteOffset + length - 1; // `end` is inclusive, hence `byteOffset + length - 1`
    }

    const readStream = fs.createReadStream(filePath, options);
    const decompressStream = zlib.createGunzip();

    // Return the combined stream as a generic Readable stream
    return readStream.pipe(decompressStream);
  }

  /**
   * Delete all leaves from the Merkle tree.
   */
  deleteAllLeaves(): void {
    this.files.clear();
    this._rebuildTree();
  }

  getSHA256(hexKey: string, rootHash?: string): string | undefined {
    if (!rootHash) {
      return this.files.get(hexKey)?.sha256;
    }

    const tree = this.deserializeTree(rootHash);
    // @ts-ignore
    return tree.files.get(hexKey)?.sha256;
  }

  /**
   * Get a proof for a file based on its key and SHA-256 hash.
   * @param hexKey - The hexadecimal key of the file.
   * @param sha256 - The SHA-256 hash of the file.
   * @param rootHash - The root hash of the tree. Defaults to the latest root hash.
   * @returns The proof for the file as a hex string.
   */
  getProof(
    hexKey: string,
    sha256: string,
    rootHash: string | null = null
  ): string {
    if (!isHexString(hexKey)) {
      throw new Error("key must be a valid hex string");
    }
    if (!isHexString(sha256)) {
      throw new Error("sha256 must be a valid hex string");
    }
    if (rootHash && !isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    if (!rootHash) {
      const manifest = this._loadManifest();
      rootHash = manifest[manifest.length - 1];
    }
    const tree = this.deserializeTree(rootHash);
    const combinedHash = SHA256(`${hexKey}/${sha256}`).toString();
    const leaf = Buffer.from(combinedHash, "hex");
    const proof = tree.getProof(leaf);

    // Convert the proof to a single hex string
    const proofHex = proof.map((p) => p.data.toString("hex")).join("");

    // Create an object with the key, rootHash, and proofHex
    const proofObject = {
      key: hexKey,
      rootHash: rootHash,
      proof: proofHex,
    };

    // Convert the proofObject to JSON and then to a hex string
    const proofObjectHex = Buffer.from(JSON.stringify(proofObject)).toString(
      "hex"
    );

    return proofObjectHex;
  }

  /**
   * Verify a proof for a file against the Merkle tree.
   * @param proofObjectHex - The proof object as a hex string.
   * @param sha256 - The SHA-256 hash of the file.
   * @returns True if the proof is valid, false otherwise.
   */
  verifyProof(proofObjectHex: string, sha256: string): boolean {
    if (!isHexString(proofObjectHex)) {
      throw new Error("proofObjectHex must be a valid hex string");
    }
    if (!isHexString(sha256)) {
      throw new Error("sha256 must be a valid hex string");
    }

    // Convert the proofObjectHex back to a proof object
    const proofObject = JSON.parse(
      Buffer.from(proofObjectHex, "hex").toString("utf8")
    );

    const { key, rootHash, proof } = proofObject;
    const tree = this.deserializeTree(rootHash);
    const combinedHash = SHA256(`${key}/${sha256}`).toString();
    const leaf = Buffer.from(combinedHash, "hex");

    // Convert the proofHex string back to the proof array
    const proofBufferArray = [];
    for (let i = 0; i < proof.length; i += 64) {
      proofBufferArray.push(Buffer.from(proof.slice(i, i + 64), "hex"));
    }
    const proofArray = proofBufferArray.map((data) => ({ data }));

    return tree.verify(proofArray, leaf, Buffer.from(rootHash, "hex"));
  }

  /**
   * Get the difference between two Merkle tree roots.
   * @param rootHash1 - The first root hash.
   * @param rootHash2 - The second root hash.
   * @returns An object containing the added and deleted keys and their SHA-256 hashes.
   */
  getRootDiff(
    rootHash1: string,
    rootHash2: string
  ): { added: Map<string, string>; deleted: Map<string, string> } {
    if (!isHexString(rootHash1) || !isHexString(rootHash2)) {
      throw new Error("rootHash1 and rootHash2 must be valid hex strings");
    }

    const tree1 = this.deserializeTree(rootHash1);
    const tree2 = this.deserializeTree(rootHash2);

    // @ts-ignore
    const files1 = tree1.files as Map<string, { hash: string; sha256: string }>;
    // @ts-ignore
    const files2 = tree2.files as Map<string, { hash: string; sha256: string }>;

    const added = new Map<string, string>();
    const deleted = new Map<string, string>();

    files1.forEach((value, key) => {
      if (!files2.has(key)) {
        deleted.set(key, value.sha256);
      }
    });

    files2.forEach((value, key) => {
      if (!files1.has(key)) {
        added.set(key, value.sha256);
      }
    });

    return { added, deleted };
  }

  /**
   * Verify the integrity of a file based on its SHA-256 hash and check if it is in the specified Merkle root.
   * @param sha256 - The SHA-256 hash of the file.
   * @param root - The root hash to check against.
   * @returns True if the file integrity is verified and it is in the Merkle root, false otherwise.
   */
  async verifyKeyIntegrity(sha256: string, rootHash: string): Promise<boolean> {
    if (!isHexString(sha256)) {
      throw new Error("sha256 must be a valid hex string");
    }
    if (!isHexString(rootHash)) {
      throw new Error("rootHash must be a valid hex string");
    }

    const filePath = path.join(
      this.dataDir,
      sha256.match(/.{1,2}/g)!.join("/")
    );

    if (!fs.existsSync(filePath)) {
      throw new Error(`File at path ${filePath} does not exist`);
    }

    const compressedReadStream = fs.createReadStream(filePath);
    const decompressStream = zlib.createGunzip();
    const hash = crypto.createHash("sha256");

    return new Promise((resolve, reject) => {
      compressedReadStream.pipe(decompressStream);

      decompressStream.on("data", (chunk) => {
        hash.update(chunk);
      });

      decompressStream.on("end", () => {
        const uncompressedSha256 = hash.digest("hex");
        const isValid = uncompressedSha256 === sha256;
        console.log(`SHA-256 of uncompressed file: ${uncompressedSha256}`);

        if (!isValid) {
          return resolve(false);
        }

        const tree = this.deserializeTree(rootHash);
        const combinedHash = crypto
          .createHash("sha256")
          .update(`${toHex(sha256)}/${sha256}`)
          .digest("hex");
        const leaf = Buffer.from(combinedHash, "hex");
        const isInTree = tree.getLeafIndex(leaf) !== -1;

        resolve(isInTree);
      });

      decompressStream.on("error", (err) => {
        reject(err);
      });

      compressedReadStream.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Static method to validate key integrity using a foreign Merkle tree.
   * Verifies if a given SHA-256 hash for a key exists within the foreign tree and checks if the root hash matches.
   *
   * @param key - The hexadecimal key of the file.
   * @param sha256 - The SHA-256 hash of the file.
   * @param serializedTree - The foreign serialized Merkle tree.
   * @param expectedRootHash - The expected root hash of the Merkle tree.
   * @returns A boolean indicating if the SHA-256 is present in the foreign tree and the root hash matches.
   */
  static validateKeyIntegrityWithForeignTree(
    key: string,
    sha256: string,
    serializedTree: object,
    expectedRootHash: string
  ): boolean {
    if (!isHexString(key)) {
      throw new Error("key must be a valid hex string");
    }
    if (!isHexString(sha256)) {
      throw new Error("sha256 must be a valid hex string");
    }
    if (!isHexString(expectedRootHash)) {
      throw new Error("expectedRootHash must be a valid hex string");
    }

    // Deserialize the foreign tree
    const leaves = (serializedTree as any).leaves.map((leaf: string) =>
      Buffer.from(leaf, "hex")
    );
    const tree = new MerkleTree(leaves, SHA256, { sortPairs: true });

    // Verify that the deserialized tree's root matches the expected root hash
    const treeRootHash = tree.getRoot().toString("hex");
    if (treeRootHash !== expectedRootHash) {
      console.warn(
        `Expected root hash ${expectedRootHash}, but got ${treeRootHash}`
      );
      return false;
    }

    // Rebuild the files map from the serialized tree
    // @ts-ignore
    tree.files = new Map(
      Object.entries((serializedTree as any).files).map(
        ([key, value]: [string, any]) => [
          key,
          { hash: value.hash, sha256: value.sha256 },
        ]
      )
    );

    // Check if the SHA-256 exists in the foreign tree's files
    const combinedHash = crypto
      .createHash("sha256")
      .update(`${toHex(key)}/${sha256}`)
      .digest("hex");

    const leaf = Buffer.from(combinedHash, "hex");
    const isInTree = tree.getLeafIndex(leaf) !== -1;

    return isInTree;
  }
}

export { DataIntegrityTree };
