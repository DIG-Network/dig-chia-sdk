import * as urns from 'urns';

//
// This class encapsulates the concept of a Universal Data Identifier (UDI) which is a
// standardized way to identify resources across the distributed DIG mesh netowrk.
// The UDI is a URN (Uniform Resource Name) that is used to identify resources
// in the DIG network. The UDI is composed of the following parts:
//   - Chain Name: The name of the blockchain network where the resource is stored.
//   - Store ID: The unique identifier of the store where the resource is stored.
//   - Root Hash: The root hash of the resource in the store.
//   - Resource Key: The key of the resource in the store.
// The UDI is formatted as follows:
//   urn:dig:chainName:storeId:rootHash/resourceKey
// The chainName and storeId are required, while the rootHash and resourceKey are optional.
// The UDI can be used to uniquely identify resources across the DIG network.
// The UDI can be converted to a URN string and vice versa.
// https://github.com/DIG-Network/DIPS/blob/c6792331acf3c185ca87a8f4f847561d2b47fb31/DIPs/dip-0001.md
//
class Udi {
    readonly chainName: string;
    readonly storeId: string;
    readonly rootHash: string | null;
    readonly resourceKey: string | null;
    static readonly nid: string = "dig";
    static readonly namespace: string = `urn:${Udi.nid}`;

    constructor(chainName: string, storeId: string, rootHash: string | null = null, resourceKey: string | null = null) {
        this.chainName = chainName ?? "chia";
        this.storeId = storeId;
        this.rootHash = rootHash;
        this.resourceKey = resourceKey;
    }

    fromRootHash(rootHash: string): Udi {
        return new Udi(this.chainName, this.storeId, rootHash, this.resourceKey);
    }

    fromResourceKey(resourceKey: string | null): Udi {
        return new Udi(this.chainName, this.storeId, this.rootHash, resourceKey);
    }

    static fromUrn(urn: string): Udi {
        const parsedUrn = urns.parseURN(urn);
        if (parsedUrn.nid.toLowerCase() !== Udi.nid) {
            throw new Error(`Invalid namespace: ${parsedUrn.nid}`);
        }

        const parts = parsedUrn.nss.split(':');
        // at a minimum we need chain name and store id
        if (parts.length < 2) {
            throw new Error(`Invalid URN format: ${parsedUrn.nss}`);
        }

        // this is what a nss looks like
        //"chia:store id:optional_roothash/optional path/resource key"
        const chainName = parts[0];
        const storeId = parts[1].split('/')[0]; // need to strip off the optional path component

        // root hash will always be the part after the second :
        let rootHash: string | null = null;
        if (parts.length > 2) {
            rootHash = parts[2].split('/')[0]; // need to strip off the optional path component
        }

        // now see if we have a path component which will always follow the first /
        const pathParts = parsedUrn.nss.split('/');
        let resourceKey: string | null = null;
        if (pathParts.length > 1) {
            resourceKey = pathParts.slice(1).join('/');
        }

        return new Udi(chainName, storeId, rootHash, resourceKey);
    }

    toUrn(): string {
        let urn = `${Udi.namespace}:${this.chainName}:${this.storeId}`;
        if (this.rootHash !== null) {
            urn += `:${this.rootHash}`;
        }

        if (this.resourceKey !== null) {
            urn += `/${this.resourceKey}`;
        }

        return urn;
    }

    equals(other: Udi): boolean {
        return this.storeId === other.storeId &&
            this.chainName === other.chainName &&
            this.rootHash === other.rootHash &&
            this.resourceKey === other.resourceKey;
    }

    toString(): string {
        return this.toUrn();
    }
}

export { Udi };