// SubDomain.ts

/**
 * SubDomain Class
 *
 * Encapsulates the logic for encoding and decoding a combination of
 * chain and storeId into a DNS-friendly identifier using Base62 encoding.
 */
class SubDomain {
    // Define the Base62 character set
    private static readonly BASE62_CHARSET =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  
    // Define expected byte length for storeId
    private static readonly STORE_ID_LENGTH = 32; // bytes
  
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
     * Encodes the provided chain and storeId into a DNS-friendly identifier.
     *
     * @returns The Base62-encoded identifier.
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
  
      // Encode the data buffer using Base62
      const encodedId = SubDomain.encodeBase62(dataBuffer);
  
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
     * @param encodedId - The Base62-encoded identifier.
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
  
      // Decode the Base62 string back to a Buffer
      const decodedBuffer = SubDomain.decodeBase62(encodedId);
  
      if (!decodedBuffer) {
        throw new Error("Failed to decode Base62 string.");
      }
  
      // Ensure there's at least 1 byte for chain_length and STORE_ID_LENGTH bytes for storeId
      if (decodedBuffer.length < 1 + SubDomain.STORE_ID_LENGTH) {
        throw new Error("Decoded data is too short to contain required fields.");
      }
  
      // Extract chain_length (1 byte)
      const chain_length = decodedBuffer.readUInt8(0);
  
      // Extract chain
      const chain = decodedBuffer.slice(1, 1 + chain_length).toString("utf8");
  
      // Extract storeId
      const storeIdBuffer = decodedBuffer.slice(
        1 + chain_length,
        1 + chain_length + SubDomain.STORE_ID_LENGTH
      );
  
      // Convert storeId buffer to hex string
      const storeId = storeIdBuffer.toString("hex");
  
      return { chain, storeId };
    }
  
    /**
     * Encodes a Buffer into a Base62 string.
     *
     * @param buffer - The Buffer to encode.
     * @returns The Base62-encoded string.
     */
    private static encodeBase62(buffer: Buffer): string {
      if (buffer.length === 0) return "";
  
      // Convert Buffer to BigInt
      let num = BigInt(0);
      for (let i = 0; i < buffer.length; i++) {
        num = (num << BigInt(8)) + BigInt(buffer[i]);
      }
  
      // Base62 encoding
      let encoded = "";
      const base = BigInt(62);
  
      if (num === BigInt(0)) {
        encoded = SubDomain.BASE62_CHARSET[0];
      } else {
        while (num > 0) {
          const remainder = num % base;
          encoded = SubDomain.BASE62_CHARSET[Number(remainder)] + encoded;
          num = num / base;
        }
      }
  
      // Handle leading zero bytes
      let leadingZeros = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0) {
          leadingZeros++;
        } else {
          break;
        }
      }
      for (let i = 0; i < leadingZeros; i++) {
        encoded = SubDomain.BASE62_CHARSET[0] + encoded;
      }
  
      return encoded;
    }
  
    /**
     * Decodes a Base62 string into a Buffer.
     *
     * @param str - The Base62 string to decode.
     * @returns The decoded Buffer.
     */
    private static decodeBase62(str: string): Buffer {
      if (str.length === 0) return Buffer.alloc(0);
  
      // Handle leading '0's
      let leadingZeros = 0;
      while (leadingZeros < str.length && str[leadingZeros] === SubDomain.BASE62_CHARSET[0]) {
        leadingZeros++;
      }
  
      // Decode the Base62 string to BigInt
      let num = BigInt(0);
      const base = BigInt(62);
      for (let i = leadingZeros; i < str.length; i++) {
        const char = str[i];
        const value = SubDomain.BASE62_CHARSET.indexOf(char);
        if (value === -1) {
          throw new Error(`Invalid character in Base62 string: ${char}`);
        }
        num = num * base + BigInt(value);
      }
  
      // Convert BigInt to Buffer
      let hex = num.toString(16);
      if (hex.length % 2 !== 0) {
        hex = "0" + hex;
      }
      let decoded = Buffer.from(hex, "hex");
  
      // Prepend leading zero bytes
      if (leadingZeros > 0) {
        const zeroBuffer = Buffer.alloc(leadingZeros, 0);
        decoded = Buffer.concat([zeroBuffer, decoded]);
      }
  
      return decoded;
    }
  }
  
  export { SubDomain };
  