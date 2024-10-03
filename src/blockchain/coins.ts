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
import { Environment } from "../utils/Environment";

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
