import fs from "fs";
import https from "https";
import { URL } from "url";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { Readable } from "stream";

export class FileTransfer {
  private static certPath: string;
  private static keyPath: string;

  constructor() {
    if (!FileTransfer.certPath || !FileTransfer.keyPath) {
      const { certPath, keyPath } = getOrCreateSSLCerts();
      FileTransfer.certPath = certPath;
      FileTransfer.keyPath = keyPath;
    }
  }

  /** ------------------------ UPLOAD FUNCTIONALITY ------------------------ **/

  /**
   * Upload a file to the server using a stream.
   * @param filePath - Local path of the file.
   * @param uploadUrl - Server URL to upload the file.
   * @param headers - Additional headers for the request.
   * @returns Promise<void>
   */
  public async uploadFile(
    filePath: string,
    uploadUrl: string,
    headers: Record<string, string>
  ): Promise<void> {
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;

    return new Promise<void>((resolve, reject) => {
      const url = new URL(uploadUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "Content-Length": fileSize,
        },
        key: fs.readFileSync(FileTransfer.keyPath),
        cert: fs.readFileSync(FileTransfer.certPath),
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

      req.on("error", (err) => reject(err));

      fileStream.pipe(req);

      fileStream.on("error", (err) => reject(err));
    });
  }

  /**
   * Perform a POST request.
   * @param url - The URL to POST to.
   * @param data - Data to send.
   * @param headers - Headers for the POST request.
   * @returns Promise<void>
   */
  public async postRequest(
    url: string,
    data: string,
    headers: Record<string, string>
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        key: fs.readFileSync(FileTransfer.keyPath),
        cert: fs.readFileSync(FileTransfer.certPath),
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

      req.on("error", (err) => reject(err));

      req.write(data);
      req.end();
    });
  }

  /** ------------------------ DOWNLOAD FUNCTIONALITY ------------------------ **/

  /**
   * Download data from a URL.
   * @param url - The URL to download data from.
   * @returns Promise<string>
   */
  public async downloadData(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        key: fs.readFileSync(FileTransfer.keyPath),
        cert: fs.readFileSync(FileTransfer.certPath),
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        let data = "";

        if (res.statusCode === 200) {
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        } else if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.downloadData(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${res.statusCode}`
            )
          );
        }
      });

      req.on("error", (error) => reject(error));

      req.end();
    });
  }

  /**
   * Stream data from a URL.
   * @param url - The URL to stream data from.
   * @returns Promise<Readable>
   */
  public async streamData(url: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        key: fs.readFileSync(FileTransfer.keyPath),
        cert: fs.readFileSync(FileTransfer.certPath),
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve(res); // Return the readable stream
        } else if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.streamData(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          reject(
            new Error(
              `Failed to retrieve stream from ${url}. Status code: ${res.statusCode}`
            )
          );
        }
      });

      req.on("error", (error) => reject(error));

      req.end();
    });
  }

  /** ------------------------ HEAD REQUEST FUNCTIONALITY ------------------------ **/

  /**
   * Perform a HEAD request to check if a resource exists on the server.
   * @param url - The URL to check.
   * @returns Promise<{ success: boolean; headers?: Record<string, string> }>
   */
  public async headRequest(
    url: string
  ): Promise<{ success: boolean; headers?: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: "HEAD",
        key: fs.readFileSync(FileTransfer.keyPath),
        cert: fs.readFileSync(FileTransfer.certPath),
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve({
            success: true,
            headers: res.headers as Record<string, string>,
          });
        } else {
          resolve({ success: false });
        }
      });

      req.on("error", (err) => reject(err));

      req.end();
    });
  }
}
