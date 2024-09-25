import * as bip39 from "bip39";
import { PrivateKey } from "chia-bls";
import { mnemonicToSeedSync } from "bip39";
import { NconfManager } from "../utils/NconfManager";
import { askForMnemonicAction, askForMnemonicInput } from "../prompts";
import WalletRpc from "chia-wallet";
// @ts-ignore
import { getChiaRoot } from "chia-root-resolver";
import { getChiaConfig } from "chia-config-loader";
import { encryptData, decryptData, EncryptedData } from "../utils/encryption";
import { Buffer } from "buffer";
import {
  secretKeyToPublicKey,
  masterPublicKeyToWalletSyntheticKey,
  masterSecretKeyToWalletSyntheticSecretKey,
  masterPublicKeyToFirstPuzzleHash,
  puzzleHashToAddress,
  signMessage,
  verifySignedMessage,
  selectCoins,
  Peer,
  Coin,
  getCost,
  CoinSpend,
  getCoinId,
} from "@dignetwork/datalayer-driver";
import { MIN_HEIGHT, MIN_HEIGHT_HEADER_HASH } from "../utils/config";
import { FileCache } from "../utils/FileCache";
import { USER_DIR_PATH } from "../utils/config";
import path from "path";

const KEYRING_FILE = "keyring.json";
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_FEE_COIN_COST = 64_000_000;

interface ReservedCoinCache {
  expiry: number;
  coin: Coin;
}

export class Wallet {
  private mnemonic: string | null = null;
  private walletName: string;

  private constructor(mnemonic: string | null, walletName: string) {
    this.mnemonic = mnemonic;
    this.walletName = walletName;
  }

  public static async load(
    walletName: string = "default",
    createOnUndefined: boolean = true
  ): Promise<Wallet> {
    const mnemonic = await Wallet.getWalletFromKeyring(walletName);
    if (mnemonic) return new Wallet(mnemonic, walletName);

    if (createOnUndefined) {
      const { action } = await askForMnemonicAction();
      let newMnemonic: string;
      if (action === "Provide") {
        newMnemonic = await Wallet.importWallet(walletName);
      } else if (action === "Generate") {
        newMnemonic = await Wallet.createNewWallet(walletName);
      } else if (action === "Import From Chia Client") {
        newMnemonic = await Wallet.importWalletFromChia(walletName);
      } else {
        throw new Error("Mnemonic seed phrase is required.");
      }
      return new Wallet(newMnemonic, walletName);
    }

    throw new Error("Wallet Not Found");
  }

  public getMnemonic(): string {
    if (!this.mnemonic) {
      throw new Error("Mnemonic seed phrase is not loaded.");
    }
    return this.mnemonic;
  }

  public static async createNewWallet(walletName: string): Promise<string> {
    const mnemonic = bip39.generateMnemonic(256);
    await Wallet.saveWalletToKeyring(walletName, mnemonic);
    return mnemonic;
  }

  public static async importWallet(walletName: string, seed?: string): Promise<string> {
    const mnemonic = seed || (await askForMnemonicInput()).providedMnemonic;
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("Provided mnemonic is invalid.");
    }
    await Wallet.saveWalletToKeyring(walletName, mnemonic);
    return mnemonic;
  }

  public static async importWalletFromChia(walletName: string): Promise<string> {
    const chiaRoot = getChiaRoot();
    const certificateFolderPath = `${chiaRoot}/config/ssl`;
    const config = getChiaConfig();
    const defaultWalletPort = config?.wallet?.rpc_port || 9256;

    const walletRpc = new WalletRpc({
      wallet_host: `https://127.0.0.1:${defaultWalletPort}`,
      certificate_folder_path: certificateFolderPath,
    });

    const fingerprintInfo = await walletRpc.getLoggedInFingerprint({});
    if (!fingerprintInfo?.success) {
      throw new Error("Could not get fingerprint");
    }

    const privateKeyInfo = await walletRpc.getPrivateKey({
      fingerprint: fingerprintInfo.fingerprint,
    });

    if (!privateKeyInfo?.success) {
      throw new Error("Could not get private key");
    }

    const mnemonic = privateKeyInfo?.private_key.seed;
    await Wallet.saveWalletToKeyring(walletName, mnemonic);
    return mnemonic;
  }

  public async getMasterSecretKey(): Promise<Buffer> {
    const seed = mnemonicToSeedSync(this.getMnemonic());
    return Buffer.from(PrivateKey.fromSeed(seed).toHex(), "hex");
  }

  public async getPublicSyntheticKey(): Promise<Buffer> {
    const master_sk = await this.getMasterSecretKey();
    const master_pk = secretKeyToPublicKey(master_sk);
    return masterPublicKeyToWalletSyntheticKey(master_pk);
  }

  public async getPrivateSyntheticKey(): Promise<Buffer> {
    const master_sk = await this.getMasterSecretKey();
    return masterSecretKeyToWalletSyntheticSecretKey(master_sk);
  }

  public async getOwnerPuzzleHash(): Promise<Buffer> {
    const master_sk = await this.getMasterSecretKey();
    const master_pk = secretKeyToPublicKey(master_sk);
    return masterPublicKeyToFirstPuzzleHash(master_pk);
  }

  public async getOwnerPublicKey(): Promise<string> {
    const ownerPuzzleHash = await this.getOwnerPuzzleHash();
    return puzzleHashToAddress(ownerPuzzleHash, "xch");
  }

  public static async deleteWallet(walletName: string): Promise<boolean> {
    const nconfManager = new NconfManager(KEYRING_FILE);
    if (await nconfManager.configExists()) {
      await nconfManager.deleteConfigValue(walletName);
      return true;
    }
    return false;
  }

  public static async listWallets(): Promise<string[]> {
    const nconfManager = new NconfManager(KEYRING_FILE);
    if (!(await nconfManager.configExists())) {
      return [];
    }

    const config = nconfManager.getFullConfig();
    return Object.keys(config);
  }

  private static async getWalletFromKeyring(walletName: string): Promise<string | null> {
    const nconfManager = new NconfManager(KEYRING_FILE);
    if (await nconfManager.configExists()) {
      const encryptedData: EncryptedData | null = await nconfManager.getConfigValue(walletName);
      if (encryptedData) {
        return decryptData(encryptedData);
      }
    }
    return null;
  }

  private static async saveWalletToKeyring(walletName: string, mnemonic: string): Promise<void> {
    const nconfManager = new NconfManager(KEYRING_FILE);
    const encryptedData = encryptData(mnemonic);
    await nconfManager.setConfigValue(walletName, encryptedData);
  }

  public async createKeyOwnershipSignature(nonce: string): Promise<string> {
    const message = `Signing this message to prove ownership of key.\n\nNonce: ${nonce}`;
    const privateSyntheticKey = await this.getPrivateSyntheticKey();
    const signature = signMessage(Buffer.from(message, "utf-8"), privateSyntheticKey);
    return signature.toString("hex");
  }

  public static async verifyKeyOwnershipSignature(
    nonce: string,
    signature: string,
    publicKey: string
  ): Promise<boolean> {
    const message = `Signing this message to prove ownership of key.\n\nNonce: ${nonce}`;
    return verifySignedMessage(
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex"),
      Buffer.from(message, "utf-8")
    );
  }

  public async selectUnspentCoins(
    peer: Peer,
    coinAmount: bigint,
    feeBigInt: bigint,
    omitCoins: Coin[] = []
  ): Promise<Coin[]> {
    const cache = new FileCache<{ coinId: string; expiry: number }>(path.join(USER_DIR_PATH, "reserved_coins"));
    const cachedReservedCoins = cache.getCachedKeys();
    const now = Date.now();
    const omitCoinIds = omitCoins.map((coin) => getCoinId(coin).toString("hex"));

    cachedReservedCoins.forEach((coinId) => {
      const reservation = cache.get(coinId);
      if (reservation && reservation.expiry > now) {
        omitCoinIds.push(coinId);
      } else {
        cache.delete(coinId);
      }
    });

    const ownerPuzzleHash = await this.getOwnerPuzzleHash();

    const coinsResp = await peer.getAllUnspentCoins(
      ownerPuzzleHash,
      MIN_HEIGHT,
      Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
    );

    const unspentCoins = coinsResp.coins.filter(
      (coin) => !omitCoinIds.includes(getCoinId(coin).toString("hex"))
    );

    const selectedCoins = selectCoins(unspentCoins, feeBigInt + coinAmount);
    if (selectedCoins.length === 0) {
      throw new Error("No unspent coins available.");
    }

    selectedCoins.forEach((coin) => {
      const coinId = getCoinId(coin).toString("hex");
      cache.set(coinId, { coinId, expiry: Date.now() + CACHE_DURATION });
    });

    return selectedCoins;
  }

  public static async calculateFeeForCoinSpends(peer: Peer, coinSpends: CoinSpend[] | null): Promise<bigint> {
    return BigInt(1000000);
  }

  public static async isCoinSpendable(peer: Peer, coinId: Buffer): Promise<boolean> {
    try {
      return await peer.isCoinSpent(coinId, MIN_HEIGHT, Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex"));
    } catch (error) {
      return false;
    }
  }
}
