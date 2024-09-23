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

// Helper function to trim long filenames with ellipsis and ensure consistent padding
function formatFilename(filename: string, maxLength = 30): string {
  if (filename.length > maxLength) {
    // Trim the filename and add ellipsis
    return `...${filename.slice(-(maxLength - 3))}`.padEnd(maxLength, " ");
  }
  // For shorter filenames, just pad to the maxLength
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
  username: string | undefined; // To store username if needed for credentials
  password: string | undefined; // To store password if needed for credentials

  private static readonly port = 4159; // Static port used for all requests

  // Adjust cliProgress settings to align output properly and handle potential undefined values
  // MultiBar for handling multiple progress bars with green progress and margin between bars
  private static multiBar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: (options, params, payload) => {
        // Bar length and padding settings
        const barCompleteChar = green(options.barCompleteChar || "="); // Green bar for completed portion
        const barIncompleteChar = options.barIncompleteChar || "-"; // Default incomplete character
        const barSize = options.barsize || 40; // Default size of the bar

        // Calculate the bar progress
        const progressBar = `${barCompleteChar.repeat(
          Math.round(params.progress * barSize)
        )}${barIncompleteChar.repeat(
          barSize - Math.round(params.progress * barSize)
        )}`;

        // Calculate the percentage manually
        const percentage = Math.round((params.value / params.total) * 100);

        // Format the filename to a fixed length
        const formattedFilename = formatFilename(payload.filename, 30); // Trim to max 30 chars

        // Padding the filename, percentage, and size
        const percentageStr = `${percentage}%`.padEnd(4); // Ensure percentage is always 7 characters wide
        const size = `${params.value}/${params.total} bytes`.padEnd(20); // Ensure size is always 20 characters wide

        // Return the complete formatted progress bar with padding
        return `${progressBar} | ${formattedFilename.padEnd(
          35
        )} | ${percentageStr} | ${size}`;
      },
      stopOnComplete: true,
      barsize: 40,
      align: "left",
    },
    cliProgress.Presets.shades_classic
  );

  constructor(ipAddress: string, storeId: string) {
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
    this.publicKey = await this.wallet.getPublicSyntheticKey().toString("hex");
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
          text: green(`Store ${this.storeId} exists on peer!`),
        });
      } else {
        spinner.error({
          text: red(
            `Store ${this.storeId} does not exist. Credentials will be required to push.`
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
   *
   * @param {string} rootHash - The root hash used to name the .dat file.
   * @param {string} datFilePath - The full path to the rootHash.dat file.
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
          `Upload session started for DataStore ${this.storeId} with session ID ${this.sessionId}`
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
   * Checks if the file already exists based on the 'x-file-exists' header.
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
   * Logs progress using cli-progress for each file.
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

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));

    const fileSize = fs.statSync(filePath).size;

    // Create a new progress bar for each file
    const progressBar = PropagationServer.multiBar.create(fileSize, 0, {
      filename: yellow(path.basename(label)),
      percentage: 0,
    });

    let uploadedBytes = 0;

    const config: AxiosRequestConfig = {
      headers: {
        "Content-Type": "multipart/form-data",
        "x-nonce": nonce,
        "x-public-key": publicKey.toString("hex"),
        "x-key-ownership-sig": keyOwnershipSig,
        ...formData.getHeaders(),
      },
      httpsAgent: this.createHttpsAgent(),

      // Tracking upload progress and updating the progress bar
      onUploadProgress: (progressEvent: any) => {
        const uploadedBytes = progressEvent.loaded;
        const percentage = Math.round(
          (100 * progressEvent.loaded) / progressEvent.total
        );
        progressBar.update(uploadedBytes, { percentage });
      },
    };

    try {
      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${dataPath}`;
      const response = await axios.put(url, formData, config);

      // Complete the progress bar
      progressBar.update(fileSize, { percentage: 100 });
      progressBar.stop();

      return response.data;
    } catch (error: any) {
      console.error(red(`✖ Error uploading file ${label}:`), error.message);
      progressBar.stop(); // Stop the progress bar in case of error
      throw error;
    }
  }

  /**
   * Commit the upload session by sending a POST request to the server.
   * This finalizes the upload and moves files from the temporary session directory to the permanent location.
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

    // Upload each file
    for (const file of files) {
      await propagationServer.uploadFile(file.name, file.path);
    }

    // Commit the session after all files have been uploaded
    await propagationServer.commitUploadSession();

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
      onDownloadProgress: (progressEvent) => {
        const totalLength = progressEvent.total || 0;
        const downloadedBytes = progressEvent.loaded;

        // Update progress bar
        const progressBar = PropagationServer.multiBar.create(totalLength, 0, {
          dataPath: yellow(dataPath),
          percentage: 0,
        });

        progressBar.update(downloadedBytes, {
          percentage: Math.round((downloadedBytes / totalLength) * 100),
        });

        if (downloadedBytes === totalLength) {
          progressBar.update(totalLength, { percentage: 100 });
          progressBar.stop();
          console.log(green(`✔ File ${dataPath} fetched successfully.`));
        }
      },
    };

    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;

    try {
      const response = await axios.get(url, config);

      // Return the file contents as a Buffer
      return Buffer.from(response.data);
    } catch (error) {
      console.error(red(`✖ Error fetching file ${dataPath}:`), error);
      throw error;
    }
  }

  /**
   * Get details of a file, including whether it exists and its size.
   * Makes a HEAD request to the server and checks the response headers.
   *
   * @param {string} dataPath - The path of the file within the DataStore.
   * @param {string} rootHash - The root hash associated with the DataStore.
   * @returns {Promise<{ exists: boolean; size: number }>} - An object containing file existence and size information.
   */
  async getFileDetails(
    dataPath: string,
    rootHash: string
  ): Promise<{ exists: boolean; size: number }> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      // Construct the URL for the HEAD request to check file details
      const url = `https://${this.ipAddress}:${PropagationServer.port}/store/${this.storeId}/${rootHash}/${dataPath}`;
      const response = await axios.head(url, config);

      // Check the headers for file existence and size
      const fileExists = response.headers["x-file-exists"] === "true";
      const fileSize = parseInt(response.headers["x-file-size"], 10);

      return {
        exists: fileExists,
        size: fileExists ? fileSize : 0, // Return 0 size if file doesn't exist
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
              `
              File ${dataPath} downloaded successfully to ${downloadPath}.`
            )
          );
          resolve();
        });

        fileWriteStream.on("error", (error) => {
          progressBar.stop();
          console.error(red(`✖ Error downloading file ${dataPath}:`), error);
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
    const propagationServer = new PropagationServer(ipAddress, storeId);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const { storeExists, rootHashExists } =
      await propagationServer.checkStoreExists(rootHash);
    if (!storeExists || !rootHashExists) {
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

    const dataStore = DataStore.from(storeId);
    await dataStore.generateManifestFile();

    console.log(green(`✔ All files have been downloaded to ${storeId}.`));
  }
}
