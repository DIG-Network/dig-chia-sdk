import { exec } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";

/**
 * @class IllegalContentScanner
 * Scans files for illegal content using ClamAV running in a Docker container and deletes files if flagged.
 */
export class IllegalContentScanner {
    private clamAVContainerName: string;
    private virusTotalApiKey?: string;
    private openAiApiKey?: string;

    /**
     * @constructor
     * @param clamAVContainerName The name of the Docker container running ClamAV (default: 'clamav').
     */
    constructor(clamAVContainerName: string = "clamav") {
        this.clamAVContainerName = clamAVContainerName;
        this.virusTotalApiKey = process.env.VIRUSTOTAL_API_KEY || undefined;
        this.openAiApiKey = process.env.OPENAI_API_KEY || undefined;
    }

    /**
     * Scans a file for illegal content using ClamAV, VirusTotal, and OpenAI Moderation API.
     * If a service is missing its API key, the scan for that service is skipped.
     * @param filePath The path of the file to scan.
     * @returns {Promise<void>} A promise that resolves after the scan and potential deletion.
     */
    public async scanFile(filePath: string): Promise<void> {
        try {
            // 1. ClamAV Scan
            console.log(`Starting ClamAV scan for file: ${filePath}`);
            const clamAvResult = await this.scanWithClamAV(filePath);
            if (this.isClamAVResultMalicious(clamAvResult)) {
                console.log(`ClamAV flagged file: ${filePath}. Deleting...`);
                this.deleteFile(filePath);
                return;
            } else {
                console.log(`ClamAV did not flag the file: ${filePath}.`);
            }

            // 2. VirusTotal Scan (if API key is provided)
            if (this.virusTotalApiKey) {
                console.log(`Submitting file to VirusTotal for scanning: ${filePath}`);
                const virusTotalResult = await this.scanWithVirusTotal(filePath);
                if (this.isVirusTotalResultMalicious(virusTotalResult)) {
                    console.log(`VirusTotal flagged file: ${filePath}. Deleting...`);
                    this.deleteFile(filePath);
                    return;
                } else {
                    console.log(`VirusTotal did not flag the file: ${filePath}.`);
                }
            } else {
                console.log(`VirusTotal API key not provided. Skipping VirusTotal scan.`);
            }

            // 3. OpenAI Moderation API (if API key is provided and file is text-based)
            const fileExtension = path.extname(filePath).toLowerCase();
            if (this.openAiApiKey && (fileExtension === ".txt" || fileExtension === ".json")) {
                console.log(`Scanning file content with OpenAI Moderation API: ${filePath}`);
                const fileContent = await fs.promises.readFile(filePath, "utf-8");
                const openAiResult = await this.scanWithOpenAI(fileContent);
                if (this.isOpenAiResultMalicious(openAiResult)) {
                    console.log(`OpenAI flagged file: ${filePath}. Deleting...`);
                    this.deleteFile(filePath);
                    return;
                }
            } else {
                if (!this.openAiApiKey) {
                    console.log(`OpenAI API key not provided. Skipping OpenAI scan.`);
                } else {
                    console.log(`OpenAI scan skipped: File type not supported (${fileExtension}).`);
                }
            }

            console.log(`File ${filePath} passed all multilayer scans.`);
        } catch (error) {
            console.error(`Error scanning file: ${filePath}`, error);
        }
    }

    /**
     * Scans a file using ClamAV running in Docker.
     * @param filePath The path of the file to scan.
     * @returns {Promise<string>} The result of the ClamAV scan.
     */
    private scanWithClamAV(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(`docker exec ${this.clamAVContainerName} clamdscan ${filePath}`, (error, stdout, stderr) => {
                if (error) {
                    reject(`ClamAV scan error: ${stderr}`);
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    /**
     * Submits a file to VirusTotal for scanning.
     * @param filePath The path of the file to scan.
     * @returns {Promise<any>} The result from VirusTotal.
     */
    private async scanWithVirusTotal(filePath: string): Promise<any> {
        const fileContent = await fs.promises.readFile(filePath);
        const formData = new FormData();
        // @ts-ignore
        formData.append("file", fileContent);

        const response = await axios.post("https://www.virustotal.com/vtapi/v2/file/scan", formData, {
            headers: {
                "x-apikey": this.virusTotalApiKey,
                // @ts-ignore
                ...formData.getHeaders(),
            },
        });
        return response.data;
    }

    /**
     * Scans file content (text) using OpenAI's Moderation API.
     * @param content The text content to scan.
     * @returns {Promise<any>} The result from OpenAI's Moderation API.
     */
    private async scanWithOpenAI(content: string): Promise<any> {
        const response = await axios.post(
            "https://api.openai.com/v1/moderations",
            { input: content },
            {
                headers: {
                    Authorization: `Bearer ${this.openAiApiKey}`,
                },
            }
        );
        return response.data;
    }

    /**
     * Checks if the ClamAV scan result indicates a malicious file.
     * @param result The ClamAV scan output.
     * @returns {boolean} True if the file is flagged, false otherwise.
     */
    private isClamAVResultMalicious(result: string): boolean {
        return result.includes("FOUND");
    }

    /**
     * Checks if the VirusTotal result indicates a malicious file.
     * @param result The VirusTotal scan result.
     * @returns {boolean} True if the file is flagged, false otherwise.
     */
    private isVirusTotalResultMalicious(result: any): boolean {
        // Check if VirusTotal flagged the file based on its multiple antivirus results
        return result.positives > 0;
    }

    /**
     * Checks if the OpenAI Moderation result indicates harmful content.
     * @param result The OpenAI Moderation result.
     * @returns {boolean} True if harmful content is detected, false otherwise.
     */
    private isOpenAiResultMalicious(result: any): boolean {
        return result.flagged === true;
    }

    /**
     * Deletes a file from the filesystem.
     * @param filePath The file to delete.
     */
    private deleteFile(filePath: string): void {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Error deleting file: ${filePath}`, err);
            } else {
                console.log(`File ${filePath} was deleted successfully.`);
            }
        });
    }
}