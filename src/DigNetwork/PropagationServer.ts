import axios, { AxiosRequestConfig } from "axios";
import cliProgress from "cli-progress";
import FormData from "form-data";
import fs from "fs";
import fsExtra from "fs-extra";
import https from "https";
import os from "os";
import path from "path";
import ProgressStream from "progress-stream";

import { asyncPool } from "../utils/asyncPool";
import { createSpinner } from "nanospinner";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { green, red, blue, yellow, cyan } from "colorette";
import { merkleIntegrityCheck } from "../utils/merkle";
import { PassThrough } from "stream";
import { promptCredentials } from "../utils/credentialsUtils";
import { STORE_PATH } from "../utils/config";
import { Wallet, DataStore } from "../blockchain";

// Helper function to trim long filenames with ellipsis and ensure consistent padding
function formatFilename(filename: string | undefined, maxLength = 30): string {
  if (!filename) {
    return "Unknown File".padEnd(maxLength, " ");
  }

  if (filename.length > maxLength) {
    return `...${filename.slice(-(maxLength - 3))}`.padEnd(maxLength, " ");
  }
  return filename.padEnd(maxLength, " ");
}

export class PropagationServer {
  storeId: string;
  sessionId: string;
  publicKey: string;
  wallet: any;
  ipAddress: string;
  certPath: string;
  keyPath: string;
  username: string | undefined;
  password: string | undefined;

  private static readonly port = 4159; // Static port used for all requests
  private static readonly inactivityTimeout = 5000; // Inactivity timeout in milliseconds (5 seconds)

  constructor(ipAddress: string, storeId: string) {
    this.storeId = storeId;
    this.sessionId = "";
    this.publicKey = "";
    this.ipAddress = ipAddress;

    // Get or create SSL certificates
    const { certPath, keyPath } = getOrCreateSSLCerts();
    this.certPath = certPath;
    this.keyPath = keyPath;
  }

  /**
   * Initialize the Wallet instance.
   */
  async initializeWallet() {
    this.wallet = await Wallet.load("default");
    this.publicKey = (await this.wallet.getPublicSyntheticKey()).toString(
      "hex"
    );
  }

  /**
   * Create an Axios HTTPS Agent with self-signed certificate allowance.
   */
  createHttpsAgent() {
    return new https.Agent({
      cert: fs.readFileSync(this.certPath),
      key: fs.readFileSync(this.keyPath),
      rejectUnauthorized: false,
    });
  }

  /**
   * Adds a custom inactivity timeout for large file transfers.
   */
  addInactivityTimeout(stream: PassThrough, timeoutMs: number) {
    let timeoutId: NodeJS.Timeout | undefined;

    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        stream.destroy(
          new Error(`Inactivity timeout after ${timeoutMs / 1000} seconds`)
        );
      }, timeoutMs);
    };

    // Reset timeout every time data is received
    stream.on("data", resetTimeout);

    // Set the initial timeout
    resetTimeout();

    // Clear the timeout when the stream ends
    stream.on("end", () => clearTimeout(timeoutId));
    stream.on("error", () => clearTimeout(timeoutId)); // Handle errors

    return stream;
  }

  /**
   * Check if the store and optional root hash exist by making a HEAD request.
   */
  async checkStoreExists(
    rootHash?: string
  ): Promise<{ storeExists: boolean; rootHashExists: boolean }> {
    const spinner = createSpinner(
      `Checking if store ${this.storeId} exists...`
    ).start();
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      let url = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}`;
      if (rootHash) {
        url += `?hasRootHash=${rootHash}`;
      }

      const response = await axios.head(url, config);

      // Extract store existence and root hash existence from headers
      const storeExists = response.headers["x-store-exists"] === "true";
      const rootHashExists = response.headers["x-has-root-hash"] === "true";

      if (storeExists) {
        spinner.success({
          text: green(
            `Store ${this.storeId} exists on peer: ${this.ipAddress}`
          ),
        });
      } else {
        spinner.error({
          text: yellow(
            `Store ${this.storeId} does not exist on ${this.ipAddress}. Credentials will be required to push.`
          ),
        });
      }

      return { storeExists, rootHashExists };
    } catch (error: any) {
      spinner.error({ text: red("Error checking if store exists:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Start an upload session by sending a POST request with the rootHash.dat file.
   */
  async startUploadSession(rootHash: string) {
    const spinner = createSpinner(
      `Starting upload session for store ${this.storeId}...`
    ).start();

    try {
      const formData = new FormData();
      const datFilePath = path.join(
        STORE_PATH,
        this.storeId,
        `${rootHash}.dat`
      );

      // Ensure the rootHash.dat file exists
      if (!fs.existsSync(datFilePath)) {
        throw new Error(`File not found: ${datFilePath}`);
      }

      formData.append("file", fs.createReadStream(datFilePath), {
        filename: `${rootHash}.dat`,
      });

      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
        headers: {
          ...formData.getHeaders(),
        },
      };

      // Add Basic Auth if username and password are present
      if (this.username && this.password) {
        config.auth = {
          username: this.username,
          password: this.password,
        };
      }

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}?roothash=${rootHash}`;
      const response = await axios.post(url, formData, config);

      this.sessionId = response.data.sessionId;
      spinner.success({
        text: green(
          `Upload session started for Root Hash: ${cyan(
            rootHash
          )} with session ID ${this.sessionId}`
        ),
      });
    } catch (error: any) {
      spinner.error({ text: red("Error starting upload session:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Request a nonce for a file by sending a HEAD request to the server.
   */
  async getFileNonce(
    filename: string
  ): Promise<{ nonce: string; fileExists: boolean }> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${filename}`;
      const response = await axios.head(url, config);

      // Check for 'x-file-exists' header
      const fileExists = response.headers["x-file-exists"] === "true";

      // If file exists, no need to generate a nonce
      const nonce = response.headers["x-nonce"];

      return { nonce, fileExists };
    } catch (error: any) {
      console.error(
        red(`Error generating nonce for file ${filename}:`),
        error.message
      );
      throw error;
    }
  }

  /**
   * Upload a file to the server by sending a PUT request.
   * Logs progress using a local cli-progress bar.
   */
  async uploadFile(label: string, dataPath: string) {
    const filePath = path.join(STORE_PATH, this.storeId, dataPath);

    const { nonce, fileExists } = await this.getFileNonce(dataPath);

    if (fileExists) {
      console.log(blue(`File ${label} already exists. Skipping upload.`));
      return;
    }

    const wallet = await Wallet.load("default");
    const keyOwnershipSig = await wallet.createKeyOwnershipSignature(nonce);
    const publicKey = await wallet.getPublicSyntheticKey();

    // Get the file size
    const fileSize = fs.statSync(filePath).size;

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue("[{bar}]")} | ${yellow(
            "{filename}"
          )} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(fileSize, 0, {
        filename: formatFilename(label),
      });

      // Create the read stream
      const fileReadStream = fs.createReadStream(filePath);

      // Create a progress stream
      const progressStream = ProgressStream({
        length: fileSize,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      // Add inactivity timeout to the progress stream
      const passThroughStream = this.addInactivityTimeout(
        new PassThrough(),
        PropagationServer.inactivityTimeout
      );

      // Pipe the read stream through the progress stream into the PassThrough stream
      fileReadStream.pipe(progressStream).pipe(passThroughStream);

      // Use form-data to construct the request body
      const formData = new FormData();
      formData.append("file", passThroughStream);

      const headers = {
        ...formData.getHeaders(),
        "x-nonce": nonce,
        "x-public-key": publicKey.toString("hex"),
        "x-key-ownership-sig": keyOwnershipSig,
      };

      const config: AxiosRequestConfig = {
        headers: headers,
        httpsAgent: this.createHttpsAgent(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${dataPath}`;

      // Create a promise that resolves when the progress stream ends
      const progressPromise = new Promise<void>((resolve, reject) => {
        progressStream.on("end", resolve);
        progressStream.on("error", reject);
      });

      // Start the upload request
      const uploadPromise = axios.put(url, formData, config);

      // Wait for both the upload and the progress stream to finish
      await Promise.all([uploadPromise, progressPromise]);
    } catch (error: any) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Commit the upload session by sending a POST request to the server.
   */
  async commitUploadSession() {
    const spinner = createSpinner(
      `Committing upload session for store ${this.storeId}...`
    ).start();

    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
        auth:
          this.username && this.password
            ? {
                username: this.username,
                password: this.password,
              }
            : undefined,
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/commit/${this.storeId}/${this.sessionId}`;
      const response = await axios.post(url, {}, config);

      spinner.success({
        text: green(`Upload session ${this.sessionId} successfully committed.`),
      });

      return response.data;
    } catch (error: any) {
      spinner.error({ text: red("Error committing upload session:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Static function to handle the entire upload process for multiple files based on rootHash.
   */
  static async uploadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(ipAddress, storeId);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const { storeExists, rootHashExists } =
      await propagationServer.checkStoreExists(rootHash);

    // If the store does not exist, prompt for credentials
    if (!storeExists) {
      console.log(
        red(`Store ${storeId} does not exist. Prompting for credentials...`)
      );
      const credentials = await promptCredentials(propagationServer.ipAddress);
      propagationServer.username = credentials.username;
      propagationServer.password = credentials.password;
    }

    if (rootHashExists) {
      console.log(
        blue(
          `Root hash ${rootHash} already exists in the store. Skipping upload.`
        )
      );
      return;
    }

    // Start the upload session
    await propagationServer.startUploadSession(rootHash);

    const dataStore = DataStore.from(storeId);
    const files = await dataStore.getFileSetForRootHash(rootHash);

    // Prepare upload tasks
    const uploadTasks = files.map((file) => ({
      label: file.name,
      dataPath: file.path,
    }));

    // Limit the number of concurrent uploads
    const concurrencyLimit = 10; // Adjust this number as needed

    await asyncPool(concurrencyLimit, uploadTasks, async (task) => {
      await propagationServer.uploadFile(task.label, task.dataPath);
    });

    // Commit the session after all files have been uploaded
    await propagationServer.commitUploadSession();

    console.log(
      green(
        `✔ All files have been uploaded to for Root Hash: ${cyan(rootHash)}.`
      )
    );
  }

  /**
   * Fetch a file from the server by sending a GET request and return its content in memory.
   * Logs progress using a local cli-progress bar.
   */
  async fetchFile(dataPath: string): Promise<Buffer> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;
    const config: AxiosRequestConfig = {
      responseType: "stream",
      httpsAgent: this.createHttpsAgent(),
    };

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      const response = await axios.get(url, config);
      const totalLengthHeader = response.headers["content-length"];
      const totalLength = totalLengthHeader
        ? parseInt(totalLengthHeader, 10)
        : null;

      if (!totalLength) {
        throw new Error("Content-Length header is missing");
      }

      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue("[{bar}]")} | ${yellow(
            "{filename}"
          )} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(totalLength, 0, {
        filename: formatFilename(dataPath),
      });

      let dataBuffers: Buffer[] = [];

      const progressStream = ProgressStream({
        length: totalLength,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      // Add inactivity timeout to the progress stream
      const passThroughStream = this.addInactivityTimeout(
        new PassThrough(),
        PropagationServer.inactivityTimeout
      );

      response.data.pipe(progressStream).pipe(passThroughStream);

      progressStream.on("data", (chunk: Buffer) => {
        dataBuffers.push(chunk);
      });

      // Wait for the progress stream to finish
      await new Promise<void>((resolve, reject) => {
        progressStream.on("end", resolve);
        progressStream.on("error", reject);
      });

      return Buffer.concat(dataBuffers);
    } catch (error) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Get details of a file, including whether it exists and its size.
   */
  async getFileDetails(
    dataPath: string,
    rootHash: string
  ): Promise<{ exists: boolean; size: number }> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/store/${this.storeId}/${rootHash}/${dataPath}`;
      const response = await axios.head(url, config);

      // Check the headers for file existence and size
      const fileExists = response.headers["x-file-exists"] === "true";
      const fileSize = parseInt(response.headers["x-file-size"], 10);

      return {
        exists: fileExists,
        size: fileExists ? fileSize : 0,
      };
    } catch (error: any) {
      console.error(
        red(`✖ Error checking file details for ${dataPath}:`),
        error.message
      );
      throw error;
    }
  }

  /**
   * Download a file from the server by sending a GET request.
   * Logs progress using a local cli-progress bar.
   */
  async downloadFile(
    label: string,
    dataPath: string,
    rootHash: string,
    baseDir: string
  ) {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;
    let downloadPath = path.join(baseDir, dataPath);

    // Ensure that the directory for the file exists
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });

    const config: AxiosRequestConfig = {
      responseType: "stream",
      httpsAgent: this.createHttpsAgent(),
    };

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      const response = await axios.get(url, config);
      const totalLengthHeader = response.headers["content-length"];
      const totalLength = totalLengthHeader
        ? parseInt(totalLengthHeader, 10)
        : null;

      if (!totalLength) {
        throw new Error("Content-Length header is missing");
      }

      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue("[{bar}]")} | ${yellow(
            "{filename}"
          )} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(totalLength, 0, {
        filename: formatFilename(label),
      });

      const fileWriteStream = fs.createWriteStream(downloadPath);

      const progressStream = ProgressStream({
        length: totalLength,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      // Add inactivity timeout to the progress stream
      const passThroughStream = this.addInactivityTimeout(
        new PassThrough(),
        PropagationServer.inactivityTimeout
      );

      response.data
        .pipe(progressStream)
        .pipe(passThroughStream)
        .pipe(fileWriteStream);

      // Wait for both the file write stream and the progress stream to finish
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          fileWriteStream.on("finish", resolve);
          fileWriteStream.on("error", reject);
        }),
        new Promise<void>((resolve, reject) => {
          progressStream.on("end", resolve);
          progressStream.on("error", reject);
        }),
      ]);

      if (dataPath.includes("/data")) {
        const integrity = await merkleIntegrityCheck(
          path.join(baseDir, `${rootHash}.dat`),
          baseDir,
          dataPath,
          rootHash
        );

        if (!integrity) {
          throw new Error(`Integrity check failed for file: ${dataPath}`);
        }

        console.log("integrity check");
      }
    } catch (error) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Static function to handle downloading multiple files from a DataStore based on file paths.
   */
  static async downloadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(ipAddress, storeId);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const { storeExists, rootHashExists } =
      await propagationServer.checkStoreExists(rootHash);
    if (!storeExists || !rootHashExists) {
      throw new Error(`Store ${storeId} does not exist.`);
    }

    // Fetch the rootHash.dat file
    const datFileContent = await propagationServer.fetchFile(`${rootHash}.dat`);
    const root = JSON.parse(datFileContent.toString());

    // Prepare download tasks
    const downloadTasks = [];

    for (const [fileKey, fileData] of Object.entries(root.files)) {
      const dataPath = getFilePathFromSha256(
        root.files[fileKey].sha256,
        "data"
      );
      const label = Buffer.from(fileKey, "hex").toString("utf-8");
      downloadTasks.push({ label, dataPath });
    }

    // Limit the number of concurrent downloads
    const concurrencyLimit = 10; // Adjust this number as needed

    // Create a temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downloadStore-"));

    try {
      // Download files to the temporary directory
      await asyncPool(concurrencyLimit, downloadTasks, async (task) => {
        await propagationServer.downloadFile(
          task.label,
          task.dataPath,
          rootHash,
          tempDir
        );
      });

      // Save the rootHash.dat file to the temporary directory
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      fs.writeFileSync(path.join(tempDir, `${rootHash}.dat`), datFileContent);

      // Integrity check for the downloaded files was done during the download
      // Here we want to make sure we got all the files or we reject the download session
      for (const [fileKey, fileData] of Object.entries(root.files)) {
        const dataPath = getFilePathFromSha256(
          root.files[fileKey].sha256,
          "data"
        );

        if (!fs.existsSync(path.join(tempDir, dataPath))) {
          if (!fs.existsSync(path.join(STORE_PATH, storeId, dataPath))) {
            throw new Error(
              `Missing file: ${Buffer.from(fileKey, "hex")}, aborting session.`
            );
          }
        }
      }

      // After all downloads are complete, copy from temp directory to the main directory
      const destinationDir = path.join(STORE_PATH, storeId);
      fsExtra.copySync(tempDir, destinationDir, {
        overwrite: false, // Prevents overwriting existing files
        errorOnExist: false, // No error if file already exists
      });

      // Generate the manifest file in the main directory
      const dataStore = DataStore.from(storeId);
      await dataStore.cacheStoreCreationHeight();
      await dataStore.generateManifestFile();

      console.log(green(`✔ All files have been downloaded to ${storeId}.`));
    } catch (error) {
      console.log(red("✖ Error downloading files:"), error);
    } finally {
      // Clean up the temporary directory
      fsExtra.removeSync(tempDir);
    }
  }
}
