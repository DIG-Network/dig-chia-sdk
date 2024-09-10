import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import ignore from "ignore";
import pLimit from "p-limit";
import { DataIntegrityTree } from "../DataIntegrityTree";


// Function to dynamically load p-limit since it's an ES module
async function loadPLimit() {
  const { default: pLimit } = await import('p-limit');
  return pLimit;
}

export const addDirectory = async (
  datalayer: DataIntegrityTree,
  dirPath: string,
  baseDir: string = dirPath
): Promise<void> => {
  const limit = await loadPLimit();  // Dynamically load p-limit and get the default export
  const ig = ignore();
  const gitignorePath = path.join(baseDir, ".gitignore");

  // Load .gitignore rules if the file exists
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  const files = fs.readdirSync(dirPath);

  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(dirPath, file);
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");

      // Skip the .dig, .git folders and files or directories ignored by .gitignore
      if (file === ".dig" || file === ".git" || ig.ignores(relativePath)) {
        return;
      }

      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        await addDirectory(datalayer, filePath, baseDir);
      } else {
        // Use the dynamically loaded p-limit to limit concurrent file processing
        return limit(10)(() =>
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
