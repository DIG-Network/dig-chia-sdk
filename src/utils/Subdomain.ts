// SubDomain.ts

import baseX from "base-x";

/**
 * SubDomain Class
 *
 * Encapsulates the logic for encoding and decoding a combination of
 * chain and storeId into a DNS-friendly identifier using Base36 encoding.
 */
class SubDomain {
  // Define the Base36 character set (only lowercase letters and digits)
  private static readonly BASE36_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyz";

  // Initialize the Base36 encoder/decoder
  private static base36 = baseX(SubDomain.BASE36_CHARSET);

  // Define expected byte length for storeId
  private static readonly STORE_ID_LENGTH = 32; // bytes

  // Properties
  public readonly chain: string;
  public readonly storeId: string;
  public readonly encodedId: string;

  /**
   * Constructor for SubDomain
   *
   * @param chain - The chain name (e.g., "chain1234").
   * @param storeId - The store ID as a 64-character hexadecimal string.
   * @throws Will throw an error if inputs are invalid or encoding exceeds DNS limits.
   */
  constructor(chain: string, storeId: string) {
    this.chain = chain;
    this.storeId = storeId;
    this.encodedId = this.encode();
  }

  /**
   * Encodes the provided chain and storeId into a DNS-friendly identifier.
   *
   * @returns The Base36-encoded identifier.
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

    // Convert chain length to a single byte
    const chainLengthBuffer = Buffer.from([chainLength]);

    // Convert chain to a Buffer (UTF-8)
    const chainBuffer = Buffer.from(this.chain, "utf8");

    // Convert storeId from hex string to Buffer
    const storeIdBuffer = Buffer.from(this.storeId, "hex");

    // Validate storeId byte length
    if (storeIdBuffer.length !== SubDomain.STORE_ID_LENGTH) {
      throw new Error(
        `Invalid storeId length: Expected ${SubDomain.STORE_ID_LENGTH} bytes, got ${storeIdBuffer.length} bytes.`
      );
    }

    // Concatenate chain_length, chain, and storeId buffers
    const dataBuffer = Buffer.concat([
      chainLengthBuffer,
      chainBuffer,
      storeIdBuffer,
    ]);

    // Encode the data buffer using Base36
    const encodedId = SubDomain.base36.encode(dataBuffer);

    // Ensure DNS label length does not exceed 63 characters
    if (encodedId.length > 63) {
      throw new Error(
        `Encoded identifier length (${encodedId.length}) exceeds DNS label limit of 63 characters.`
      );
    }

    return encodedId;
  }

  /**
   * Decodes the provided identifier back into the original chain and storeId.
   *
   * @param encodedId - The Base36-encoded identifier.
   * @returns An object containing the original chain and storeId.
   * @throws Will throw an error if decoding fails or data lengths mismatch.
   */
  public static decode(encodedId: string): { chain: string; storeId: string } {
    // Validate input
    if (!encodedId || typeof encodedId !== "string") {
      throw new Error(
        "Invalid encodedId: encodedId must be a non-empty string."
      );
    }

    // Decode the Base36 string back to a Buffer
    const decodedBuffer = SubDomain.base36.decode(encodedId);

    if (!decodedBuffer) {
      throw new Error("Failed to decode Base36 string.");
    }

    // Ensure there's at least 1 byte for chain_length and STORE_ID_LENGTH bytes for storeId
    if (decodedBuffer.length < 1 + SubDomain.STORE_ID_LENGTH) {
      throw new Error("Decoded data is too short to contain required fields.");
    }

    // Extract chain_length (1 byte)
    const chain_length = Buffer.from(decodedBuffer).readUInt8(0);

    // Extract chain
    const chain = Buffer.from(decodedBuffer.slice(1, 1 + chain_length)).toString("utf8");

    // Extract storeId
    const storeIdBuffer = decodedBuffer.slice(
      1 + chain_length,
      1 + chain_length + SubDomain.STORE_ID_LENGTH
    );

    // Convert storeId buffer to hex string
    const storeId = Buffer.from(storeIdBuffer).toString("hex");

    return { chain, storeId };
  }
}

export { SubDomain };
