import _ from "lodash";
import {
  morphLauncherId,
  createServerCoin,
  getCoinId,
  CoinSpend,
  signCoinSpends,
  ServerCoin as ServerCoinDriver,
  Coin,
} from "@dignetwork/datalayer-driver";
import { FullNodePeer } from "./FullNodePeer";
import { Wallet } from "./Wallet";
import { NconfManager } from "../utils/NconfManager";
import { CoinData, ServerCoinData } from "../types";
import { DataStore } from "./DataStore";
import { getPublicHost, Environment } from "../utils";
import NodeCache from "node-cache";

const serverCoinCollateral = 300_000_000;

// Initialize the cache with a TTL of 300 seconds (5 minutes)
const serverCoinPeersCache = new NodeCache({ stdTTL: 300 });

export class ServerCoin {
  private storeId: string;
  public static readonly serverCoinManager = new NconfManager(
    "server_coin.json"
  );

  constructor(storeId: string) {
    this.storeId = storeId;
  }

  // Create a new server coin for the current epoch
  public async createForEpoch(peerIp: string, rootHash: string): Promise<ServerCoinDriver> {
    try {
      const peer = await FullNodePeer.connect();
      const wallet = await Wallet.load("default");
      const publicSyntheticKey = await wallet.getPublicSyntheticKey();
      const serverCoinCreationCoins = await wallet.selectUnspentCoins(
        peer,
        BigInt(serverCoinCollateral),
        BigInt(1000000)
      );

      const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
      const epochBasedHint = morphLauncherId(
        Buffer.from(this.storeId, "hex"),
        BigInt(currentEpoch)
      );

      const newServerCoin = createServerCoin(
        publicSyntheticKey,
        serverCoinCreationCoins,
        epochBasedHint,
        [peerIp, publicSyntheticKey.toString("hex")],
        BigInt(serverCoinCollateral),
        BigInt(1000000)
      );

      const combinedCoinSpends = [...(newServerCoin.coinSpends as CoinSpend[])];

      const sig = signCoinSpends(
        combinedCoinSpends,
        [await wallet.getPrivateSyntheticKey()],
        false
      );

      const err = await peer.broadcastSpend(combinedCoinSpends, [sig]);

      if (err) {
        if (err.includes("no spendable coins")) {
          console.log("No coins available. Will try again in 5 seconds...");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return this.createForEpoch(peerIp, rootHash);
        }
        throw new Error(err);
      }

      // Cache the new server coin in the NconfManager
      await this.saveServerCoinData(
        newServerCoin.serverCoin,
        currentEpoch,
        peerIp,
        rootHash
      );

      return newServerCoin.serverCoin;
    } catch (error: any) {
      throw new Error("Failed to create server coin: " + error.message);
    }
  }

  // Save the server coin data to NconfManager
  public async saveServerCoinData(
    serverCoin: ServerCoinDriver,
    epoch: number,
    peerIp: string,
    rootHash: string,
  ): Promise<void> {
    const newServerCoinData: ServerCoinData = {
      coin: {
        amount: serverCoin.coin.amount.toString(),
        puzzleHash: serverCoin.coin.puzzleHash.toString("hex"),
        parentCoinInfo: serverCoin.coin.parentCoinInfo.toString("hex"),
      },
      createdAt: new Date().toISOString(),
      epoch,
      rootHash,
    };

    const serverCoins = await this.getServerCoinsForStore(peerIp);
    serverCoins.push(newServerCoinData);

    await ServerCoin.serverCoinManager.setConfigValue(
      `${this.storeId}:${peerIp}`,
      serverCoins
    );
  }

  // Melt server coin by epoch
  public async melt(epoch: number, peerIp: string): Promise<void> {
    const peer = await FullNodePeer.connect();
    const wallet = await Wallet.load("default");
    const publicSyntheticKey = await wallet.getPublicSyntheticKey();

    const serverCoins = await this.getServerCoinsForStore(peerIp);
    const serverCoin = serverCoins.find((coin) => coin.epoch === epoch);

    if (!serverCoin) {
      throw new Error(
        `No server coin found for epoch ${epoch} in store ${this.storeId}.`
      );
    }

    const feeCoins = await wallet.selectUnspentCoins(peer, BigInt(0), BigInt(1000000));

    const coin = {
      amount: BigInt(serverCoin.coin.amount),
      puzzleHash: Buffer.from(serverCoin.coin.puzzleHash, "hex"),
      parentCoinInfo: Buffer.from(serverCoin.coin.parentCoinInfo, "hex"),
    };

    const serverCoinId = getCoinId(coin);

    console.log("Melt Coin ID: ", serverCoinId.toString("hex"));

    const spendBundle = await peer.lookupAndSpendServerCoins(
      publicSyntheticKey,
      [coin, ...feeCoins],
      BigInt(1000000),
      false
    );

    const sig = signCoinSpends(
      spendBundle,
      [await wallet.getPrivateSyntheticKey()],
      false
    );

    const err = await peer.broadcastSpend(spendBundle, [sig]);

    if (err) {
      throw new Error(err);
    }

    await FullNodePeer.waitForConfirmation(serverCoinId);

    // Remove the melted coin from the NconfManager
    await this.removeServerCoinData(serverCoin.coin, peerIp);
  }

  // Remove the melted server coin from NconfManager
  private async removeServerCoinData(
    serverCoin: CoinData,
    peerIp: string
  ): Promise<void> {
    let serverCoins = await this.getServerCoinsForStore(peerIp);
    serverCoins = serverCoins.filter(
      (coin) => coin.coin.parentCoinInfo !== serverCoin.parentCoinInfo
    );

    await ServerCoin.serverCoinManager.setConfigValue(
      `${this.storeId}:${peerIp}`,
      serverCoins
    );
  }

  public async getAllEpochPeers(
    epoch: number,
    blacklist: string[] = []
  ): Promise<string[]> {
    const cacheKey = `serverCoinPeers-${this.storeId}-${epoch}`;

    // Check if the result is already cached
    const cachedPeers = await serverCoinPeersCache.get<string[]>(cacheKey);
    if (cachedPeers) {
      console.log('Using cachedPeers')
      return cachedPeers;
    }

    const epochBasedHint = morphLauncherId(
      Buffer.from(this.storeId, "hex"),
      BigInt(epoch)
    );

    console.log('Calling FullNodePeer.connect...');
    const peer = await FullNodePeer.connect();
    const maxClvmCost = BigInt(11_000_000_000);

    const hintedCoinStates = await peer.getHintedCoinStates(
      epochBasedHint,
      false
    );

    const filteredCoinStates = hintedCoinStates.filter(
      (coinState) => coinState.coin.amount >= serverCoinCollateral
    );

    // Use a Set to ensure uniqueness
    const serverCoinPeers = new Set<string>();

    for (const coinState of filteredCoinStates) {
      const serverCoin = await peer.fetchServerCoin(coinState, maxClvmCost);
      const peerUrl = serverCoin.memoUrls[0];
      // The second memo URL is the public key
      // We will utilize this for future features
      const publicKey = serverCoin.memoUrls[1];
      
      if (!blacklist.includes(peerUrl)) {
        serverCoinPeers.add(peerUrl);
      }
    }

    if (Environment.DEBUG) {
      console.log("Server Coin Peers: ", serverCoinPeers);
    }

    const peerList = Array.from(serverCoinPeers);

    // Cache the result
    serverCoinPeersCache.set(cacheKey, peerList);
    return peerList;
  }

  public async getActiveEpochPeers(
    blacklist: string[] = []
  ): Promise<string[]> {
    const { epoch } = ServerCoin.getCurrentEpoch();
    return this.getAllEpochPeers(epoch, blacklist);
  }

  // Sample server coins for the current epoch
  public async sampleCurrentEpoch(
    sampleSize: number = 5,
    blacklist: string[] = []
  ): Promise<string[]> {
    const { epoch } = ServerCoin.getCurrentEpoch();
    return this.sampleServerCoinsByEpoch(epoch, sampleSize, blacklist);
  }

  // Sample server coins by epoch
  public async sampleServerCoinsByEpoch(
    epoch: number,
    sampleSize: number = 5,
    blacklist: string[] = []
  ): Promise<string[]> {
    // We dont want our own IP to be included
    const host = await getPublicHost();
    if (host) {
      blacklist.push(host);
    }

    const serverCoinPeers = await this.getAllEpochPeers(epoch, blacklist);
    if (Environment.DEBUG) {
      console.log("Server Coin Peers: ", serverCoinPeers);
    }
    return _.sampleSize(serverCoinPeers, sampleSize);
  }

  // Get the current epoch based on the current timestamp
  public static getCurrentEpoch(): { epoch: number; round: number } {
    return ServerCoin.calculateEpochAndRound(new Date());
  }

  // Ensure server coin exists for the current epoch
  public async ensureServerCoinExists(peerIp: string): Promise<void> {
    try {
      console.log(`Ensuring server coin exists for store ${this.storeId}...`);
      const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
      const serverCoins = await this.getServerCoinsForStore(peerIp);

      // Check if a server coin already exists for the current epoch
      const existingCoin = serverCoins.find(
        (coin) => coin.epoch === currentEpoch
      );

      const dataStore = DataStore.from(this.storeId);
      const rootHistory = await dataStore.getRootHistory(true);
      const lastRoot = _.last(rootHistory);

      if (!lastRoot) {
        throw new Error('Cant get the last root on chain, something is wrong.');
      }

      if (existingCoin) {
        // nothing to do
        if (lastRoot?.synced && lastRoot?.root_hash === existingCoin.rootHash) {
          return;
        }

        // everything is fine, lets just update the roothash for tracking
        if (lastRoot?.synced && lastRoot?.root_hash !== existingCoin.rootHash) {
          existingCoin.rootHash = lastRoot.root_hash;
          // Update the conf with the modified server coin
          await ServerCoin.serverCoinManager.setConfigValue(
            `${this.storeId}:${peerIp}`,
            serverCoins
          );
          return;
        }

        // If not synced, melt the coin, a new one will be created when synced up
        // this helps prevent penalties for not having a valid peer registered
        await this.melt(currentEpoch, peerIp);
      }

      // Don't create a server coin until you're synced up
      if (!_.last(rootHistory)?.synced) {
        return;
      }

      console.log(
        `No server coin found for epoch ${currentEpoch}. Creating new server coin...`
      );
      const serverCoin = await this.createForEpoch(peerIp, lastRoot?.root_hash);

      const newServerCoinData: ServerCoinData = {
        coin: {
          amount: serverCoin.coin.amount.toString(),
          puzzleHash: serverCoin.coin.puzzleHash.toString("hex"),
          parentCoinInfo: serverCoin.coin.parentCoinInfo.toString("hex"),
        },
        createdAt: new Date().toISOString(),
        epoch: currentEpoch,
        rootHash: _.last(rootHistory)?.root_hash || "",
      };

      await FullNodePeer.waitForConfirmation(serverCoin.coin.parentCoinInfo);

      serverCoins.push(newServerCoinData);

      await ServerCoin.serverCoinManager.setConfigValue(
        `${this.storeId}:${peerIp}`,
        serverCoins
      );

      console.log(
        `Server coin created and saved for store ${this.storeId}. Epoch: ${currentEpoch}`
      );
    } catch (error: any) {
      console.error(`Error ensuring server coin: ${error.message}`);
      throw error;
    }
  }

  // Melt outdated server coins
  public async meltOutdatedEpochs(peerIp: string): Promise<void> {
    try {
      const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
      let serverCoins = await this.getServerCoinsForStore(peerIp);

      // Filter out coins that are not in the current epoch
      const outdatedCoins = serverCoins.filter(
        (coin) => coin.epoch < currentEpoch
      );

      for (const serverCoin of outdatedCoins) {
        await this.melt(serverCoin.epoch, peerIp);

        // Remove the processed coin from the serverCoins array
        serverCoins = serverCoins.filter(
          (coin) => coin.epoch !== serverCoin.epoch
        );

        // Update the nconf file with the updated array
        await ServerCoin.serverCoinManager.setConfigValue(
          `${this.storeId}:${peerIp}`,
          serverCoins
        );
      }
    } catch (error: any) {
      console.error(`Error processing outdated epochs: ${error.message}`);
      throw error;
    }
  }

  // If a store is unsubscribed this will melt all of its untracked coins and recover the locked amount
  public static async meltUntrackedStoreCoins() {
    // Get all the store coins from the server config
    const allServerCoins = await ServerCoin.serverCoinManager.getFullConfig();

    // Get all the store ids from the server config
    const storeIdsWithCoins = Object.keys(allServerCoins);

    // Get all the subscribed stores and map them to their StoreId
    const allSubscribedStores = DataStore.getAllStores();
    const allSubscribedStoreIds = allSubscribedStores.map(
      (store) => store.StoreId
    );

    // Iterate over each store in the server coins
    for (const storeCoin of storeIdsWithCoins) {
      const serverCoin = new ServerCoin(storeCoin);
      // If the store is no longer subscribed
      if (!allSubscribedStoreIds.includes(storeCoin)) {
        // Get all the IPs that have coins for this untracked store
        const ips = Object.keys(allServerCoins[storeCoin]);

        // Iterate over each IP (e.g., "71.121.246.129")
        for (const ip of ips) {
          // Get the array of coins for that IP
          let coins = allServerCoins[storeCoin][ip];

          // Iterate over each coin and melt it
          for (const coinInfo of coins) {
            const { epoch, coin } = coinInfo;

            // Melt the coin
            await serverCoin.melt(epoch, ip);

            // Remove the melted coin from the array
            coins = coins.filter((c: Coin) => c !== coinInfo);

            // Update the config to reflect the remaining coins for this IP
            await ServerCoin.serverCoinManager.setConfigValue(
              `${storeCoin}:${ip}`,
              coins
            );
          }

          // If no coins are left for this IP, optionally remove the entire IP entry
          if (coins.length === 0) {
            delete allServerCoins[storeCoin][ip];
            await ServerCoin.serverCoinManager.setConfigValue(
              `${storeCoin}:${ip}`,
              undefined
            );
          }
        }

        // If no IPs are left for this store, optionally remove the store entry
        if (Object.keys(allServerCoins[storeCoin]).length === 0) {
          delete allServerCoins[storeCoin];
          await ServerCoin.serverCoinManager.setConfigValue(
            storeCoin,
            undefined
          );
        }
      }
    }
  }

  // Retrieve server coins from the store
  private async getServerCoinsForStore(
    peerIp: string
  ): Promise<ServerCoinData[]> {
    const serverCoins: ServerCoinData[] =
      (await ServerCoin.serverCoinManager.getConfigValue<ServerCoinData[]>(
        `${this.storeId}:${peerIp}`
      )) || [];
    return serverCoins;
  }

  // Check if the server coin has been created for the current epoch
  public async hasEpochCoinBeenCreated(
    currentEpoch: number,
    peerIp: string
  ): Promise<boolean> {
    try {
      const serverCoins = await this.getServerCoinsForStore(peerIp);
      const existingCoin = serverCoins.find(
        (coin) => coin.epoch === currentEpoch
      );

      if (!existingCoin) {
        console.log(`No server coin found for epoch ${currentEpoch}.`);
        return false;
      }

      console.log(`Server coin found for epoch ${currentEpoch}.`);
      return true;
    } catch (error: any) {
      console.error(
        `Error checking for existing server coin: ${error.message}`
      );
      return false;
    }
  }

  // Static method to calculate the current epoch
  public static calculateEpochAndRound(currentTimestampUTC: Date): {
    epoch: number;
    round: number;
  } {
    const firstEpochStart = new Date(Date.UTC(2024, 8, 3, 0, 0)); // Sept 3, 2024, 00:00 UTC

    // Convert the current timestamp to milliseconds
    const currentTimestampMillis = currentTimestampUTC.getTime();

    // Calculate the number of milliseconds in one epoch (7 days)
    const millisecondsInEpoch = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

    // Calculate the difference in milliseconds between the current timestamp and the first epoch start
    const differenceMillis = currentTimestampMillis - firstEpochStart.getTime();

    // Calculate the current epoch number
    const epochNumber = Math.floor(differenceMillis / millisecondsInEpoch) + 1;

    // Calculate the milliseconds elapsed since the start of the current epoch
    const elapsedMillisInCurrentEpoch = differenceMillis % millisecondsInEpoch;

    // Calculate the number of milliseconds in a round (10 minutes)
    const millisecondsInRound = 10 * 60 * 1000; // 10 minutes in milliseconds

    // Calculate the current round number
    const roundNumber =
      Math.floor(elapsedMillisInCurrentEpoch / millisecondsInRound) + 1;

    return { epoch: epochNumber, round: roundNumber };
  }
}
