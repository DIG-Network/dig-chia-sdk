import * as urns from 'urns';
import { createHash } from 'crypto';
import { encode as base32Encode, decode as base32Decode } from 'hi-base32';

//
// This class encapsulates the concept of a Universal Data Identifier (UDI), which is a
// standardized way to identify resources across the distributed DIG mesh network.
// The UDI format: urn:dig:chainName:storeId:rootHash/resourceKey
// This allows unique resource identification across the DIG network.
//
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
      return Buffer.from(input, 'hex');
    }

    if (Udi.isBase32(input)) {
      return Buffer.from(base32Decode(input.toUpperCase(), false)); // Decode with uppercase
    }

    throw new Error("Invalid input encoding. Must be 32-byte hex or Base32 string.");
  }

  static isHex(input: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(input);
  }

  static isBase32(input: string): boolean {
    return /^[A-Z2-7]{52}$/.test(input.toUpperCase());
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

    const parts = parsedUrn.nss.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid UDI format: ${parsedUrn.nss}`);
    }

    const chainName = parts[0];
    const storeId = parts[1].split('/')[0];

    let rootHash: string | null = null;
    if (parts.length > 2) {
      rootHash = parts[2].split('/')[0];
    }

    const pathParts = parsedUrn.nss.split('/');
    let resourceKey: string | null = null;
    if (pathParts.length > 1) {
      resourceKey = pathParts.slice(1).join('/');
    }

    return new Udi(chainName, storeId, rootHash, resourceKey);
  }

  toUrn(encoding: 'hex' | 'base32' | 'base64' = 'hex'): string {
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

  bufferToString(buffer: Buffer, encoding: 'hex' | 'base32' | 'base64'): string {
    switch (encoding) {
      case 'hex':
        return buffer.toString('hex');
      case 'base32':
        return base32Encode(buffer).toUpperCase().replace(/=+$/, ''); // Convert to uppercase and remove padding
      case 'base64':
        return buffer.toString('base64').toLowerCase(); // Convert to lowercase
      default:
        throw new Error("Unsupported encoding");
    }
  }

  equals(other: Udi): boolean {
    return (
      this._storeId.equals(other._storeId) &&
      this.chainName === other.chainName &&
      (this._rootHash && other._rootHash ? this._rootHash.equals(other._rootHash) : this._rootHash === other._rootHash) &&
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
    const hash = createHash('sha256');
    hash.update(this.toUrn());
    return hash.digest('hex');
  }

  // Getter for storeId as a hex string
  get storeId(): string {
    return this._storeId.toString('hex');
  }

  // Getter for rootHash as a hex string
  get rootHash(): string | null {
    return this._rootHash ? this._rootHash.toString('hex') : null;
  }
}

export { Udi };
