import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { DataIntegrityTree } from "@dignetwork/data-integrity-tree";

/**
 * Calculate the SHA-256 hash of a buffer using the crypto module.
 * @param buffer - The buffer.
 * @returns The SHA-256 hash of the buffer.
 */
const calculateSHA256 = (buffer: Buffer): string => {
  const hash = crypto.createHash("sha256");
  hash.update(buffer);
  return hash.digest("hex");
};

/**
 * Recursively add all files in a directory to the Merkle tree.
 * @param manager - The DataStoreManager instance.
 * @param dirPath - The directory path.
 * @param baseDir - The base directory for relative paths.
 */
const addDirectory = async (
  manager: DataIntegrityTree,
  dirPath: string,
  baseDir: string = dirPath
): Promise<void> => {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      await addDirectory(manager, filePath, baseDir);
    } else {
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");
      const fileBuffer = fs.readFileSync(filePath);
      const sha256 = calculateSHA256(fileBuffer);
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        manager
          .upsertKey(stream, Buffer.from(relativePath).toString("hex"))
          .then(resolve)
          .catch(reject);
      });
    }
  }
};

// Example usage:
const folderPath = path.resolve(
  "C:\\Users\\micha\\workspace\\sample-project"
); // Replace with your folder path
const storeId =
  "782dd222ed9510e709ed700ad89e15e398550acf92e8d8ee285999019ff4873a"; // Replace with your storeId or generate one
const manager = new DataIntegrityTree(storeId, {storageMode: 'local', storeDir: path.join(os.homedir(), ".dig", "stores")});
//manager.deleteAllLeaves();
const currentRoot = manager.getRoot();

// Adding all files in a directory
addDirectory(manager, folderPath)
  .then(() => {
    console.log("Merkle Root after adding directory:", manager.getRoot());

    // Listing keys
    console.log("Keys:", manager.listKeys());

    // Committing the tree
    manager.commit();

    // Stream out one of the files to the console
    const keyToStream = "646973742f6173736574732f696e6465782d44697772675464612e637373"; // Replace with a valid key

    // Example proof generation and verification
    const sha256 = manager.files.get(keyToStream)?.sha256;
    if (sha256) {
      const proof = manager.getProof(keyToStream, sha256);
      const isValid = manager.verifyProof(proof, sha256);
      console.log("Proof of Inclusion: ", proof);
      console.log("Proof valid:", isValid);
    }

    console.log("GET FILE", keyToStream);
    const stream = manager.getValueStream(keyToStream);
    stream.pipe(process.stdout);
  })
  .catch(console.error);

  /*
console.log(manager.getRootDiff(
    '2238e863fb278fbcb01d3e2d3c5a502f21911c1d3b3c2d178bdfb5cdb29badd1',
    '960e2b547a830eaf233e567c0fd7c43406b1bee97db0f1bd6b22b4cc4424e3e2'
));*/
