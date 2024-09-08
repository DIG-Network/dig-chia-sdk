import fs from "fs";
import path from "path";
import { DIG_FOLDER_PATH } from "./config";

export class FileCache<T> {
  private cacheDir: string;

  constructor(relativeFilePath: string) {
    this.cacheDir = path.join(DIG_FOLDER_PATH, relativeFilePath);
    this.ensureDirectoryExists();
  }

  // Ensure the directory exists or create it
  private ensureDirectoryExists(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  // Get the cache file path for the given key
  private getCacheFilePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  // Retrieve cached data by key
  public get(key: string): T | null {
    const cacheFilePath = this.getCacheFilePath(key);

    if (!fs.existsSync(cacheFilePath)) {
      return null;
    }

    const rawData = fs.readFileSync(cacheFilePath, "utf-8");
    return JSON.parse(rawData) as T;
  }

  // Save data to the cache
  public set(key: string, data: T): void {
    const cacheFilePath = this.getCacheFilePath(key);
    const serializedData = JSON.stringify(data);
    fs.writeFileSync(cacheFilePath, serializedData);
  }

  // Delete cache data by key
  public delete(key: string): void {
    const cacheFilePath = this.getCacheFilePath(key);

    if (fs.existsSync(cacheFilePath)) {
      fs.unlinkSync(cacheFilePath);
    }
  }

  // Retrieve all cached keys in the directory
  public getCachedKeys(): string[] {
    if (!fs.existsSync(this.cacheDir)) {
      return [];
    }

    return fs
      .readdirSync(this.cacheDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(".json", ""));
  }
}
