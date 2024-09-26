import axios, { AxiosRequestConfig } from "axios";
import fs from "fs";
import https from "https";
import { URL } from "url";
import { getOrCreateSSLCerts } from "../utils/ssl";

export class ContentServer {
  private ipAddress: string;
  private storeId: string;
  private static certPath: string;
  private static keyPath: string;
  private static readonly port = 4161;
  private static readonly inactivityTimeout = 5000; // Inactivity timeout in milliseconds (5 seconds)

  constructor(ipAddress: string, storeId: string) {
    this.ipAddress = ipAddress;
    this.storeId = storeId;

    if (!ContentServer.certPath || !ContentServer.keyPath) {
      const { certPath, keyPath } = getOrCreateSSLCerts();
      ContentServer.certPath = certPath;
      ContentServer.keyPath = keyPath;
    }
  }

  // Method to get the content of a specified key from the peer, with optional challenge query
  public async getKey(
    key: string,
    rootHash: string,
    challengeHex?: string
  ): Promise<string> {
    let url = `https://${this.ipAddress}:${ContentServer.port}/chia.${this.storeId}.${rootHash}/${key}`;

    if (challengeHex) {
      url += `?challenge=${challengeHex}`;
    }

    return this.fetch(url);
  }

  // Method to get the payment address from the peer
  public async getPaymentAddress(): Promise<string | null> {
    console.log(`Fetching payment address from peer ${this.ipAddress}...`);
    try {
      const wellKnown = await this.getWellKnown();
      return wellKnown.xch_address;
    } catch (error: any) {
      console.error(
        `Failed to fetch payment address from ${this.ipAddress}: ${error.message}`
      );
      return null;
    }
  }

  // Method to get the .well-known information
  public async getWellKnown(): Promise<any> {
    const url = `https://${this.ipAddress}:${ContentServer.port}/.well-known`;
    return this.fetchJson(url);
  }

  // Method to get the list of known stores
  public async getKnownStores(): Promise<any> {
    const url = `https://${this.ipAddress}:${ContentServer.port}/.well-known/stores`;
    return this.fetchJson(url);
  }

  // Method to get the index of all stores
  public async getStoresIndex(): Promise<any> {
    const url = `https://${this.ipAddress}:${ContentServer.port}/`;
    return this.fetchJson(url);
  }

  // Method to get the index of keys in a store
  public async getKeysIndex(rootHash?: string): Promise<any> {
    let udi = `chia.${this.storeId}`;
    if (rootHash) {
      udi += `.${rootHash}`;
    }
    const url = `https://${this.ipAddress}:${ContentServer.port}/${udi}`;
    return this.fetchJson(url);
  }

  // Method to check if a specific key exists (HEAD request)
  public async headKey(
    key: string,
    rootHash?: string
  ): Promise<{ success: boolean; headers?: any }> {
    let udi = `chia.${this.storeId}`;
    if (rootHash) {
      udi += `.${rootHash}`;
    }
    const url = `https://${this.ipAddress}:${ContentServer.port}/${udi}/${key}`;
    return this.head(url);
  }

  // Method to check if a specific store exists (HEAD request)
  public async headStore(options?: { hasRootHash: string }): Promise<{
    success: boolean;
    headers?: any;
  }> {
    let url = `https://${this.ipAddress}:${ContentServer.port}/chia.${this.storeId}`;
    if (options?.hasRootHash) {
      url += `?hasRootHash=${options.hasRootHash}`;
    }
    return this.head(url);
  }

  public async hasRootHash(rootHash: string): Promise<boolean> {
    const { success, headers } = await this.headStore({
      hasRootHash: rootHash,
    });
    if (success) {
      return headers?.["x-has-root-hash"] === "true";
    }
    return false;
  }

  // Helper method to perform HEAD requests using axios
  private async head(url: string): Promise<{ success: boolean; headers?: any }> {
    try {
      const config = this.getAxiosConfig();
      const response = await axios.head(url, config);
      return {
        success: response.status >= 200 && response.status < 300,
        headers: response.headers,
      };
    } catch (error) {
      return { success: false };
    }
  }

  // Helper method to fetch JSON data from a URL
  private async fetchJson(url: string): Promise<any> {
    const response = await this.fetch(url);
    return JSON.parse(response);
  }

  // Core method to fetch content from a URL with a 5-second inactivity timeout, handling redirects
  private async fetch(url: string): Promise<string> {
    const config = this.getAxiosConfig();

    // Create a cancel token for the inactivity timeout
    const source = axios.CancelToken.source();

    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;

      const resetTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
          source.cancel(
            `Request timed out after ${
              ContentServer.inactivityTimeout / 1000
            } seconds of inactivity`
          );
        }, ContentServer.inactivityTimeout);
      };

      axios
        .get(url, {
          ...config,
          cancelToken: source.token,
          responseType: "stream", // Use stream to track data transfer
          maxRedirects: 5, // Axios follows up to 5 redirects by default
        })
        .then((response) => {
          let data = "";

          response.data.on("data", (chunk: any) => {
            data += chunk;
            resetTimeout(); // Reset the timeout when data is received
          });

          response.data.on("end", () => {
            if (timeout) {
              clearTimeout(timeout); // Clear timeout on stream end
            }
            resolve(data);
          });

          response.data.on("error", (error: any) => {
            if (timeout) {
              clearTimeout(timeout);
            }
            reject(error);
          });
        })
        .catch((error: any) => {
          if (axios.isCancel(error)) {
            console.error("Request canceled:", error.message);
          } else {
            console.error(`Failed to retrieve data from ${url}:`, error.message);
          }
          reject(error);
        });
    });
  }

  // Helper method to configure axios with HTTPS settings
  private getAxiosConfig(): AxiosRequestConfig {
    return {
      httpsAgent: new https.Agent({
        cert: fs.readFileSync(ContentServer.certPath),
        key: fs.readFileSync(ContentServer.keyPath),
        rejectUnauthorized: false,
      }),
      timeout: 0, // Disable axios timeout (we're using inactivity timeout)
    };
  }
}
