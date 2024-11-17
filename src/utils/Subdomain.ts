// SubDomain.ts

import baseX from "base-x";
import crypto from "crypto";

/**
 * SubDomain Class
 *
 * Encapsulates the logic for encoding and decoding a combination of
 * chain and storeId into a DNS-friendly identifier using Base62 encoding and HMAC.
 */
class SubDomain {
  // Define the Base62 character set
  private static readonly BASE62_CHARSET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  // Initialize the Base62 encoder/decoder
  private static base62 = baseX(SubDomain.BASE62_CHARSET);

  // Define expected byte length for storeId
  private static readonly DEFAULT_STORE_ID_LENGTH = 32; // bytes
  private static readonly HMAC_LENGTH = 32; // bytes for HMAC-SHA256

  // Hardcoded compression key
  private static readonly COMPRESSION_KEY =
    "7a4e8d2f6b1c9a3f5d8e2c4b7a1f9d3e6b8c5a2f4d7e9b1c8a3f5d2e6b9c4a7";

  // Properties
  public readonly chain: string;
  public readonly storeId: string;
  public readonly encodedId: string;

  /**
   * Constructor for SubDomain
   *
   * @param chain - The chain name (e.g., "CHAIN1234").
   * @param storeId - The store ID as a 64-character hexadecimal string.
   * @throws Will throw an error if inputs are invalid or encoding exceeds DNS limits.
   */
  constructor(chain: string, storeId: string) {
    this.chain = chain;
    this.storeId = storeId;
    this.encodedId = this.encode();
  }

  /**
   * Encodes the provided chain and storeId into a DNS-friendly identifier with HMAC.
   *
   * @returns The Base62-encoded identifier with appended HMAC.
   * @throws Will throw an error if encoding fails.
   */
  private encode(): string {
    // Validate inputs
    if (!this.chain || typeof this.chain !== "string") {
      throw new Error("Invalid chain: Chain must be a non-empty string.");
    }

    if (
      !this.storeId ||
      typeof this.storeId !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(this.storeId)
    ) {
      throw new Error(
        "Invalid storeId: StoreId must be a 64-character hexadecimal string."
      );
    }

    // Ensure the chain length is within 1-255 characters to fit in one byte
    const chainLength = this.chain.length;
    if (chainLength < 1 || chainLength > 255) {
      throw new Error(
        "Invalid chain: Length must be between 1 and 255 characters."
      );
    }

    // Convert chain length to a single byte Buffer
    const chainLengthBuffer = Buffer.from([chainLength]);

    // Convert chain to a Buffer (UTF-8)
    const chainBuffer = Buffer.from(this.chain, "utf8");

    // Convert storeId from hex string to Buffer
    const storeIdBuffer = Buffer.from(this.storeId, "hex");

    // Validate storeId byte length
    if (storeIdBuffer.length !== SubDomain.DEFAULT_STORE_ID_LENGTH) {
      throw new Error(
        `Invalid storeId length: Expected ${SubDomain.DEFAULT_STORE_ID_LENGTH} bytes, got ${storeIdBuffer.length} bytes.`
      );
    }

    // Concatenate chain_length, chain, and storeId buffers
    const dataBuffer = Buffer.concat([
      chainLengthBuffer,
      chainBuffer,
      storeIdBuffer,
    ]);

    // Create HMAC using SHA256
    const hmac = crypto.createHmac("sha256", SubDomain.COMPRESSION_KEY);
    hmac.update(dataBuffer);
    const hmacDigest = hmac.digest(); // 32 bytes

    // Concatenate dataBuffer and hmacDigest
    const finalBuffer = Buffer.concat([dataBuffer, hmacDigest]);

    // Encode the final buffer using Base62
    const encodedId = SubDomain.base62.encode(finalBuffer);

    // Ensure DNS label length does not exceed 63 characters
    if (encodedId.length > 63) {
      throw new Error(
        `Encoded identifier length (${encodedId.length}) exceeds DNS label limit of 63 characters.`
      );
    }

    return encodedId;
  }

  /**
   * Decodes the provided identifier back into the original chain and storeId after verifying HMAC.
   *
   * @param encodedId - The Base62-encoded identifier with appended HMAC.
   * @returns An object containing the original chain and storeId.
   * @throws Will throw an error if decoding fails, HMAC verification fails, or data lengths mismatch.
   */
  public static decode(encodedId: string): { chain: string; storeId: string } {
    // Validate input
    if (!encodedId || typeof encodedId !== "string") {
      throw new Error(
        "Invalid encodedId: encodedId must be a non-empty string."
      );
    }

    // Decode the Base62 string back to a Buffer
    const decodedBuffer = SubDomain.base62.decode(encodedId);

    if (!decodedBuffer) {
      throw new Error("Failed to decode Base62 string.");
    }

    // Ensure there's at least 1 byte for chain_length and 64 bytes for storeId and HMAC
    if (
      decodedBuffer.length <
      1 + SubDomain.DEFAULT_STORE_ID_LENGTH + SubDomain.HMAC_LENGTH
    ) {
      throw new Error("Decoded data is too short to contain required fields.");
    }

    // Extract chain_length (1 byte)
    const chain_length = Buffer.from(decodedBuffer).readUInt8(0);

    // Define the expected total length
    const expected_length =
      1 +
      chain_length +
      SubDomain.DEFAULT_STORE_ID_LENGTH +
      SubDomain.HMAC_LENGTH;

    if (decodedBuffer.length !== expected_length) {
      throw new Error(
        `Decoded data length mismatch: expected ${expected_length} bytes, got ${decodedBuffer.length} bytes.`
      );
    }

    // Extract chain, storeId, and received HMAC from the buffer
    const chain = Buffer.from(
      decodedBuffer.slice(1, 1 + chain_length)
    ).toString("utf8");
    const storeIdBuffer = decodedBuffer.slice(
      1 + chain_length,
      1 + chain_length + SubDomain.DEFAULT_STORE_ID_LENGTH
    );
    const receivedHmac = decodedBuffer.slice(
      1 + chain_length + SubDomain.DEFAULT_STORE_ID_LENGTH,
      expected_length
    );

    // Recompute HMAC over [chain_length][chain][storeId]
    const dataBuffer = decodedBuffer.slice(
      0,
      1 + chain_length + SubDomain.DEFAULT_STORE_ID_LENGTH
    );
    const hmac = crypto.createHmac("sha256", SubDomain.COMPRESSION_KEY);
    hmac.update(dataBuffer);
    const expectedHmac = hmac.digest(); // 32 bytes

    // Compare HMACs securely
    if (!crypto.timingSafeEqual(receivedHmac, expectedHmac)) {
      throw new Error("HMAC verification failed: Invalid identifier.");
    }

    // Convert storeId buffer to hex string
    const storeId = Buffer.from(storeIdBuffer).toString("hex");

    return { chain, storeId };
  }
}

export { SubDomain };
