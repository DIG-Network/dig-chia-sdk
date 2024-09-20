import { Coin } from "@dignetwork/datalayer-driver";

export interface FileDetails {
  filename: string;
  sha256: string;
  relativePath: string;
}

export interface Config {
  deploy_dir: string;
  remote?: string;
  active_store?: string;
}

export interface CreateStoreUserInputs {
  label?: string;
  description?: string;
  authorizedWriter?: string;
  oracleFee?: number;
}

export interface DigConfig {
  remote?: string;
  deploy_dir: string;
  active_store?: string;
  [key: string]: any;
}

export interface RootHistoryItem {
  root_hash: string;
  timestamp: Number | undefined;
  synced: boolean;
}

export interface DatFile {
  root: string;
  leaves: string[];
  files: {
    [key: string]: {
      hash: string;
      sha256: string;
    };
  };
}

export interface Credentials {
  username: string;
  password: string;
}

export interface CoinData {
  amount: string;
  puzzleHash: string;
  parentCoinInfo: string;
}

export interface ServerCoinData {
  coin: CoinData;
  createdAt: string; // ISO date string
  epoch: number;
}

export interface IncentiveProgramData {
  storeId: string;
  xchRewardPerEpoch: number;
  totalRoundsPerEpoch: number;
  totalRoundsCompleted?: number;
  paymentTotalToDate?: bigint;
  active: boolean;
  lastEpochPaid?: number;
  walletName: string;
  currentCoin?: ServerCoinData;
}

