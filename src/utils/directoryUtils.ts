import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import ignore from "ignore";
import pLimit from "p-limit";
import { DataIntegrityTree } from "../DataIntegrityTree";


const limit = pLimit(10); // Limit the concurrency to 10 (adjust based on your system's file descriptor limit)

// Promisify fs methods
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);

/**
 * Recursively add all files in a directory to the Merkle tree, skipping the .dig, .git folders, and files in .gitignore.
 * @param datalayer - The DataStoreManager instance.
 * @param dirPath - The directory path.
 * @param baseDir - The base directory for relative paths.
 */
export const addDirectory = async (
  datalayer: DataIntegrityTree,
  dirPath: string,
  baseDir: string = dirPath
): Promise<void> => {
  const ig = ignore();
  const gitignorePath = path.join(baseDir, ".gitignore");

  // Load .gitignore rules if the file exists
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  const files = await readdir(dirPath);

  // Process each file or directory
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(dirPath, file);
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");

      // Skip the .dig, .git folders and files or directories ignored by .gitignore
      if (file === ".dig" || file === ".git" || ig.ignores(relativePath)) {
        return;
      }

      const fileStat = await stat(filePath);

      if (fileStat.isDirectory()) {
        // Recursively process the directory
        return addDirectory(datalayer, filePath, baseDir);
      } else {
        // Process the file with limited concurrency
        return limit(() =>
          new Promise<void>((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            datalayer
              .upsertKey(stream, Buffer.from(relativePath).toString("hex"))
              .then(resolve)
              .catch(reject);
          })
        );
      }
    })
  );
};


/**
 * Calculate the total size of the DIG_FOLDER_PATH
 * @param folderPath - The path of the folder to calculate size.
 * @returns The total size of the folder in bytes.
 */
export const calculateFolderSize = (folderPath: string): bigint => {
  let totalSize = BigInt(0);

  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      totalSize += calculateFolderSize(filePath);
    } else {
      totalSize += BigInt(stat.size);
    }
  }

  return totalSize;
};
