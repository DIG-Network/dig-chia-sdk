import * as urns from 'urns';
import { createHash } from 'crypto';
import { encode as base32Encode, decode as base32Decode } from 'hi-base32';

//
// This class encapsulates the concept of a Universal Data Identifier (UDI) which is a
// standardized way to identify resources across the distributed DIG mesh network.
// The UDI is formatted as follows:
//   urn:dig:chainName:storeId:rootHash/resourceKey
// The UDI can be used to uniquely identify resources across the DIG network.
//
class Udi {
    readonly chainName: string;
    readonly storeId: Buffer;
    readonly rootHash: Buffer | null;
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
        this.storeId = Udi.convertToBuffer(storeId);
        this.rootHash = rootHash ? Udi.convertToBuffer(rootHash) : null;
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
            return Buffer.from(base32Decode(input, false)); // Decode as UTF-8
        }

        throw new Error("Invalid input encoding. Must be 32-byte hex or Base32 string.");
    }

    static isHex(input: string): boolean {
        return /^[a-fA-F0-9]{64}$/.test(input);
    }

    static isBase32(input: string): boolean {
        return /^[a-z2-7]{52}$/.test(input.toLowerCase());
    }

    withRootHash(rootHash: string | Buffer | null): Udi {
        return new Udi(this.chainName, this.storeId, rootHash, this.resourceKey);
    }

    withResourceKey(resourceKey: string | null): Udi {
        return new Udi(this.chainName, this.storeId, this.rootHash, resourceKey);
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

    toUrn(encoding: 'hex' | 'base32' = 'hex'): string {
        const storeIdStr = this.bufferToString(this.storeId, encoding);
        let urn = `${Udi.namespace}:${this.chainName}:${storeIdStr}`;

        if (this.rootHash) {
            const rootHashStr = this.bufferToString(this.rootHash, encoding);
            urn += `:${rootHashStr}`;
        }

        if (this.resourceKey) {
            urn += `/${this.resourceKey}`;
        }

        return urn;
    }

    bufferToString(buffer: Buffer, encoding: 'hex' | 'base32'): string {
        return encoding === 'hex'
            ? buffer.toString('hex')
            : base32Encode(buffer).toLowerCase().replace(/=+$/, '');
    }

    equals(other: Udi): boolean {
        return (
            this.storeId.equals(other.storeId) &&
            this.chainName === other.chainName &&
            (this.rootHash && other.rootHash ? this.rootHash.equals(other.rootHash) : this.rootHash === other.rootHash) &&
            this.resourceKey === other.resourceKey
        );
    }

    toString(): string {
        return this.toUrn();
    }

    clone(): Udi {
        return new Udi(this.chainName, this.storeId, this.rootHash, this.resourceKey);
    }

    hashCode(): string {
        const hash = createHash('sha256');
        hash.update(this.toUrn());
        return hash.digest('hex');
    }
}

export { Udi };
