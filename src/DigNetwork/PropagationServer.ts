import axios, { AxiosRequestConfig } from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import { Wallet, DataStore } from "../blockchain";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { promptCredentials } from "../utils/credentialsUtils";
import https from "https";
import cliProgress from "cli-progress";
import { green, red, cyan, yellow, blue } from "colorette"; // For colored output
import { STORE_PATH } from "../utils/config";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { createSpinner } from "nanospinner";

export class PropagationServer {
  storeId: string;
  sessionId: string;
  publicKey: string;
  wallet: any;
  ipAddress: string;
  certPath: string;
  keyPath: string;
  username: string | undefined; // To store username if needed for credentials
  password: string | undefined; // To store password if needed for credentials

  private static readonly port = 4159; // Static port used for all requests

  // MultiBar for handling multiple progress bars
  private static multiBar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format:
        green(" {bar} ") +
        cyan(" | {filename} | {percentage}% | {value}/{total} bytes"),
      barsize: 40,
      stopOnComplete: true,
      align: "center",
    },
    cliProgress.Presets.shades_classic
  );

  constructor(storeId: string, ipAddress: string) {
    this.storeId = storeId;
    this.sessionId = ""; // Session ID will be set after starting the upload session
    this.publicKey = ""; // Public key will be set after initializing the wallet
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
    this.publicKey = await this.wallet.getPrivateSyntheticKey();
  }

  /**
   * Create an Axios HTTPS Agent with self-signed certificate allowance.
   */
  createHttpsAgent() {
    return new https.Agent({
      cert: fs.readFileSync(this.certPath),
      key: fs.readFileSync(this.keyPath),
      rejectUnauthorized: false, // Allow self-signed certificates
    });
  }

  /**
   * Check if the store and optional root hash exist by making a HEAD request.
   *
   * @param {string} [rootHash] - Optional root hash to check for existence.
   * @returns {Promise<{ storeExists: boolean, rootHashExists: boolean }>} - An object indicating if the store and root hash exist.
   */
  async checkStoreExists(
    rootHash?: string
  ): Promise<{ storeExists: boolean; rootHashExists: boolean }> {
    const spinner = createSpinner(`Checking if store ${this.storeId} exists...`).start();
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      let url = `https://${this.ipAddress}:${PropagationServer.port}/stores/${this.storeId}`;
      if (rootHash) {
        url += `?hasRootHash=${rootHash}`;
      }

      const response = await axios.head(url, config);

      // Extract store existence and root hash existence from headers
      const storeExists = response.headers["x-store-exists"] === "true";
      const rootHashExists = response.headers["x-has-root-hash"] === "true";

      if (storeExists) {
        spinner.success({ text: green(`Store ${this.storeId} exists!`) });
      } else {
        spinner.error({ text: red(`Store ${this.storeId} does not exist.`) });
      }

      if (rootHash) {
        if (rootHashExists) {
          console.log(
            green(`Root hash ${rootHash} exists in the store.`)
          );
        } else {
          console.log(
            red(`Root hash ${rootHash} does not exist in the store.`)
          );
        }
      }

      return { storeExists, rootHashExists };
    } catch (error: any) {
      spinner.error({ text: red("Error checking if store exists:") });
      console.error(red(error));
      throw error;
    }
  }

  /**
   * Start an upload session by sending a POST request to the server.
   */
  async startUploadSession() {
    const spinner = createSpinner(
      `Starting upload session for store ${this.storeId}...`
    ).start();
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      // Add Basic Auth headers if credentials are provided
      if (this.username && this.password) {
        config.auth = {
          username: this.username,
          password: this.password,
        };
      }

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}`;
      const response = await axios.post(
        url,
        { publicKey: this.publicKey },
        config
      );

      this.sessionId = response.data.sessionId;
      spinner.success({
        text: green(
          `Upload session started for DataStore ${this.storeId} with session ID ${this.sessionId}`
        ),
      });
    } catch (error: any) {
      spinner.error({ text: red("Error starting upload session:") });
      console.error(red(error));
      throw error;
    }
  }

  /**
   * Request a nonce for a file by sending a HEAD request to the server.
   */
  async getFileNonce(filename: string): Promise<string> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${filename}`;
      const response = await axios.head(url, config);
      const nonce = response.headers["x-nonce"];
      console.log(blue(`Nonce received for file ${filename}: ${nonce}`));
      return nonce;
    } catch (error) {
      console.error(
        red(`Error generating nonce for file ${filename}:`),
        error
      );
      throw error;
    }
  }

  /**
   * Upload a file to the server by sending a PUT request.
   * Logs progress using cli-progress for each file.
   */
  async uploadFile(filePath: string) {
    const filename = path.basename(filePath);
    const nonce = await this.getFileNonce(filename);
    const keyOwnershipSig = await this.wallet.createKeyOwnershipSignature(
      nonce
    );

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));

    const fileSize = fs.statSync(filePath).size;

    // Create a new progress bar for each file
    const progressBar = PropagationServer.multiBar.create(fileSize, 0, {
      filename: yellow(filename),
      percentage: 0,
    });

    let uploadedBytes = 0;

    const config: AxiosRequestConfig = {
      headers: {
        "Content-Type": "multipart/form-data",
        "x-nonce": nonce,
        "x-public-key": this.publicKey,
        "x-key-ownership-sig": keyOwnershipSig,
        ...formData.getHeaders(),
      },
      httpsAgent: this.createHttpsAgent(),

      // Tracking upload progress and updating the progress bar
      onUploadProgress: (progressEvent: any) => {
        uploadedBytes += progressEvent.loaded;
        const percentage = Math.round((uploadedBytes / fileSize) * 100);
        progressBar.update(uploadedBytes, { percentage });
      },
    };

    try {
      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${filename}`;
      const response = await axios.put(url, formData, config);
      console.log(green(`✔ File ${filename} uploaded successfully.`));

      // Complete the progress bar
      progressBar.update(fileSize, { percentage: 100 });
      progressBar.stop();

      return response.data;
    } catch (error) {
      console.error(red(`✖ Error uploading file ${filename}:`), error);
      progressBar.stop(); // Stop the progress bar in case of error
      throw error;
    }
  }

  /**
   * Static function to handle the entire upload process for multiple files based on rootHash.
   * @param {string} storeId - The ID of the DataStore.
   * @param {string} rootHash - The root hash used to derive the file set.
   * @param {string} publicKey - The public key of the user.
   * @param {string} ipAddress - The IP address of the server.
   */
  static async uploadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(storeId, ipAddress);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const storeExists = await propagationServer.checkStoreExists();

    // If the store does not exist, prompt for credentials
    if (!storeExists) {
      console.log(
        red(
          `Store ${storeId} does not exist. Prompting for credentials...`
        )
      );
      const credentials = await promptCredentials(propagationServer.ipAddress);
      propagationServer.username = credentials.username;
      propagationServer.password = credentials.password;
    }

    // Start the upload session
    await propagationServer.startUploadSession();

    const dataStore = DataStore.from(storeId);
    const filePaths = await dataStore.getFileSetForRootHash(rootHash);

    // Upload each file
    for (const filePath of filePaths) {
      await propagationServer.uploadFile(filePath);
    }

    // Stop all progress bars after the files are uploaded
    PropagationServer.multiBar.stop();

    console.log(
      green(`✔ All files have been uploaded to DataStore ${storeId}.`)
    );
  }

  /**
   * Fetch a file from the server by sending a GET request and return its content in memory.
   * Logs progress using cli-progress.
   * @param {string} dataPath - The data path of the file to download.
   * @returns {Promise<Buffer>} - The file content in memory as a Buffer.
   */
  async fetchFile(dataPath: string): Promise<Buffer> {
    const config: AxiosRequestConfig = {
      responseType: "arraybuffer", // To store the file content in memory
      httpsAgent: this.createHttpsAgent(),
    };

    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;

    try {
      const response = await axios.get(url, config);
      const totalLength = parseInt(response.headers["content-length"], 10);

      console.log(cyan(`Starting fetch for ${dataPath}...`));

      // Create a progress bar for the download
      const progressBar = PropagationServer.multiBar.create(totalLength, 0, {
        dataPath: yellow(dataPath),
        percentage: 0,
      });

      let downloadedBytes = 0;

      // Track progress of downloading the file
      response.data.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        progressBar.update(downloadedBytes, {
          percentage: Math.round((downloadedBytes / totalLength) * 100),
        });
      });

      // Complete the progress bar once done
      progressBar.update(totalLength, { percentage: 100 });
      progressBar.stop();

      console.log(green(`✔ File ${dataPath} fetched successfully.`));

      // Return the file contents as a Buffer
      return Buffer.from(response.data);
    } catch (error) {
      console.error(red(`✖ Error fetching file ${dataPath}:`), error);
      throw error;
    }
  }

  /**
   * Download a file from the server by sending a GET request.
   * Logs progress using cli-progress.
   * @param {string} dataPath - The data path of the file to download.
   */
  async downloadFile(dataPath: string) {
    const config: AxiosRequestConfig = {
      responseType: "stream", // Make sure the response is streamed
      httpsAgent: this.createHttpsAgent(),
    };

    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;
    const downloadPath = path.join(STORE_PATH, this.storeId, dataPath); // Save to the correct store directory

    // Ensure that the directory for the file exists
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });

    const fileWriteStream = fs.createWriteStream(downloadPath);

    try {
      const response = await axios.get(url, config);
      const totalLength = parseInt(response.headers["content-length"], 10);

      console.log(cyan(`Starting download for ${dataPath}...`));

      // Create a progress bar for the download
      const progressBar = PropagationServer.multiBar.create(totalLength, 0, {
        dataPath: yellow(dataPath),
        percentage: 0,
      });

      let downloadedBytes = 0;

      // Pipe the response data to the file stream and track progress
      response.data.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        progressBar.update(downloadedBytes, {
          percentage: Math.round((downloadedBytes / totalLength) * 100),
        });
      });

      // Pipe the data into the file and finalize
      response.data.pipe(fileWriteStream);

      return new Promise<void>((resolve, reject) => {
        fileWriteStream.on("finish", () => {
          progressBar.update(totalLength, { percentage: 100 });
          progressBar.stop();
          console.log(
            green(
              `✔ File ${dataPath} downloaded successfully to ${downloadPath}.`
            )
          );
          resolve();
        });

        fileWriteStream.on("error", (error) => {
          progressBar.stop();
          console.error(
            red(`✖ Error downloading file ${dataPath}:`),
            error
          );
          reject(error);
        });
      });
    } catch (error) {
      console.error(red(`✖ Error downloading file ${dataPath}:`), error);
      throw error;
    }
  }

  /**
   * Static function to handle downloading multiple files from a DataStore based on file paths.
   * @param {string} storeId - The ID of the DataStore.
   * @param {string[]} dataPaths - The list of data paths to download.
   * @param {string} ipAddress - The IP address of the server.
   */
  static async downloadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(storeId, ipAddress);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const storeExists = await propagationServer.checkStoreExists();
    if (!storeExists) {
      throw new Error(`Store ${storeId} does not exist.`);
    }

    await propagationServer.downloadFile("height.json");
    const datFileContent = await propagationServer.fetchFile(`${rootHash}.dat`);
    const root = JSON.parse(datFileContent.toString());

    for (const [fileKey, fileData] of Object.entries(root.files)) {
      const dataPath = getFilePathFromSha256(
        root.files[fileKey].sha256,
        "data"
      );

      await propagationServer.downloadFile(dataPath);
    }

    console.log(green(`✔ All files have been downloaded to ${storeId}.`));
  }
}
