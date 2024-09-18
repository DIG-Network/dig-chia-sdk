import {
  selectCoins,
  Peer,
  Coin,
  getCost,
  CoinSpend,
  getCoinId,
} from "@dignetwork/datalayer-driver";
import { Wallet } from "./Wallet";
import { MIN_HEIGHT, MIN_HEIGHT_HEADER_HASH } from "../utils/config";
import { FileCache } from "../utils/FileCache";

export const DEFAULT_FEE_COIN_COST = 64_000_000;

// Set cache expiration time (5 minutes)
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Cache structure for reserved coins
interface ReservedCoinCache {
  expiry: number;
  coin: Coin;
}

export const calculateFeeForCoinSpends = async (
  peer: Peer,
  coinSpends: CoinSpend[] | null
): Promise<bigint> => {
  return BigInt(1000000);
  /*
  if (coinSpends === null) {
    return BigInt(DEFAULT_FEE_COIN_COST) * BigInt(2);
  }

  console.log("Calculating fee for coin spends...");
  let costForCoinSpend = await getCost(coinSpends);

  if (costForCoinSpend < BigInt(5)) {
    costForCoinSpend = BigInt(5);
  }

  console.log(`Cost for coin spends: ${costForCoinSpend}`);
  // Confirm in around 60 seconds
  const mojosPerClvmCost = await peer.getFeeEstimate(BigInt(60));

  console.log(`Mojo per clvm cost: ${mojosPerClvmCost}`);
  // Multiply the total cost by 2 just to be extra safe
  const fee =
    (BigInt(DEFAULT_FEE_COIN_COST) + costForCoinSpend * mojosPerClvmCost) *
    BigInt(2);

  console.log(`Fee for coin spends: ${fee}`);
  
  return fee;
  */
};

export const selectUnspentCoins = async (
  peer: Peer,
  coinAmount: bigint,
  feeBigInt: bigint,
  omitCoins: Coin[] = [],
  walletName: string = "default"
): Promise<Coin[]> => {
  // Initialize the cache for reserved coins
  const cache = new FileCache<{ coinId: string; expiry: number }>("reserved_coins");

  // Get all cached reserved coins
  const cachedReservedCoins = cache.getCachedKeys();

  // Filter expired reserved coins and omit valid reservations
  const now = Date.now();
  const omitCoinIds = omitCoins.map((coin) => getCoinId(coin).toString("hex"));

  const validReservedCoins = cachedReservedCoins.filter((coinId) => {
    const reservation = cache.get(coinId);
    if (reservation && reservation.expiry > now) {
      // Valid reservation, add to omit list
      omitCoinIds.push(coinId);
      return true;
    } else {
      // Reservation expired, remove it
      cache.delete(coinId);
      return false;
    }
  });

  // Fetch all unspent coins from the peer
  const wallet = await Wallet.load(walletName);
  const ownerPuzzleHash = await wallet.getOwnerPuzzleHash();

  const coinsResp = await peer.getAllUnspentCoins(
    ownerPuzzleHash,
    MIN_HEIGHT,
    Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
  );

  if (process.env.DIG_DEBUG === "1") {
    console.log("Unspent Coins:", coinsResp); // Debugging
  }

  const unspentCoins = coinsResp.coins;

  // Filter out the omitted coins
  const filteredUnspentCoins = unspentCoins.filter(
    (coin) => !omitCoinIds.includes(getCoinId(coin).toString("hex"))
  );

  if (process.env.DIG_DEBUG === "1") {
    console.log("Unspent Coins after filtering:", filteredUnspentCoins); // Debugging
  }

  // Select coins needed for the transaction
  const selectedCoins = selectCoins(filteredUnspentCoins, feeBigInt + coinAmount);

  if (process.env.DIG_DEBUG === "1") {
    console.log("Selected Coins:", selectedCoins); // Debugging
  }

  // If no coins are selected, throw an error
  if (selectedCoins.length === 0) {
    throw new Error("No unspent coins available.");
  }

  // Cache the selected coins as reserved for the next 5 minutes
  selectedCoins.forEach((coin) => {
    const coinId = getCoinId(coin).toString("hex");
    cache.set(coinId, { coinId, expiry: Date.now() + CACHE_DURATION });
  });

  return selectedCoins;
};


export const isCoinSpendable = async (
  peer: Peer,
  coinId: Buffer
): Promise<boolean> => {
  try {
    const spent = await peer.isCoinSpent(
      coinId,
      MIN_HEIGHT,
      Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
    );
    return spent;
  } catch (error) {
    return false;
  }
};
