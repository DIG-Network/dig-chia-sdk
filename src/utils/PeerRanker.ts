// src/PeerRanker.ts

import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs';
import https from 'https';
import { getOrCreateSSLCerts } from './ssl';

/**
 * Interface representing the metrics of a peer.
 */
export interface PeerMetrics {
  ip: string;
  latency: number;    // in milliseconds
  bandwidth: number;  // in bytes per second
}

/**
 * Configuration options for the PeerRanker.
 */
interface PeerRankerOptions {
  clientCertPath: string;       // Path to the client certificate (.crt)
  clientKeyPath: string;        // Path to the client key (.key)
  bandwidthTestPath: string;    // Path or endpoint for bandwidth testing (e.g., '/testfile')
  pingPath?: string;            // Optional: Path for latency ping (e.g., '/ping')
  timeout?: number;             // Timeout for requests in milliseconds
  bandwidthTestSize?: number;   // Expected size of the bandwidth test file in bytes (for reference)
}

/**
 * Utility class to rank peers based on latency and bandwidth using HTTPS with mTLS.
 */
export class PeerRanker {
  private ipAddresses: string[];
  private static certPath: string;
  private static keyPath: string;
  private bandwidthTestPath: string;
  private pingPath: string;
  private timeout: number;
  private bandwidthTestSize: number;

  // Internal properties for iteration
  private sortedPeers: PeerMetrics[] = [];
  private currentIndex: number = 0;

  /**
   * Constructs a PeerRanker instance.
   * @param ipAddresses - Array of IP addresses to rank.
   * @param options - Configuration options including paths to client certificates.
   */
  constructor(ipAddresses: string[], options: PeerRankerOptions) {
    this.ipAddresses = ipAddresses;
    this.bandwidthTestPath = options.bandwidthTestPath;
    this.pingPath = options.pingPath || '/'; // Default to root path if not provided
    this.timeout = options.timeout || 5000; // Default timeout: 5 seconds
    this.bandwidthTestSize = options.bandwidthTestSize || 1024 * 1024; // Default: 1MB

    const { certPath, keyPath } = getOrCreateSSLCerts();
    PeerRanker.certPath = certPath;
    PeerRanker.keyPath = keyPath;
  }

  /**
   * Measures the latency of a given IP address using an HTTPS request.
   * Tries HEAD first, then falls back to GET if HEAD is not supported.
   * @param ip - The IP address of the peer.
   * @returns Promise resolving to the latency in milliseconds.
   */
  private async measureLatency(ip: string): Promise<number> {
    const path = this.pingPath;
    const url = `https://${ip}${path}`;
    
    // Configuration for HEAD request
    const configHead: AxiosRequestConfig = {
      url: url,
      method: 'HEAD',
      httpsAgent: new https.Agent({
        cert: fs.readFileSync(PeerRanker.certPath),
        key: fs.readFileSync(PeerRanker.keyPath),
        rejectUnauthorized: false, // Set to true in production
      }),
      timeout: this.timeout,
      validateStatus: (status) => status < 500, // Resolve only if status is less than 500
    };

    const startTime = Date.now();
    try {
      const response = await axios(configHead);
      if (response.status === 405) { // Method Not Allowed
        // Fallback to GET with Range header to minimize data transfer
        const configGet: AxiosRequestConfig = {
          url: url,
          method: 'GET',
          httpsAgent: new https.Agent({
            cert: fs.readFileSync(PeerRanker.certPath),
            key: fs.readFileSync(PeerRanker.keyPath),
            rejectUnauthorized: false, // Set to true in production
          }),
          timeout: this.timeout,
          headers: {
            'Range': 'bytes=0-0', // Request only the first byte
          },
          validateStatus: (status) => status < 500,
        };
        await axios(configGet);
      }
      const latency = Date.now() - startTime;
      return latency;
    } catch (error: any) {
      console.error(`Latency measurement failed for IP ${ip}:`, error.message);
      return Infinity; // Indicate unreachable or unresponsive peer
    }
  }

  /**
   * Measures the bandwidth of a given IP address by downloading a file and calculating throughput.
   * @param ip - The IP address of the peer.
   * @returns Promise resolving to the bandwidth in bytes per second.
   */
  private async measureBandwidth(ip: string): Promise<number> {
    const url = `https://${ip}${this.bandwidthTestPath}`;
    
    const config: AxiosRequestConfig = {
      url: url,
      method: 'GET',
      responseType: 'stream',
      httpsAgent: new https.Agent({
        cert: fs.readFileSync(PeerRanker.certPath),
        key: fs.readFileSync(PeerRanker.keyPath),
        rejectUnauthorized: false, // Set to true in production
      }),
      timeout: this.timeout,
    };

    return new Promise<number>((resolve) => {
      const startTime = Date.now();
      let bytesReceived = 0;

      axios(config)
        .then((response) => {
          response.data.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
          });

          response.data.on('end', () => {
            const timeElapsed = (Date.now() - startTime) / 1000; // seconds
            const bandwidth = bytesReceived / timeElapsed; // bytes per second
            resolve(bandwidth);
          });

          response.data.on('error', (err: Error) => {
            console.error(`Bandwidth measurement error for IP ${ip}:`, err.message);
            resolve(0); // Indicate failure in measuring bandwidth
          });
        })
        .catch((error) => {
          console.error(`Bandwidth measurement failed for IP ${ip}:`, error.message);
          resolve(0); // Indicate failure in measuring bandwidth
        });
    });
  }

  /**
   * Ranks the peers based on measured latency and bandwidth.
   * @returns Promise resolving to an array of PeerMetrics sorted by latency and bandwidth.
   */
  public async rankPeers(): Promise<PeerMetrics[]> {
    const metricsPromises = this.ipAddresses.map(async (ip) => {
      const [latency, bandwidth] = await Promise.all([
        this.measureLatency(ip),
        this.measureBandwidth(ip),
      ]);

      return { ip, latency, bandwidth };
    });

    const peerMetrics: PeerMetrics[] = await Promise.all(metricsPromises);

    // Sort by lowest latency first, then by highest bandwidth
    peerMetrics.sort((a, b) => {
      if (a.latency === b.latency) {
        return b.bandwidth - a.bandwidth; // Higher bandwidth is better
      }
      return a.latency - b.latency; // Lower latency is better
    });

    // Update the internal sorted list
    this.sortedPeers = peerMetrics;
    // Reset the iterator index
    this.currentIndex = 0;

    return peerMetrics;
  }

  /**
   * Returns the next best peer based on the ranking.
   * Cycles through the list, resetting to the beginning once the end is reached.
   * @returns The next PeerMetrics object or null if no peers are available.
   */
  public GetNextBestPeer(): PeerMetrics | null {
    if (this.sortedPeers.length === 0) {
      console.warn('Peer list is empty. Please run rankPeers() first.');
      return null;
    }

    const peer = this.sortedPeers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.sortedPeers.length;
    return peer;
  }

  /**
   * Resets the internal iterator to start from the beginning of the sorted list.
   */
  public resetIterator(): void {
    this.currentIndex = 0;
  }
}
