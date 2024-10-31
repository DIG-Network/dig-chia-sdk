import * as urns from "urns";
import { createHash } from "crypto";
import { encode as base32Encode, decode as base32Decode } from "hi-base32";

class Udi {
  readonly chainName: string;
  private readonly _storeId: Buffer;
  private readonly _rootHash: Buffer | null;
  readonly resourceKey: string | null;
  static readonly nid: string = "dig";
  static readonly namespace: string = `urn:${Udi.nid}`;

  constructor(
    chainName: string,
    storeId: string | Buffer,
    rootHash: string | Buffer | null = null,
    resourceKey: string | null = null
  ) {
    if (!storeId) {
      throw new Error("storeId cannot be empty");
    }
    this.chainName = chainName || "chia";
    this._storeId = Udi.convertToBuffer(storeId);
    this._rootHash = rootHash ? Udi.convertToBuffer(rootHash) : null;
    this.resourceKey = resourceKey;
  }

  static convertToBuffer(input: string | Buffer): Buffer {
    if (Buffer.isBuffer(input)) {
      if (input.length !== 32) {
        throw new Error("Buffer must be exactly 32 bytes.");
      }
      return input;
    }

    // Attempt hex decoding
    if (/^[a-fA-F0-9]+$/.test(input) && input.length === 64) {
      try {
        const buffer = Buffer.from(input, "hex");
        if (buffer.length === 32) return buffer;
      } catch (e) {
        console.warn("Hex decoding failed, trying next encoding...");
      }
    }

    // Attempt Base32 decoding
    try {
      const paddedInput = Udi.addBase32Padding(input.toUpperCase());
      const buffer = Buffer.from(base32Decode(paddedInput, false));
      if (buffer.length === 32) return buffer;
    } catch (e) {
      console.warn("Base32 decoding failed, trying Base64 encoding...");
    }

    // Attempt Base64 (URL-safe) decoding
    try {
      const standardBase64 = Udi.addBase64Padding(Udi.toStandardBase64(input));
      const buffer = Buffer.from(standardBase64, "base64");
      if (buffer.length === 32) return buffer;
    } catch (e) {
      throw new Error("Invalid input encoding. Must be 32-byte hex, Base32, or Base64 string.");
    }

    throw new Error("Failed to decode input as a 32-byte buffer.");
  }

  static addBase32Padding(input: string): string {
    const paddingNeeded = (8 - (input.length % 8)) % 8;
    return input + "=".repeat(paddingNeeded);
  }

  static toStandardBase64(base64UrlSafe: string): string {
    return base64UrlSafe.replace(/-/g, "+").replace(/_/g, "/");
  }

  static addBase64Padding(base64: string): string {
    const paddingNeeded = (4 - (base64.length % 4)) % 4;
    return base64 + "=".repeat(paddingNeeded);
  }

  toUrn(encoding: "hex" | "base32" | "base64" = "hex"): string {
    const storeIdStr = this.bufferToString(this._storeId, encoding);
    let urn = `${Udi.namespace}:${this.chainName}:${storeIdStr}`;

    if (this._rootHash) {
      const rootHashStr = this.bufferToString(this._rootHash, encoding);
      urn += `:${rootHashStr}`;
    }

    if (this.resourceKey) {
      urn += `/${this.resourceKey}`;
    }

    return urn;
  }

  bufferToString(buffer: Buffer, encoding: "hex" | "base32" | "base64"): string {
    if (encoding === "hex") {
      return buffer.toString("hex");
    } else if (encoding === "base32") {
      return base32Encode(buffer).toLowerCase().replace(/=+$/, "");
    } else if (encoding === "base64") {
      return Udi.toBase64UrlSafe(buffer.toString("base64"));
    }
    throw new Error("Unsupported encoding type");
  }

  static toBase64UrlSafe(base64Standard: string): string {
    return base64Standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  equals(other: Udi): boolean {
    return (
      this._storeId.equals(other._storeId) &&
      this.chainName === other.chainName &&
      (this._rootHash && other._rootHash
        ? this._rootHash.equals(other._rootHash)
        : this._rootHash === other._rootHash) &&
      this.resourceKey === other.resourceKey
    );
  }

  toString(): string {
    return this.toUrn();
  }

  clone(): Udi {
    return new Udi(this.chainName, this._storeId, this._rootHash, this.resourceKey);
  }

  hashCode(): string {
    const hash = createHash("sha256");
    hash.update(this.toUrn());
    return hash.digest("hex");
  }

  get storeId(): string {
    return this._storeId.toString("hex");
  }

  get rootHash(): string | null {
    return this._rootHash ? this._rootHash.toString("hex") : null;
  }

  get storeIdBase32(): string {
    return this.bufferToString(this._storeId, "base32");
  }

  get rootHashBase32(): string | null {
    return this._rootHash ? this.bufferToString(this._rootHash, "base32") : null;
  }

  get storeIdBase64(): string {
    return this.bufferToString(this._storeId, "base64");
  }

  get rootHashBase64(): string | null {
    return this._rootHash ? this.bufferToString(this._rootHash, "base64") : null;
  }
}

export { Udi };
