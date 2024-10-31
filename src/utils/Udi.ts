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
      return input;
    }

    if (Udi.isHex(input)) {
      return Buffer.from(input, "hex");
    }

    if (Udi.isBase32(input)) {
      const paddedInput = Udi.addBase32Padding(input.toUpperCase());
      return Buffer.from(base32Decode(paddedInput, false));
    }

    if (Udi.isBase64Safe(input)) {
      const standardBase64 = Udi.addBase64Padding(Udi.toStandardBase64(input));
      return Buffer.from(standardBase64, "base64");
    }

    throw new Error("Invalid input encoding. Must be 32-byte hex, Base32, or Base64 URL-safe string.");
  }

  static isHex(input: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(input);
  }

  static isBase32(input: string): boolean {
    return /^[a-z2-7]{52}$/.test(input.toLowerCase());
  }

  static isBase64Safe(input: string): boolean {
    return /^[A-Za-z0-9\-_]+$/.test(input);
  }

  static addBase32Padding(input: string): string {
    const paddingNeeded = (8 - (input.length % 8)) % 8;
    return input + "=".repeat(paddingNeeded);
  }

  static toStandardBase64(base64Safe: string): string {
    return base64Safe.replace(/-/g, "+").replace(/_/g, "/");
  }

  static toBase64Safe(base64Standard: string): string {
    return base64Standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static addBase64Padding(base64: string): string {
    const paddingNeeded = (4 - (base64.length % 4)) % 4;
    return base64 + "=".repeat(paddingNeeded);
  }

  withRootHash(rootHash: string | Buffer | null): Udi {
    return new Udi(this.chainName, this._storeId, rootHash, this.resourceKey);
  }

  withResourceKey(resourceKey: string | null): Udi {
    return new Udi(this.chainName, this._storeId, this._rootHash, resourceKey);
  }

  static fromUrn(urn: string): Udi {
    const parsedUrn = urns.parseURN(urn);
    if (parsedUrn.nid.toLowerCase() !== Udi.nid) {
      throw new Error(`Invalid nid: ${parsedUrn.nid}`);
    }

    const parts = parsedUrn.nss.split(":");
    if (parts.length < 2) {
      throw new Error(`Invalid UDI format: ${parsedUrn.nss}`);
    }

    const chainName = parts[0];
    const storeId = parts[1].split("/")[0];

    let rootHash: string | null = null;
    if (parts.length > 2) {
      rootHash = parts[2].split("/")[0];
    }

    const pathParts = parsedUrn.nss.split("/");
    let resourceKey: string | null = null;
    if (pathParts.length > 1) {
      resourceKey = pathParts.slice(1).join("/");
    }

    return new Udi(chainName, storeId, rootHash, resourceKey);
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
      return Udi.toBase64Safe(buffer.toString("base64"));
    }
    throw new Error("Unsupported encoding type");
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
