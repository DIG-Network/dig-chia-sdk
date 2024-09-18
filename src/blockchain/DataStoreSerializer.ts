import {
  DataStore,
  Coin,
  Proof,
  DataStoreMetadata,
  DelegatedPuzzle,
} from "@dignetwork/datalayer-driver";
import { Buffer } from "buffer";

export class DataStoreSerializer {
  private storeInfo: DataStore;
  private latestHeight: number;
  private latestHash: Buffer;

  constructor(storeInfo: DataStore, latestHeight: number, latestHash: Buffer) {
    this.storeInfo = storeInfo;
    this.latestHeight = latestHeight;
    this.latestHash = latestHash;
  }

  // Serialize the DataStore object and additional fields
  public serialize() {
    return {
      coin: {
        parentCoinInfo: this.storeInfo.coin.parentCoinInfo.toString("hex"),
        puzzleHash: this.storeInfo.coin.puzzleHash.toString("hex"),
        amount: this.storeInfo.coin.amount.toString(),
      },
      launcherId: this.storeInfo.launcherId.toString("hex"),
      proof: {
        lineageProof: this.storeInfo.proof.lineageProof
          ? {
              parentParentCoinInfo: this.storeInfo.proof.lineageProof.parentParentCoinInfo.toString(
                "hex"
              ),
              parentInnerPuzzleHash: this.storeInfo.proof.lineageProof.parentInnerPuzzleHash.toString(
                "hex"
              ),
              parentAmount: this.storeInfo.proof.lineageProof.parentAmount.toString(),
            }
          : undefined,
        eveProof: this.storeInfo.proof.eveProof
          ? {
              parentParentCoinInfo: this.storeInfo.proof.eveProof.parentParentCoinInfo.toString(
                "hex"
              ),
              parentAmount: this.storeInfo.proof.eveProof.parentAmount.toString(),
            }
          : undefined,
      },
      metadata: {
        rootHash: this.storeInfo.metadata.rootHash.toString("hex"),
        label: this.storeInfo.metadata.label,
        description: this.storeInfo.metadata.description,
        bytes: this.storeInfo.metadata.bytes?.toString(),
      },
      ownerPuzzleHash: this.storeInfo.ownerPuzzleHash.toString("hex"),
      delegatedPuzzles: this.storeInfo.delegatedPuzzles.map((puzzle) => ({
        adminInnerPuzzleHash: puzzle.adminInnerPuzzleHash?.toString("hex"),
        writerInnerPuzzleHash: puzzle.writerInnerPuzzleHash?.toString("hex"),
        oraclePaymentPuzzleHash: puzzle.oraclePaymentPuzzleHash?.toString("hex"),
        oracleFee: puzzle.oracleFee?.toString(),
      })),
      latestHeight: this.latestHeight.toString(),
      latestHash: this.latestHash.toString("base64"), // Use base64 for Buffer
    };
  }

  // Deserialize the data back into DataStore and associated fields
  public static deserialize(
    data: {
      latestStore: any;
      latestHeight: string;
      latestHash: string;
    }
  ): {
    latestStore: DataStore;
    latestHeight: number;
    latestHash: Buffer;
  } {
    const coin: Coin = {
      parentCoinInfo: Buffer.from(data.latestStore.coin.parentCoinInfo, "hex"),
      puzzleHash: Buffer.from(data.latestStore.coin.puzzleHash, "hex"),
      amount: BigInt(data.latestStore.coin.amount),
    };

    const proof: Proof = {
      lineageProof: data.latestStore.proof.lineageProof
        ? {
            parentParentCoinInfo: Buffer.from(
              data.latestStore.proof.lineageProof.parentParentCoinInfo,
              "hex"
            ),
            parentInnerPuzzleHash: Buffer.from(
              data.latestStore.proof.lineageProof.parentInnerPuzzleHash,
              "hex"
            ),
            parentAmount: BigInt(data.latestStore.proof.lineageProof.parentAmount),
          }
        : undefined,
      eveProof: data.latestStore.proof.eveProof
        ? {
            parentParentCoinInfo: Buffer.from(
              data.latestStore.proof.eveProof.parentParentCoinInfo,
              "hex"
            ),
            parentAmount: BigInt(data.latestStore.proof.eveProof.parentAmount),
          }
        : undefined,
    };

    const metadata: DataStoreMetadata = {
      rootHash: Buffer.from(data.latestStore.metadata.rootHash, "hex"),
      label: data.latestStore.metadata.label,
      description: data.latestStore.metadata.description,
      bytes: data.latestStore.metadata.bytes
        ? BigInt(data.latestStore.metadata.bytes)
        : undefined,
    };

    const delegatedPuzzles: DelegatedPuzzle[] = data.latestStore.delegatedPuzzles.map(
      (puzzle: any) => ({
        adminInnerPuzzleHash: puzzle.adminInnerPuzzleHash
          ? Buffer.from(puzzle.adminInnerPuzzleHash, "hex")
          : undefined,
        writerInnerPuzzleHash: puzzle.writerInnerPuzzleHash
          ? Buffer.from(puzzle.writerInnerPuzzleHash, "hex")
          : undefined,
        oraclePaymentPuzzleHash: puzzle.oraclePaymentPuzzleHash
          ? Buffer.from(puzzle.oraclePaymentPuzzleHash, "hex")
          : undefined,
        oracleFee: puzzle.oracleFee ? BigInt(puzzle.oracleFee) : undefined,
      })
    );

    const dataStoreInfo: DataStore = {
      coin,
      launcherId: Buffer.from(data.latestStore.launcherId, "hex"),
      proof,
      metadata,
      ownerPuzzleHash: Buffer.from(data.latestStore.ownerPuzzleHash, "hex"),
      delegatedPuzzles,
    };

    return {
      latestStore: dataStoreInfo,
      latestHeight: parseInt(data.latestHeight, 10),
      latestHash: Buffer.from(data.latestHash, "base64"), // Deserialize from base64
    };
  }
}
