import fs from "fs";
import path from "path";

export class Environment {
  private static cliMode: boolean = false;

  // Helper to validate if a string is a valid IP address (IPv4)
  private static isValidIp(ip: string): boolean {
    const ipPattern =
      /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipPattern.test(ip);
  }

  // Helper to validate if a string is a valid hostname or IP address
  private static isValidHostnameOrIp(hostname: string): boolean {
    // Hostname regex (simple, allows subdomains but not special characters)
    const hostnamePattern =
      /^(([a-zA-Z0-9](-*[a-zA-Z0-9])*)\.)*([a-zA-Z0-9](-*[a-zA-Z0-9])*)\.?$/;
    return this.isValidIp(hostname) || hostnamePattern.test(hostname);
  }

  // Helper to validate if a number is a valid port (between 1 and 65535)
  private static isValidPort(port: number): boolean {
    return port > 0 && port <= 65535;
  }

  // Helper to validate if a string is a valid file path
  private static isValidFilePath(filePath: string): boolean {
    return fs.existsSync(filePath) && path.isAbsolute(filePath);
  }

  // Helper to get and validate number env variables
  private static getNumberEnvVar(envVar: string): number | undefined {
    const value = process.env[envVar];
    const parsedValue = Number(value);
    return !isNaN(parsedValue) ? parsedValue : undefined;
  }

  // Static getter for DIG_USERNAME (string, non-empty)
  static get DIG_USERNAME(): string | undefined {
    const value = process.env["DIG_USERNAME"];
    return value && value.trim().length > 0 ? value : undefined;
  }

  // Static getter for DIG_PASSWORD (string, non-empty)
  static get DIG_PASSWORD(): string | undefined {
    const value = process.env["DIG_PASSWORD"];
    return value && value.trim().length > 0 ? value : undefined;
  }

  // Static getter for TRUSTED_FULLNODE (valid IP or hostname)
  static get TRUSTED_FULLNODE(): string | undefined {
    const value = process.env["TRUSTED_FULLNODE"];
    return value && this.isValidHostnameOrIp(value) ? value : undefined;
  }

  // Static getter for TRUSTED_FULLNODE_PORT (valid port)
  static get TRUSTED_FULLNODE_PORT(): number | undefined {
    const port = this.getNumberEnvVar("TRUSTED_FULLNODE_PORT");
    return port && this.isValidPort(port) ? port : undefined;
  }

  // Static getter for PUBLIC_IP (valid IP)
  static get PUBLIC_IP(): string | undefined {
    const value = process.env["PUBLIC_IP"];
    return value && this.isValidHostnameOrIp(value) ? value : undefined;
  }

  // Static getter for DISK_SPACE_LIMIT_BYTES (number, optional)
  static get DISK_SPACE_LIMIT_BYTES(): number | undefined {
    return this.getNumberEnvVar("DISK_SPACE_LIMIT_BYTES");
  }

  // Static getter for MERCENARY_MODE (boolean: "true" or "false")
  static get MERCENARY_MODE(): boolean | undefined {
    const value = process.env["MERCENARY_MODE"];
    return value === "true" ? true : value === "false" ? false : undefined;
  }

  // Static getter for MERCENARY_MODE (boolean: "true" or "false")
  static get DEBUG(): boolean | undefined {
    const value = process.env["DIG_DEBUG"];
    return value === "true" ? true : value === "false" ? false : undefined;
  }

  // Static getter for DIG_FOLDER_PATH (valid file path)
  static get DIG_FOLDER_PATH(): string | undefined {
    const value = process.env["DIG_FOLDER_PATH"];
    return value && this.isValidFilePath(value) ? value : undefined;
  }

  // Static getter for REMOTE_NODE (boolean: "1" or "0", mapped to true/false)
  static get REMOTE_NODE(): boolean | undefined {
    const value = process.env["REMOTE_NODE"];
    return value === "1" ? true : value === "0" ? false : undefined;
  }

  static set CLI_MODE(mode: boolean) {
    this.cliMode = mode;
  }

  static get CLI_MODE(): boolean | undefined {
    return Environment.cliMode;
  }
}
