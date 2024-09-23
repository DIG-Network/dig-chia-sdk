import { Readable } from "stream";
import path from "path";
import crypto from "crypto";
import { ContentServer } from "./ContentServer";
import { PropagationServer } from "./PropagationServer";
import { IncentiveServer } from "./IncentiveServer";
import { DataStore } from "../blockchain";
import { DataIntegrityTree } from "../DataIntegrityTree";
import { DIG_FOLDER_PATH } from "../utils/config";
import fs from "fs";
import {
  sendXch,
  addressToPuzzleHash,
  signCoinSpends,
  getCoinId,
  Output,
} from "@dignetwork/datalayer-driver";
import { FullNodePeer } from "../blockchain";
import { Wallet } from "../blockchain";
import { selectUnspentCoins } from "../blockchain/coins";

export class DigPeer {
  private ipAddress: string;
  private storeId: string;
  private _contentServer: ContentServer;
  private _propagationServer: PropagationServer;
  private _incentiveServer: IncentiveServer;

  constructor(ipAddress: string, storeId: string) {
    this.ipAddress = ipAddress;
    this.storeId = storeId;
    this._contentServer = new ContentServer(ipAddress, storeId);
    this._propagationServer = new PropagationServer(ipAddress, storeId);
    this._incentiveServer = new IncentiveServer(ipAddress);
  }

  // Getter for ContentServer
  public get contentServer(): ContentServer {
    return this._contentServer;
  }

  // Getter for PropagationServer
  public get propagationServer(): PropagationServer {
    return this._propagationServer;
  }

  // Getter for IncentiveServer
  public get incentiveServer(): IncentiveServer {
    return this._incentiveServer;
  }

  public get IpAddress(): string {
    return this.ipAddress;
  }

  public static sendEqualBulkPayments(
    walletName: string,
    addresses: string[],
    totalAmount: bigint,
    memos: Buffer[]
  ): Promise<void> {
    // Use a Set to ensure unique addresses
    const uniqueAddresses = Array.from(new Set(addresses));

    // Convert unique addresses to puzzle hashes
    const puzzleHashes = uniqueAddresses.map((address) =>
      addressToPuzzleHash(address)
    );

    // Calculate amount per puzzle hash
    const amountPerPuzzleHash = totalAmount / BigInt(puzzleHashes.length);

    // Create outputs array
    const outputs: Output[] = puzzleHashes.map((puzzleHash) => ({
      puzzleHash,
      amount: amountPerPuzzleHash,
      memos,
    }));

    // Call the sendBulkPayments function with the generated outputs
    return DigPeer.sendBulkPayments(walletName, outputs);
  }

  public static async sendBulkPayments(
    walletName: string,
    outputs: Output[]
  ): Promise<void> {
    const feePerCondition = BigInt(1000);
    const totalFee = feePerCondition * BigInt(outputs.length);
    const wallet = await Wallet.load(walletName);
    const publicSyntheticKey = await wallet.getPublicSyntheticKey();
    const peer = await FullNodePeer.connect();
    const totalAmount = outputs.reduce(
      (acc, output) => acc + output.amount,
      BigInt(0)
    );
    const coins = await selectUnspentCoins(
      peer,
      totalAmount,
      totalFee,
      [],
      walletName
    );

    const coinSpends = await sendXch(
      publicSyntheticKey,
      coins,
      outputs,
      totalFee
    );

    const sig = signCoinSpends(
      coinSpends,
      [await wallet.getPrivateSyntheticKey()],
      false
    );

    const err = await peer.broadcastSpend(coinSpends, [sig]);

    if (err) {
      throw new Error(err);
    }

    await FullNodePeer.waitForConfirmation(getCoinId(coins[0]));
  }

  public async sendPayment(
    walletName: string,
    amount: bigint,
    memos: Buffer[] = []
  ): Promise<void> {
    const paymentAddress = await this.contentServer.getPaymentAddress();
    const paymentAddressPuzzleHash = addressToPuzzleHash(paymentAddress);
    const output: Output = {
      puzzleHash: paymentAddressPuzzleHash,
      amount,
      memos,
    };

    return DigPeer.sendBulkPayments(walletName, [output]);
  }

  public static createPaymentHint(storeId: Buffer) {
    // Ensure the input is a 32-byte buffer
    if (!Buffer.isBuffer(storeId) || storeId.length !== 32) {
      throw new Error("Invalid input. Must be a 32-byte buffer.");
    }

    // Define the seed
    const seed = "digpayment";

    // Combine the seed and the original buffer
    const combinedBuffer = Buffer.concat([Buffer.from(seed), storeId]);

    // Apply SHA-256 hash to the combined buffer
    const hash = crypto.createHash("sha256");
    hash.update(combinedBuffer);
    const transformedBuffer = hash.digest();

    // Return the 32-byte hash as a hex string
    return transformedBuffer;
  }

  public async syncStore(): Promise<void> {
    const dataStore = DataStore.from(this.storeId);
    const rootHistory = await dataStore.getRootHistory();
    const localRootHistory = rootHistory
      .filter((root) => Boolean(root.synced))
      .reverse();

    console.log(`Syncing store ${this.storeId} with ${this.IpAddress}`);

    for (const item of localRootHistory) {
      await this.pushStoreRoot(this.storeId, item.root_hash);
    }
  }

  public async pushStoreRoot(storeId: string, rootHash: string): Promise<void> {
    await PropagationServer.uploadStore(storeId, rootHash, this.IpAddress);
  }

  public async downloadStoreRoot(rootHash: string): Promise<void> {
    await PropagationServer.downloadStore(this.storeId, rootHash, this.IpAddress);
  }


  public async downloadData(dataPath: string): Promise<void> {
    await this.propagationServer.downloadFile(dataPath);
  }
}
