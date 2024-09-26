import https from "https";
import { URL } from "url";
import { IncentiveProgramData } from "../types";
import { formatHost } from "../utils/network";

export class IncentiveServer {
  private ipAddress: string;
  private port: number = 4160;

  constructor(ipAddress: string) {
    this.ipAddress = ipAddress;
  }

  // Method to create a new incentive program
  public async createIncentiveProgram(data: IncentiveProgramData): Promise<void> {
    const url = `https://${formatHost(this.ipAddress)}:${this.port}/incentive`;

    await this.makeRequest(url, "POST", data);
  }

  // Method to update an existing incentive program
  public async updateIncentiveProgram(data: IncentiveProgramData): Promise<void> {
    const url = `https://${formatHost(this.ipAddress)}:${this.port}/incentive`;

    await this.makeRequest(url, "PUT", data);
  }

  // Method to delete an incentive program by storeId
  public async deleteIncentiveProgram(storeId: string): Promise<void> {
    const url = `https://${formatHost(this.ipAddress)}:${this.port}/incentive`;

    await this.makeRequest(url, "DELETE", { storeId });
  }

  // Method to get all incentive programs
  public async getAllIncentivePrograms(): Promise<IncentiveProgramData[]> {
    const url = `https://${formatHost(this.ipAddress)}:${this.port}/incentive`;

    return this.makeRequest(url, "GET");
  }

  // Method to get a specific incentive program by storeId
  public async getIncentiveProgram(storeId: string): Promise<IncentiveProgramData> {
    const url = `https://${formatHost(this.ipAddress)}:${this.port}/incentive/${storeId}`;

    return this.makeRequest(url, "GET");
  }

  // Helper method to handle the HTTPS request
  private async makeRequest(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    data?: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let responseData = "";

        res.on("data", (chunk) => {
          responseData += chunk;
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData ? JSON.parse(responseData) : undefined);
          } else {
            reject(new Error(`Request failed with status ${res.statusCode}: ${res.statusMessage}`));
          }
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }
}
