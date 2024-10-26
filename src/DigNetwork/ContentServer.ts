import fs from "fs";
import http from "http";
import { URL } from "url";
import { Readable } from "stream";
import { formatHost, getOrCreateSSLCerts } from "../utils";
import NodeCache from "node-cache";

const hasRootHashCache = new NodeCache({ stdTTL: 86400 });
const wellKnownCache = new NodeCache({ stdTTL: 86400 });

export class ContentServer {
  private ipAddress: string;
  private storeId: string;
  private static certPath: string;
  private static keyPath: string;
  private static readonly port = 4161;

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
    // Construct the base URL
    let url = `https://${formatHost(this.ipAddress)}:${
      ContentServer.port
    }/chia.${this.storeId}.${rootHash}/${key}`;

    // If a challenge is provided, append it as a query parameter
    if (challengeHex) {
      url += `?challenge=${challengeHex}`;
    }

    return this.fetchWithRetries(url);
  }

  // New method to get only the first chunk of the content
  public async getKeyChunk(key: string, rootHash: string): Promise<Buffer> {
    // Construct the base URL
    let url = `https://${formatHost(this.ipAddress)}:${
      ContentServer.port
    }/chia.${this.storeId}.${rootHash}/${key}`;
    return this.fetchFirstChunk(url);
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

  /**
   * Fetches and caches the .well-known information for the store's IP address.
   *
   * @returns A promise that resolves to the .well-known JSON data.
   */
  public async getWellKnown(): Promise<any> {
    // Construct the cache key based on ipAddress
    const cacheKey = `${this.ipAddress}-wellknown`;

    // Check if the result is already cached
    const cachedResult = wellKnownCache.get<any>(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    // If not cached, proceed to fetch the .well-known information
    const url = `https://${formatHost(this.ipAddress)}:${
      ContentServer.port
    }/.well-known`;

    try {
      const data = await this.fetchJson(url);
      wellKnownCache.set(cacheKey, data);
      return data;
    } catch (error: any) {
      console.error(
        `Error fetching .well-known information for ${this.ipAddress}:`,
        error.message
      );
      throw error; // Propagate the error after logging
    }
  }

  // Method to get the list of known stores
  public async getKnownStores(): Promise<any> {
    const url = `https://${formatHost(this.ipAddress)}:${
      ContentServer.port
    }/.well-known/stores`;
    return this.fetchJson(url);
  }

  // Method to get the index of all stores
  public async getStoresIndex(): Promise<any> {
    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/`;
    return this.fetchJson(url);
  }

  // Method to get the index of keys in a store
  public async getKeysIndex(rootHash?: string): Promise<any> {
    try {
      let udi = `chia.${this.storeId}`;

      if (rootHash) {
        udi += `.${rootHash}`;
      }

      const url = `https://${formatHost(this.ipAddress)}:${
        ContentServer.port
      }/${udi}`;
      return this.fetchJson(url);
    } catch (error: any) {
      if (rootHash) {
        hasRootHashCache.del(`${this.storeId}-${rootHash}`);
      }
      throw error;
    }
  }

  // Method to check if a specific key exists (HEAD request)
  public async headKey(
    key: string,
    rootHash?: string
  ): Promise<{ success: boolean; headers?: http.IncomingHttpHeaders }> {
    try {
      let udi = `chia.${this.storeId}`;

      if (rootHash) {
        udi += `.${rootHash}`;
      }

      const url = `https://${formatHost(this.ipAddress)}:${
        ContentServer.port
      }/${udi}/${key}`;
      return this.head(url);
    } catch (error: any) {
      if (rootHash) {
        hasRootHashCache.del(`${this.storeId}-${rootHash}`);
      }
      throw error;
    }
  }

  // Method to check if a specific store exists (HEAD request)
  public async headStore(options?: { hasRootHash: string }): Promise<{
    success: boolean;
    headers?: http.IncomingHttpHeaders;
  }> {
    try {
      let url = `https://${formatHost(this.ipAddress)}:${
        ContentServer.port
      }/chia.${this.storeId}`;

      if (options?.hasRootHash) {
        url += `?hasRootHash=${options.hasRootHash}`;
      }

      return this.head(url);
    } catch (error: any) {
      if (options?.hasRootHash) {
        hasRootHashCache.del(`${this.storeId}-${options.hasRootHash}`);
      }
      throw error;
    }
  }

  /**
   * Checks if the store has the specified rootHash.
   * Utilizes caching to improve performance.
   *
   * @param rootHash - The root hash to check.
   * @returns A promise that resolves to true if the root hash exists, otherwise false.
   */
  public async hasRootHash(rootHash: string): Promise<boolean> {
    // Construct the cache key using storeId and rootHash
    const cacheKey = `${this.storeId}-${rootHash}`;

    // Check if the result is already cached
    const cachedResult = await hasRootHashCache.get<boolean>(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    // If not cached, perform the headStore request
    const { success, headers } = await this.headStore({
      hasRootHash: rootHash,
    });

    // Determine if the store has the root hash
    const hasHash = success && headers?.["x-has-root-hash"] === "true";

    // Only cache the result if the store has the root hash
    if (hasHash) {
      hasRootHashCache.set(cacheKey, true);
    }

    return hasHash;
  }

  public streamKey(key: string, rootHash?: string): Promise<Readable> {
    let udi = `chia.${this.storeId}`;

    if (rootHash) {
      udi += `.${rootHash}`;
    }

    return new Promise((resolve, reject) => {
      const url = `https://${formatHost(this.ipAddress)}:${
        ContentServer.port
      }/${udi}/${key}`;
      const urlObj = new URL(url);

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || ContentServer.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
      };

      const request = http.request(requestOptions, (response) => {
        if (response.statusCode === 200) {
          resolve(response); // Resolve with the readable stream
        } else if (response.statusCode === 301 || response.statusCode === 302) {
          // Handle redirects
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.streamKey(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          hasRootHashCache.del(`${this.storeId}-${rootHash}`);
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error) => {
        console.error(`GET Request error for ${url}:`, error);
        reject(error);
      });

      request.end();
    });
  }

  // Helper method to perform HEAD requests
  private async head(
    url: string,
    maxRedirects: number = 5
  ): Promise<{ success: boolean; headers?: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      try {
        // Parse the input URL
        const urlObj = new URL(url);

        const requestOptions = {
          hostname: urlObj.hostname,
          port:
            urlObj.port ||
            (urlObj.protocol === "http:" ? 80 : ContentServer.port),
          path: urlObj.pathname + urlObj.search,
          method: "HEAD",
          key: fs.readFileSync(ContentServer.keyPath),
          cert: fs.readFileSync(ContentServer.certPath),
          rejectUnauthorized: false,
        };

        const request = http.request(requestOptions, (response) => {
          const { statusCode, headers } = response;

          // If status code is 2xx, return success
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            resolve({ success: true, headers });
          }
          // Handle 3xx redirection
          else if (
            statusCode &&
            statusCode >= 300 &&
            statusCode < 400 &&
            headers.location
          ) {
            if (maxRedirects > 0) {
              let redirectUrl = headers.location;

              // Check if the redirect URL is relative
              if (!/^https?:\/\//i.test(redirectUrl)) {
                // Resolve the relative URL based on the original URL
                redirectUrl = new URL(redirectUrl, url).toString();
                console.log(`Resolved relative redirect to: ${redirectUrl}`);
              } else {
                console.log(`Redirecting to: ${redirectUrl}`);
              }

              // Recursively follow the redirection
              this.head(redirectUrl, maxRedirects - 1)
                .then(resolve)
                .catch(reject);
            } else {
              reject({ success: false, message: "Too many redirects" });
            }
          } else {
            // For other status codes, consider it a failure
            resolve({ success: false });
          }
        });

        request.on("error", (error) => {
          console.error(`HEAD ${url}:`, error.message);
          reject({ success: false });
        });

        request.end();
      } catch (err) {
        console.error(`Invalid URL: ${url}`, err);
        reject({ success: false, message: "Invalid URL" });
      }
    });
  }

  // Helper method to fetch JSON data from a URL
  private async fetchJson(url: string): Promise<any> {
    const response = await this.fetchWithRetries(url);
    return JSON.parse(response);
  }

  // Helper method to fetch content with retries and redirection handling
  private async fetchWithRetries(url: string): Promise<string> {
    let attempt = 0;
    const maxRetries = 1;
    const initialDelay = 2000; // 2 seconds
    const maxDelay = 10000; // 10 seconds
    const delayMultiplier = 1.5;
    let delay = initialDelay;

    while (attempt < maxRetries) {
      try {
        return await this.fetch(url);
      } catch (error: any) {
        if (attempt < maxRetries - 1) {
          console.warn(
            `Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${
              delay / 1000
            } seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(maxDelay, delay * delayMultiplier);
        } else {
          console.error(`Failed to retrieve data from ${url}. Aborting.`);
          throw new Error(`Failed to retrieve data: ${error.message}`);
        }
      }
      attempt++;
    }
    throw new Error(
      `Failed to retrieve data from ${url} after ${maxRetries} attempts.`
    );
  }

  // Core method to fetch content from a URL with a 5-second inactivity timeout
  private async fetch(url: string, maxRedirects: number = 5): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeoutDuration = 5000; // 5 seconds

      let timeout: NodeJS.Timeout | null = null; // Initialize timeout

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || ContentServer.port,
        path: urlObj.pathname + urlObj.search, // Include query params
        method: "GET",
        key: fs.readFileSync(ContentServer.keyPath),
        cert: fs.readFileSync(ContentServer.certPath),
        rejectUnauthorized: false,
      };

      const request = http.request(requestOptions, (response) => {
        let data = "";

        // Set timeout for inactivity
        timeout = setTimeout(() => {
          console.error(
            `Request timeout: No data received for ${
              timeoutDuration / 1000
            } seconds.`
          );
          request.destroy(); // Use destroy instead of abort
          reject(
            new Error(
              `Request timed out after ${
                timeoutDuration / 1000
              } seconds of inactivity`
            )
          );
        }, timeoutDuration);

        const resetTimeout = () => {
          if (timeout) {
            clearTimeout(timeout);
          }
          timeout = setTimeout(() => {
            console.error(
              `Request timeout: No data received for ${
                timeoutDuration / 1000
              } seconds.`
            );
            request.destroy(); // Use destroy instead of abort
            reject(
              new Error(
                `Request timed out after ${
                  timeoutDuration / 1000
                } seconds of inactivity`
              )
            );
          }, timeoutDuration);
        };

        if (response.statusCode === 200) {
          response.on("data", (chunk) => {
            data += chunk;
            resetTimeout(); // Reset the timeout every time data is received
          });

          response.on("end", () => {
            if (timeout) {
              clearTimeout(timeout);
            }
            resolve(data);
          });
        } else if (
          (response.statusCode === 301 || response.statusCode === 302) &&
          response.headers.location
        ) {
          // Handle redirects
          if (maxRedirects > 0) {
            const redirectUrl = new URL(response.headers.location, url); // Resolve relative URLs based on the original URL
            if (timeout) {
              clearTimeout(timeout);
            }
            this.fetch(redirectUrl.toString(), maxRedirects - 1)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error("Too many redirects"));
          }
        } else {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error: NodeJS.ErrnoException) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        console.error(`GET ${url}:`, error.message);
        reject(error);
      });

      request.end();
    });
  }

  // New core method to fetch only the first chunk without retries
  private async fetchFirstChunk(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeoutDuration = 5000; // 5 seconds

      let timeout: NodeJS.Timeout | null = null;

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || ContentServer.port,
        path: urlObj.pathname + urlObj.search, // Include query params
        method: "GET",
        key: fs.readFileSync(ContentServer.keyPath),
        cert: fs.readFileSync(ContentServer.certPath),
        rejectUnauthorized: false,
      };

      const request = http.request(requestOptions, (response) => {
        // Set timeout for inactivity
        timeout = setTimeout(() => {
          console.error(
            `Request timeout: No data received for ${
              timeoutDuration / 1000
            } seconds.`
          );
          request.destroy(); // Use destroy instead of abort
          reject(
            new Error(
              `Request timed out after ${
                timeoutDuration / 1000
              } seconds of inactivity`
            )
          );
        }, timeoutDuration);

        const resetTimeout = () => {
          if (timeout) {
            clearTimeout(timeout);
          }
          timeout = setTimeout(() => {
            console.error(
              `Request timeout: No data received for ${
                timeoutDuration / 1000
              } seconds.`
            );
            request.destroy(); // Use destroy instead of abort
            reject(
              new Error(
                `Request timed out after ${
                  timeoutDuration / 1000
                } seconds of inactivity`
              )
            );
          }, timeoutDuration);
        };

        if (response.statusCode === 200) {
          response.once("data", (chunk) => {
            if (timeout) {
              clearTimeout(timeout);
            }
            response.destroy(); // Close the connection after receiving the first chunk
            resolve(chunk);
          });

          response.on("end", () => {
            if (timeout) {
              clearTimeout(timeout);
            }
            // In case the response ends before any data is received
            reject(new Error("No data received"));
          });
        } else if (
          (response.statusCode === 301 || response.statusCode === 302) &&
          response.headers.location
        ) {
          // Handle redirects
          const redirectUrl = new URL(
            response.headers.location,
            url
          ).toString(); // Resolve relative URLs
          if (timeout) {
            clearTimeout(timeout);
          }
          this.fetchFirstChunk(redirectUrl).then(resolve).catch(reject);
        } else {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error: NodeJS.ErrnoException) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        console.error(`GET ${url}:`, error.message);
        reject(error);
      });

      request.end();
    });
  }
}
