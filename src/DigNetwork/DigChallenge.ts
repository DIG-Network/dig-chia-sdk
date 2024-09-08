import * as crypto from "crypto";
import * as fs from "fs";
import { DataStore } from "../blockchain";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { DIG_FOLDER_PATH } from "../utils/config";

export class DigChallenge {
  private readonly SEGMENT_SIZE: number;
  private readonly NUMBER_OF_SEGMENTS: number;
  private readonly HASH_ALGORITHM: string;
  private readonly fileHash: string;
  private readonly storeId: string;
  private readonly hexKey: string;
  private readonly rootHash: string;
  private filePath: string;
  private fileSize: number = 0;

  constructor(
    storeId: string,
    hexKey: string,
    rootHash: string,
    segmentSize = 1024,
    numberOfSegments = 10,
    hashAlgorithm = "sha256"
  ) {
    this.storeId = storeId;
    this.hexKey = hexKey;
    this.rootHash = rootHash;

    this.SEGMENT_SIZE = segmentSize; // Size of each segment to hash (default 1 KB)
    this.NUMBER_OF_SEGMENTS = numberOfSegments; // Number of segments to select for the challenge
    this.HASH_ALGORITHM = hashAlgorithm; // Hash algorithm (default sha256)

    const dataStore = DataStore.from(storeId);
    const sha256 = dataStore.Tree.getSHA256(hexKey, rootHash);

    if (!sha256) {
      throw new Error("Invalid hexKey or root hash");
    }

    this.fileHash = sha256;
    this.filePath = getFilePathFromSha256(
      sha256,
      `${DIG_FOLDER_PATH}/stores/${storeId}/data`
    );
  }

  /**
   * Initializes file info like file size, based on the resolved filePath.
   */
  private async initFileInfo(): Promise<void> {
    const fileStat = await fs.promises.stat(this.filePath);
    this.fileSize = fileStat.size;
  }

  /**
   * Generates a challenge by selecting random segments from the file using the instance's seed.
   * The response includes the seed, selected segments, key (SHA-256), storeId, and rootHash.
   *
   * @param seed A random seed for generating the challenge.
   * @returns An object containing the seed, segments, storeId, key (SHA-256), and rootHash.
   */
  public async generateChallenge(
    seed: string
  ): Promise<{
    seed: string;
    segments: number[];
    key: string;
    storeId: string;
    rootHash: string;
  }> {
    if (!this.fileSize) {
      await this.initFileInfo(); // Ensure file info is available
    }

    // Use the seed to create a deterministic random value
    const random = crypto.createHash("sha256").update(seed).digest("hex");
    const randomSeed = parseInt(random, 16);

    const segments: number[] = [];
    for (let i = 0; i < this.NUMBER_OF_SEGMENTS; i++) {
      const segmentPosition =
        (randomSeed + i) % (this.fileSize - this.SEGMENT_SIZE); // Ensure valid segment position
      segments.push(segmentPosition);
    }

    return {
      seed,
      segments,
      key: this.hexKey,
      storeId: this.storeId,
      rootHash: this.rootHash,
    };
  }

  /**
   * Creates a challenge response by reading the file and hashing the selected segments.
   *
   * @param challenge The challenge object containing the seed, segments, storeId, and key (SHA-256).
   * @returns A promise that resolves to the challenge response hash.
   */
  public async createChallengeResponse(challenge: {
    seed: string;
    segments: number[];
  }): Promise<string> {
    const fileHandle = await fs.promises.open(this.filePath, "r");
    const hash = crypto.createHash(this.HASH_ALGORITHM);

    try {
      for (const segmentPosition of challenge.segments) {
        const buffer = Buffer.alloc(this.SEGMENT_SIZE);
        await fileHandle.read(buffer, 0, this.SEGMENT_SIZE, segmentPosition);
        hash.update(buffer);
      }
    } finally {
      await fileHandle.close();
    }

    return hash.digest("hex");
  }

  /**
   * Verifies that the server's response matches the client's calculated response.
   *
   * @param clientResponse The client's calculated challenge response.
   * @param serverResponse The server's challenge response.
   * @returns True if the responses match, false otherwise.
   */
  public verifyChallengeResponse(
    clientResponse: string,
    serverResponse: string
  ): boolean {
    return clientResponse === serverResponse;
  }

  /**
   * Serializes a challenge object into a hex string.
   * This converts the challenge into a format suitable for transport or storage.
   *
   * @param challenge The challenge object to serialize.
   * @returns A hex string representing the serialized challenge.
   */
  public static serializeChallenge(challenge: {
    seed: string;
    segments: number[];
    key: string;
    storeId: string;
    rootHash: string;
  }): string {
    const challengeString = JSON.stringify(challenge);
    return Buffer.from(challengeString).toString("hex");
  }

  /**
   * Deserializes a hex string into a challenge object.
   * This converts the hex-encoded string back into a challenge object.
   *
   * @param hexString The hex string representing the serialized challenge.
   * @returns The deserialized challenge object.
   */
  public static deserializeChallenge(hexString: string): {
    seed: string;
    segments: number[];
    key: string;
    storeId: string;
    rootHash: string;
  } {
    const challengeString = Buffer.from(hexString, "hex").toString();
    return JSON.parse(challengeString);
  }

  /**
   * Generates a random seed using a cryptographically secure random number generator.
   * @returns A random seed in hexadecimal format.
   */
  public static generateSeed(): string {
    return crypto.randomBytes(32).toString("hex");
  }
}