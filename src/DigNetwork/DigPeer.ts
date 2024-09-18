import { Readable } from "stream";
import crypto from "crypto";
import { ContentServer } from "./ContentServer";
import { PropagationServer } from "./PropagationServer";
import { IncentiveServer } from "./IncentiveServer";
import { DataStore } from "../blockchain";
import { DataIntegrityTree } from "../DataIntegrityTree";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import {
  sendXch,
  addressToPuzzleHash,
  signCoinSpends,
  getCoinId,
} from "datalayer-driver";
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

  public async validateStore(
    rootHash: string,
    keys: string[]
  ): Promise<boolean> {
    console.log(
      `Validating store ${this.storeId} on peer ${this.ipAddress}...`
    );

    try {
      const dataStore = DataStore.from(this.storeId);
      // Fetch the root history from the propagation server
      const rootHistory = await dataStore.getRootHistory();

      if (rootHistory.length === 0) {
        console.error("No root history found for the store.");
        return false;
      }

      // Fetch the manifest.dat file content from the propagation server
      const manifestContent = await this.propagationServer.getStoreData(
        "manifest.dat"
      );
      const manifestHashes: string[] = manifestContent
        .split("\n")
        .filter(Boolean);

      // Ensure all hashes in root history are present in the manifest in the same order
      for (let i = 0; i < rootHistory.length; i++) {
        if (rootHistory[i].root_hash !== manifestHashes[i]) {
          console.error(
            `Hash mismatch at index ${i}: manifest hash ${manifestHashes[i]} does not match root history hash ${rootHistory[i].root_hash}`
          );
          return false;
        }
      }

      console.log("Manifest file validated.");

      // Fetch the .dat file content for the specified root hash from the content server
      const datFileContent = JSON.parse(
        await this.propagationServer.getStoreData(`${rootHash}.dat`)
      );

      if (datFileContent.root !== rootHash) {
        console.error(
          `Root hash in .dat file does not match: ${datFileContent.root} !== ${rootHash}`
        );
        return false;
      }

      let filesIntegrityIntact = true;

      // Validate SHA256 hashes of the specified keys using streamStoreKey
      for (const key of keys) {
        const fileData = datFileContent.files[key];
        if (!fileData) {
          console.error(`File key ${key} not found in .dat file.`);
          filesIntegrityIntact = false;
          continue;
        }

        // Stream the file from the propagation server and calculate the SHA256 hash on the fly
        const hash = crypto.createHash("sha256");
        const fileStream: Readable = await this.contentServer.streamKey(
          Buffer.from(key, "hex").toString("utf-8")
        );

        await new Promise<void>((resolve, reject) => {
          fileStream.on("data", (chunk) => {
            hash.update(chunk); // Update the hash with each chunk of data
          });

          fileStream.on("end", () => {
            const calculatedHash = hash.digest("hex");
            // Compare the calculated hash with the expected hash
            if (calculatedHash !== fileData.sha256) {
              console.error(`File ${key} failed SHA256 validation.`);
              filesIntegrityIntact = false;
            }
            resolve();
          });

          fileStream.on("error", (err) => {
            console.error(`Failed to stream file ${key}: ${err.message}`);
            reject(err);
          });
        });

        // Perform tree integrity validation using the datFileContent and the root hash
        const treeCheck = DataIntegrityTree.validateKeyIntegrityWithForeignTree(
          key,
          fileData.sha256,
          datFileContent,
          rootHash
        );

        if (!treeCheck) {
          console.error(`Tree validation failed for file ${key}.`);
          filesIntegrityIntact = false;
        }
      }

      if (!filesIntegrityIntact) {
        console.error("Store Corrupted: Data failed SHA256 validation.");
        return false;
      }

      console.log("Store validation successful.");
      return true;
    } catch (error: any) {
      console.error(`Failed to validate store: ${error.message}`);
      return false;
    }
  }

  public async isSynced(): Promise<boolean> {
    try {
      // Fetch the root history from the propagation server
      const dataStore = DataStore.from(this.storeId);
      const rootHistory = await dataStore.getRootHistory();

      if (rootHistory.length === 0) {
        console.error("No root history found for the store.");
        return false;
      }

      // Fetch the manifest.dat file content from the content server
      const manifestContent = await this.propagationServer.getStoreData(
        "manifest.dat"
      );
      const manifestHashes: string[] = manifestContent
        .split("\n")
        .filter(Boolean);

      // Compare lengths of root history and manifest
      return rootHistory.length === manifestHashes.length;
    } catch (error: any) {
      console.error(`Failed to check sync status: ${error.message}`);
      return false;
    }
  }

  public static sendEqualBulkPayments(
    walletName: string,
    addresses: string[],
    totalAmount: bigint,
    memo: string[]
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
    const outputs: { puzzleHash: Buffer; amount: bigint }[] = puzzleHashes.map(
      (puzzleHash) => ({
        puzzleHash,
        amount: amountPerPuzzleHash,
        memo,
      })
    );

    // Call the sendBulkPayments function with the generated outputs
    return DigPeer.sendBulkPayments(walletName, outputs);
  }

  public static async sendBulkPayments(
    walletName: string,
    outputs: { puzzleHash: Buffer; amount: bigint }[]
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
    memo: string[] = []
  ): Promise<void> {
    const paymentAddress = await this.contentServer.getPaymentAddress();
    const paymentAddressPuzzleHash = addressToPuzzleHash(paymentAddress);
    const output: { puzzleHash: Buffer; amount: bigint; memo: string[] } = {
      puzzleHash: paymentAddressPuzzleHash,
      amount,
      memo,
    };

    return DigPeer.sendBulkPayments(walletName, [output]);
  }

  public createPaymentHint(storeId: Buffer) {
    // Ensure the input is a 32-byte buffer
    if (!Buffer.isBuffer(storeId) || storeId.length !== 32) {
      throw new Error("Invalid input. Must be a 32-byte buffer.");
    }

    // Define the seed
    const seed = "dig";

    // Combine the seed and the original buffer
    const combinedBuffer = Buffer.concat([Buffer.from(seed), storeId]);

    // Apply SHA-256 hash to the combined buffer
    const hash = crypto.createHash("sha256");
    hash.update(combinedBuffer);
    const transformedBuffer = hash.digest();

    // Return the 32-byte hash as a hex string
    return transformedBuffer.toString("hex");
  }
}
