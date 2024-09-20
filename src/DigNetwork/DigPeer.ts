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
import { STORE_PATH } from "../utils/config";
import { promisify } from "util";

const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);

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

    for (const item of rootHistory.filter((root) => root.synced)) {
        await this.pushStoreRoot(this.storeId, item.root_hash);
    }
}


  public async pushStoreRoot(storeId: string, rootHash: string): Promise<void> {
    console.log(`Pushing root hash ${rootHash} to ${this.IpAddress}`);
    const dataStore = DataStore.from(storeId);

    const alreadySynced = await this.contentServer.hasRootHash(rootHash);

    if (alreadySynced) {
      console.log(`Root hash ${rootHash} already synced.`);
      return;
    }

    const tree = await dataStore.Tree.serialize(rootHash);

    // @ts-ignore
    console.log(tree.files);

    // @ts-ignore
    tree.files.forEach(async (file) => {
      await dataStore.Tree.verifyKeyIntegrity(file.sha256, rootHash);
      console.log(`Pushing file ${file.key} to ${this.IpAddress}`);
      const dataPath = path.join(
        "data",
        file.sha256.match(/.{1,2}/g)!.join("/")
      );
      const fileLocation = path.join(STORE_PATH, storeId, dataPath);
      await this.propagationServer.pushFile(fileLocation, dataPath);
    });
  }

  public async downloadData(storeId: string, dataPath: string): Promise<void> {
    const filePath = path.join(STORE_PATH, storeId, dataPath);
    const tempFilePath = `${filePath}.tmp`;

    try {
      const headStoreResponse = await this.propagationServer.headStore();
      if (!headStoreResponse.success) {
        throw new Error("Data not accessible from store.");
      }

      const directory = path.dirname(tempFilePath);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }

      const fileStream = fs.createWriteStream(tempFilePath);
      const dataStream = await this.propagationServer.streamStoreData(dataPath);

      await new Promise<void>((resolve, reject) => {
        dataStream.pipe(fileStream);

        dataStream.on("end", resolve);
        dataStream.on("error", reject);
        fileStream.on("error", reject);
      });

      await rename(tempFilePath, filePath);

      console.log(`Downloaded ${dataPath} from ${this.IpAddress}`);
    } catch (error: any) {
      console.error(`Failed to download data: ${error.message}`);

      if (fs.existsSync(tempFilePath)) {
        await unlink(tempFilePath);
      }

      // Check if directory is empty and remove it if it is
      const directory = path.dirname(tempFilePath);
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
        console.log(`Removed empty directory: ${directory}`);
      }
    }
  }
}
