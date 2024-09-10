import * as path from "path";
import * as fs from "fs";
import ignore from "ignore";
import { DataIntegrityTree } from "../DataIntegrityTree";

// Custom concurrency handler
const limitConcurrency = async (concurrencyLimit: number, tasks: (() => Promise<void>)[]) => {
  const results = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const p = task();
    results.push(p);

    // Once the limit is reached, wait for one to complete
    if (executing.length >= concurrencyLimit) {
      await Promise.race(executing);
    }

    // Add the new task to the executing array
    executing.push(p);

    // When a task completes, remove it from the executing array
    p.finally(() => executing.splice(executing.indexOf(p), 1));
  }

  // Wait for all remaining tasks to complete
  return Promise.all(results);
};

export const addDirectory = async (
  datalayer: DataIntegrityTree,
  dirPath: string,
  baseDir: string = dirPath
): Promise<void> => {
  const ig = ignore();
  const gitignorePath = path.join(baseDir, ".gitignore");

  // Load .gitignore rules if the file exists
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  const files = fs.readdirSync(dirPath);
  const tasks: (() => Promise<void>)[] = [];

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");

    // Skip the .dig, .git folders and files or directories ignored by .gitignore
    if (file === ".dig" || file === ".git" || ig.ignores(relativePath)) {
      continue;
    }

    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Recursively process the directory
      tasks.push(() => addDirectory(datalayer, filePath, baseDir));
    } else {
      // Add a task for each file to be processed
      tasks.push(() =>
        new Promise<void>((resolve, reject) => {
          const stream = fs.createReadStream(filePath);
          datalayer
            .upsertKey(stream, Buffer.from(relativePath).toString("hex"))
            .then(resolve)
            .catch(reject);
        })
      );
    }
  }

  // Run tasks with limited concurrency (set the concurrency limit as needed)
  await limitConcurrency(10, tasks); // Adjust 10 based on your system limits
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