import * as urns from "urns";
import { createHash } from "crypto";
import { encode as base32Encode, decode as base32Decode } from "hi-base32";

class Udi {
  readonly chainName: string;
  private readonly _storeIdHex: string;
  private readonly _rootHashHex: string | null;
  readonly resourceKey: string | null;
  static readonly nid: string = "dig";
  static readonly namespace: string = `urn:${Udi.nid}`;

  constructor(
    chainName: string,
    storeId: string,
    rootHash: string | null = null,
    resourceKey: string | null = null
  ) {
    if (!storeId) {
      throw new Error("storeId cannot be empty");
    }
    this.chainName = chainName || "chia";
    this._storeIdHex = Udi.verifyAndFormatHex(storeId);
    this._rootHashHex = rootHash ? Udi.verifyAndFormatHex(rootHash) : null;
    this.resourceKey = resourceKey;
  }

  static verifyAndFormatHex(input: string): string {
    if (!/^[a-fA-F0-9]{64}$/.test(input)) {
      throw new Error("Input must be a 64-character hex string.");
    }
    return input;
  }

  static fromUrn(urn: string): Udi {
    const parsedUrn = urns.parseURN(urn);
    if (parsedUrn.nid !== Udi.nid) {
      throw new Error(`Invalid nid: ${parsedUrn.nid}`);
    }

    const parts = parsedUrn.nss.split(":");
    if (parts.length < 2) {
      throw new Error(`Invalid UDI format: ${parsedUrn.nss}`);
    }

    const chainName = parts[0];
    const storeIdHex = Udi.convertToHex(parts[1].split("/")[0]);

    let rootHashHex: string | null = null;
    if (parts.length > 2) {
      rootHashHex = Udi.convertToHex(parts[2].split("/")[0]);
    }

    const pathParts = parsedUrn.nss.split("/");
    let resourceKey: string | null = null;
    if (pathParts.length > 1) {
      resourceKey = pathParts.slice(1).join("/");
    }

    return new Udi(chainName, storeIdHex, rootHashHex, resourceKey);
  }

  static convertToHex(input: string): string {
    // Attempt hex conversion first
    if (/^[a-fA-F0-9]{64}$/.test(input)) return input;

    // Convert from Base32
    try {
      const paddedInput = Udi.addBase32Padding(input);
      const buffer = Buffer.from(base32Decode(paddedInput, false));
      return buffer.toString("hex");
    } catch (e) {
      console.warn("Base32 decoding failed, trying Base64 encoding...");
    }

    // Convert from Base64
    try {
      const standardBase64 = Udi.addBase64Padding(Udi.toStandardBase64(input));
      const buffer = Buffer.from(standardBase64, "base64");
      return buffer.toString("hex");
    } catch (e) {
      throw new Error("Invalid input encoding. Must be 32-byte hex, Base32, or Base64 string.");
    }
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
    const storeIdStr = this.formatBufferAsEncoding(this._storeIdHex, encoding);
    let urn = `${Udi.namespace}:${this.chainName}:${storeIdStr}`;

    if (this._rootHashHex) {
      const rootHashStr = this.formatBufferAsEncoding(this._rootHashHex, encoding);
      urn += `:${rootHashStr}`;
    }

    if (this.resourceKey) {
      urn += `/${this.resourceKey}`;
    }

    return urn;
  }

  private formatBufferAsEncoding(hexString: string, encoding: "hex" | "base32" | "base64"): string {
    const buffer = Buffer.from(hexString, "hex");
    if (encoding === "hex") {
      return hexString;
    } else if (encoding === "base32") {
      return base32Encode(buffer).replace(/=+$/, "");
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
      this._storeIdHex === other._storeIdHex &&
      this.chainName === other.chainName &&
      (this._rootHashHex && other._rootHashHex
        ? this._rootHashHex === other._rootHashHex
        : this._rootHashHex === other._rootHashHex) &&
      this.resourceKey === other.resourceKey
    );
  }

  toString(): string {
    return this.toUrn();
  }

  clone(): Udi {
    return new Udi(this.chainName, this._storeIdHex, this._rootHashHex, this.resourceKey);
  }

  hashCode(): string {
    const hash = createHash("sha256");
    hash.update(this.toUrn());
    return hash.digest("hex");
  }

  get storeId(): string {
    return this._storeIdHex;
  }

  get rootHash(): string | null {
    return this._rootHashHex;
  }

  get storeIdBase32(): string {
    return this.formatBufferAsEncoding(this._storeIdHex, "base32");
  }

  get rootHashBase32(): string | null {
    return this._rootHashHex ? this.formatBufferAsEncoding(this._rootHashHex, "base32") : null;
  }

  get storeIdBase64(): string {
    return this.formatBufferAsEncoding(this._storeIdHex, "base64");
  }

  get rootHashBase64(): string | null {
    return this._rootHashHex ? this.formatBufferAsEncoding(this._rootHashHex, "base64") : null;
  }
}

export { Udi };
