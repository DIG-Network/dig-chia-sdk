import nconf from "nconf";
import fs from "fs-extra";
import path from "path";
import { USER_DIR_PATH } from "./config";
import { Environment } from "./Environment";

const CONF_FOLDER_PATH = Environment.DIG_FOLDER_PATH || USER_DIR_PATH;

export class NconfManager {
  private configFilePath: string;

  constructor(relativePath: string) {
    this.configFilePath = path.join(CONF_FOLDER_PATH, relativePath);
    this.initializeConfig();
  }

  private async initializeConfig(): Promise<void> {
    const directory = path.dirname(this.configFilePath);
    if (!(await fs.pathExists(directory))) {
      await fs.mkdirp(directory);
      console.log("Directory created:", directory);
    }

    if (!(await fs.pathExists(this.configFilePath))) {
      await fs.writeFile(this.configFilePath, "{}");
      console.log("Configuration file created:", this.configFilePath);
    }

    nconf.file({ file: this.configFilePath });
  }

  public async getConfigValue<T>(key: string): Promise<T | null> {
    await this.initializeConfig();
    const value = nconf.get(key);
    return value !== undefined ? value : null;
  }

  public async setConfigValue(key: string, value: any): Promise<void> {
    await this.initializeConfig();
    nconf.set(key, value);
    await new Promise((resolve, reject) =>
      nconf.save((err: any) => (err ? reject(err) : resolve(undefined)))
    );
    console.log(`${key} saved to config file.`);
  }

  public async deleteConfigValue(key: string): Promise<void> {
    await this.initializeConfig();
    nconf.clear(key);
    await new Promise((resolve, reject) =>
      nconf.save((err: any) => (err ? reject(err) : resolve(undefined)))
    );
    console.log(`${key} deleted from config file.`);
  }

  public async configExists(): Promise<boolean> {
    return await fs.pathExists(this.configFilePath);
  }

  // Method to get the full configuration as a key-value object
  public async getFullConfig(): Promise<Record<string, any>> {
    await this.initializeConfig();
    return nconf.get() || {};
  }
}
