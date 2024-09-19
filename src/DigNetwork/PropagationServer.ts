import fs from "fs";
import https from "https";
import http from 'http';
import { URL } from "url";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { promptCredentials } from "../utils/credentialsUtils";
import { Wallet } from "../blockchain";
import { Readable } from "stream";

export class PropagationServer {
  private ipAddress: string;
  private storeId: string;
  private static certPath: string;
  private static keyPath: string;
  private static readonly port = 4159;
  private static readonly maxRetries = 5;
  private static readonly initialDelay = 2000; // 2 seconds
  private static readonly maxDelay = 10000; // 10 seconds
  private static readonly delayMultiplier = 1.5;

  constructor(ipAddress: string, storeId: string) {
    this.ipAddress = ipAddress;
    this.storeId = storeId;

    if (!PropagationServer.certPath || !PropagationServer.keyPath) {
      const { certPath, keyPath } = getOrCreateSSLCerts();
      PropagationServer.certPath = certPath;
      PropagationServer.keyPath = keyPath;
    }
  }

  // Method to upload a file to the propagation server
  public async pushFile(filePath: string, relativePath: string): Promise<void> {
    const { nonce, username, password } = await this.getUploadDetails();
    const wallet = await Wallet.load("default");
    const keyOwnershipSig = await wallet.createKeyOwnershipSignature(nonce);
    const publicKey = await wallet.getPublicSyntheticKey();

    const uploadUrl = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}/${relativePath}`;
    await this.retryOperation(
      () =>
        this.uploadFileDirect(
          filePath,
          uploadUrl,
          username,
          password,
          keyOwnershipSig,
          publicKey.toString("hex"),
          nonce
        ),
      `Upload failed for ${relativePath}`
    );
  }

  // Method to subscribe to a store on the propagation server
  public async subscribeToStore(): Promise<void> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/subscribe`;
    const data = JSON.stringify({ storeId: this.storeId });

    await this.postRequest(url, data);
  }

  // Method to unsubscribe from a store on the propagation server
  public async unsubscribeFromStore(): Promise<void> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/unsubscribe`;
    const data = JSON.stringify({ storeId: this.storeId });

    await this.postRequest(url, data);
  }

  // Method to check the status of a store on the propagation server
  public async getStoreStatus(): Promise<any> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/status/${this.storeId}`;
    return this.fetchJson(url);
  }

  public async streamStoreData(dataPath: string): Promise<Readable> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}/${dataPath}`;
    return this.createReadStreamWithRetries(url);
  }

  // Method to retrieve a store's key
  public async getStoreData(dataPath: string): Promise<string> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}/${dataPath}`;
    return this.fetch(url);
  }

  public async getStatus(): Promise<{ synced: boolean }> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/status/${this.storeId}`;
    const statusJson = await this.fetch(url);
    return JSON.parse(statusJson);
  }

  // Method to check if a specific store exists (HEAD request)
  public async headStore(options?: { hasRootHash: string }): Promise<{ success: boolean; headers?: http.IncomingHttpHeaders }> {
    let url = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}`;

    if (options?.hasRootHash) {
      url += `?hasRootHash=${options.hasRootHash}`;
    }

    return this.head(url);
  }

  // In PropagationServer.ts:
  public async isStoreSynced(): Promise<boolean> {
    const status = await this.getStatus();
    return status.synced === true;
  }

  // Method to handle upload details including nonce
  public async getUploadDetails(): Promise<{
    nonce: string;
    lastUploadedHash: string;
    generationIndex: number;
    username: string;
    password: string;
  }> {
    let username: string | undefined;
    let password: string | undefined;

    if (!username || !password) {
      const credentials = await promptCredentials(this.ipAddress);
      username = credentials.username;
      password = credentials.password;
    }

    const uploadDetails = await this.fetchUploadDetails(username, password);
    if (!uploadDetails) {
      throw new Error("Failed to retrieve upload details.");
    }

    return { ...uploadDetails, username, password };
  }

  // Method to send a POST request
  private async postRequest(url: string, data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || PropagationServer.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        key: fs.readFileSync(PropagationServer.keyPath),
        cert: fs.readFileSync(PropagationServer.certPath),
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(
            new Error(
              `POST request failed with status ${res.statusCode}: ${res.statusMessage}`
            )
          );
        }
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.write(data);
      req.end();
    });
  }

  // Method to fetch upload details from the server
  // Method to fetch upload details from the server
  private async fetchUploadDetails(
    username: string,
    password: string
  ): Promise<
    { nonce: string; lastUploadedHash: string; generationIndex: number } | false
  > {
    const remote = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}`;

    return new Promise<
      | { nonce: string; lastUploadedHash: string; generationIndex: number }
      | false
    >((resolve, reject) => {
      const url = new URL(remote);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "HEAD",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${username}:${password}`
          ).toString("base64")}`,
        },
        key: fs.readFileSync(PropagationServer.keyPath),
        cert: fs.readFileSync(PropagationServer.certPath),
        rejectUnauthorized: false, // Allow self-signed certificates
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          // Check if the headers are present and valid
          const nonce = res.headers["x-nonce"];
          const lastUploadedHash =
            res.headers?.["x-last-uploaded-hash"] ||
            "0000000000000000000000000000000000000000000000000000000000000000";
          const generationIndex = res.headers?.["x-generation-index"] || 0;

          console.log({ nonce, lastUploadedHash, generationIndex });

          if (nonce) {
            resolve({
              nonce: nonce as string,
              lastUploadedHash: lastUploadedHash as string,
              generationIndex: Number(generationIndex),
            });
          } else {
            reject(new Error("Missing required headers in the response."));
          }
        } else {
          reject(
            new Error(
              `Failed to perform preflight check: ${res.statusCode} ${res.statusMessage}`
            )
          );
        }
      });

      req.on("error", (err) => {
        console.error(err.message);
        resolve(false); // Resolve to false if there is an error
      });

      req.end();
    });
  }

  // Core method to upload a file directly to the server using a stream
  private async uploadFileDirect(
    filePath: string,
    uploadUrl: string,
    username: string,
    password: string,
    keyOwnershipSig: string,
    publicKey: string,
    nonce: string
  ): Promise<void> {
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;

    return new Promise<void>((resolve, reject) => {
      const url = new URL(uploadUrl);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": fileSize,
          Authorization: `Basic ${Buffer.from(
            `${username}:${password}`
          ).toString("base64")}`,
          "x-key-ownership-sig": keyOwnershipSig,
          "x-public-key": publicKey,
          "x-nonce": nonce,
        },
        key: fs.readFileSync(PropagationServer.keyPath),
        cert: fs.readFileSync(PropagationServer.certPath),
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(
            new Error(
              `Upload failed with status ${res.statusCode}: ${res.statusMessage}`
            )
          );
        }
      });

      req.on("error", (err) => {
        reject(err);
      });

      fileStream.pipe(req);

      fileStream.on("error", (err) => {
        reject(err);
      });

      req.on("end", () => {
        resolve();
      });
    });
  }

  // Generic retry operation handler to reduce redundancy
  private async retryOperation<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    let attempt = 0;
    let delay = PropagationServer.initialDelay;

    while (attempt < PropagationServer.maxRetries) {
      try {
        return await operation();
      } catch (error: any) {
        if (attempt < PropagationServer.maxRetries - 1) {
          console.warn(
            `Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${
              delay / 1000
            } seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(
            PropagationServer.maxDelay,
            delay * PropagationServer.delayMultiplier
          );
        } else {
          console.error(`${errorMessage}. Aborting.`);
          throw error;
        }
      }
      attempt++;
    }
    throw new Error(errorMessage);
  }

  // Core method to fetch content from a URL
  private async fetch(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        key: fs.readFileSync(PropagationServer.keyPath),
        cert: fs.readFileSync(PropagationServer.certPath),
        rejectUnauthorized: false,
      };

      const request = https.request(options, (response) => {
        let data = "";

        if (response.statusCode === 200) {
          response.on("data", (chunk) => {
            data += chunk;
          });

          response.on("end", () => {
            resolve(data);
          });
        } else if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.fetch(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error) => {
        console.error(`Request error for ${url}:`, error);
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
          port: urlObj.port || (urlObj.protocol === "https:" ? 443 : undefined),
          path: urlObj.pathname + urlObj.search,
          method: "HEAD",
          key: fs.readFileSync(PropagationServer.keyPath),
          cert: fs.readFileSync(PropagationServer.certPath),
          rejectUnauthorized: false,
        };
  
        const request = https.request(requestOptions, (response) => {
          const { statusCode, headers } = response;
  
          // If status code is 2xx, return success
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            resolve({ success: true, headers });
          }
          // Handle 3xx redirection
          else if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
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
          console.error(`Request error for ${url}:`, error);
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
    const response = await this.fetch(url);
    return JSON.parse(response);
  }

  // Helper method to fetch content with retries and redirection handling
  /*private async fetchWithRetries(url: string): Promise<string> {
    let attempt = 0;
    const maxRetries = 5;
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
  }*/

  // Helper method to create a stream with retry logic
  private async createReadStreamWithRetries(url: string): Promise<Readable> {
    let attempt = 0;
    const maxRetries = 1;
    const initialDelay = PropagationServer.initialDelay;
    const maxDelay = PropagationServer.maxDelay;
    const delayMultiplier = PropagationServer.delayMultiplier;
    let delay = initialDelay;

    while (attempt < maxRetries) {
      try {
        return await this.createReadStream(url); // Stream data chunk by chunk
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
          console.error(`Failed to create stream from ${url}. Aborting.`);
          throw new Error(`Failed to create stream: ${error.message}`);
        }
      }
      attempt++;
    }
    throw new Error(
      `Failed to create stream from ${url} after ${maxRetries} attempts.`
    );
  }

  // Helper method to fetch a readable stream from a URL
  private async createReadStream(url: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || PropagationServer.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        key: fs.readFileSync(PropagationServer.keyPath),
        cert: fs.readFileSync(PropagationServer.certPath),
        rejectUnauthorized: false,
      };

      const request = https.request(options, (response) => {
        if (response.statusCode === 200) {
          resolve(response); // Return the response stream chunk by chunk
        } else if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.createReadStream(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          reject(
            new Error(
              `Failed to retrieve stream from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error) => {
        console.error(`Request error for ${url}:`, error);
        reject(error);
      });

      request.end();
    });
  }
}
