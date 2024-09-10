"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const DataIntegrityTree_1 = require("../../src/Data@dignetwork/data-integrity-tree");
/**
 * Calculate the SHA-256 hash of a buffer using the crypto module.
 * @param buffer - The buffer.
 * @returns The SHA-256 hash of the buffer.
 */
const calculateSHA256 = (buffer) => {
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
const addDirectory = async (manager, dirPath, baseDir = dirPath) => {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            await addDirectory(manager, filePath, baseDir);
        }
        else {
            const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");
            const fileBuffer = fs.readFileSync(filePath);
            const sha256 = calculateSHA256(fileBuffer);
            await new Promise((resolve, reject) => {
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
const folderPath = path.resolve("C:\\Users\\micha\\workspace\\sample-project"); // Replace with your folder path
const storeId = "782dd222ed9510e709ed700ad89e15e398550acf92e8d8ee285999019ff4873a"; // Replace with your storeId or generate one
const manager = new DataIntegrityTree_1.DataIntegrityTree(storeId, { storageMode: 'local', storeDir: path.join(os.homedir(), ".dig", "stores") });
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
