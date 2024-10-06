import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs';
import https from 'https';
import { getOrCreateSSLCerts } from './ssl';
import { asyncPool } from './promiseUtils';

export interface PeerMetrics {
  ip: string;
  latency: number;    // in milliseconds
  bandwidth: number;  // in bytes per second (upload speed)
}

/**
 * Utility class to rank peers based on latency and upload bandwidth using HTTPS with mTLS.
 */
export class PeerRanker {
  private ipAddresses: string[];
  private static certPath: string;
  private static keyPath: string;
  private timeout: number;
  private uploadTestSize: number;

  // Internal properties for iteration
  private sortedPeers: PeerMetrics[] = [];
  private currentIndex: number = 0;

  /**
   * Constructs a PeerRanker instance.
   * @param ipAddresses - Array of IP addresses to rank.
   */
  constructor(ipAddresses: string[], timeout: number = 5000, uploadTestSize: number = 1024 * 1024) {
    this.ipAddresses = ipAddresses;
    this.timeout = timeout; // Allow customizable timeout
    this.uploadTestSize = uploadTestSize; // Default upload size: 1MB

    // Fetch the SSL certificates used for mTLS.
    const { certPath, keyPath } = getOrCreateSSLCerts();
    PeerRanker.certPath = certPath;
    PeerRanker.keyPath = keyPath;
  }

  /**
   * Measures the latency of a given IP address using an HTTPS request.
   * Tries HEAD first, then falls back to GET if HEAD is not supported.
   * @param ip - The IP address of the peer.
   * @returns Promise resolving to the latency in milliseconds or rejecting if the peer fails.
   */
  private async measureLatency(ip: string): Promise<number> {
    const url = `https://${ip}:4159/diagnostics/ping`;
    
    const configHead: AxiosRequestConfig = {
      url: url,
      method: 'HEAD',
      httpsAgent: new https.Agent({
        cert: fs.readFileSync(PeerRanker.certPath),
        key: fs.readFileSync(PeerRanker.keyPath),
        rejectUnauthorized: false,
      }),
      timeout: this.timeout,
      validateStatus: (status) => status < 500,
    };

    const startTime = Date.now();
    try {
      const response = await axios(configHead);
      if (response.status === 405) {
        const configGet: AxiosRequestConfig = {
          url: url,
          method: 'GET',
          httpsAgent: new https.Agent({
            cert: fs.readFileSync(PeerRanker.certPath),
            key: fs.readFileSync(PeerRanker.keyPath),
            rejectUnauthorized: false,
          }),
          timeout: this.timeout,
          headers: {
            'Range': 'bytes=0-0',
          },
          validateStatus: (status) => status < 500,
        };
        await axios(configGet);
      }
      const latency = Date.now() - startTime;
      return latency;
    } catch (error: any) {
      console.error(`Latency measurement failed for IP ${ip}:`, error.message);
      throw new Error(`Latency measurement failed for IP ${ip}`);
    }
  }

  /**
   * Measures the upload bandwidth of a given IP address by sending random data.
   * @param ip - The IP address of the peer.
   * @returns Promise resolving to the upload bandwidth in bytes per second or rejecting if the peer fails.
   */
  private async measureBandwidth(ip: string): Promise<number> {
    const url = `https://${ip}:4159/diagnostics/bandwidth`;
    const randomData = Buffer.alloc(this.uploadTestSize, 'a');

    const config: AxiosRequestConfig = {
      url: url,
      method: 'POST',
      data: randomData,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': this.uploadTestSize,
      },
      httpsAgent: new https.Agent({
        cert: fs.readFileSync(PeerRanker.certPath),
        key: fs.readFileSync(PeerRanker.keyPath),
        rejectUnauthorized: false,
      }),
      timeout: this.timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    const startTime = Date.now();

    try {
      await axios(config);
      const timeElapsed = (Date.now() - startTime) / 1000;
      const bandwidth = this.uploadTestSize / timeElapsed;
      return bandwidth;
    } catch (error: any) {
      console.error(`Bandwidth measurement failed for IP ${ip}:`, error.message);
      throw new Error(`Bandwidth measurement failed for IP ${ip}`);
    }
  }

  /**
   * Ranks the peers based on measured latency and upload bandwidth.
   * Unresponsive peers are excluded from the final ranking.
   * @param cooldown - Cooldown time in milliseconds between batches.
   * @returns Promise resolving to an array of PeerMetrics sorted by latency and bandwidth.
   */
  public async rankPeers(cooldown: number = 500): Promise<PeerMetrics[]> {
    const limit = 5; // Limit to 5 parallel requests at a time

    const iteratorFn = async (ip: string): Promise<PeerMetrics | null> => {
      try {
        const [latency, bandwidth] = await Promise.all([
          this.measureLatency(ip),
          this.measureBandwidth(ip),
        ]);
        return { ip, latency, bandwidth };
      } catch (error) {
        // Peer failed, skip it by returning null
        return null;
      }
    };

    // Process all peers with a concurrency limit and cooldown between batches
    const peerMetrics: PeerMetrics[] = (
      await asyncPool(limit, this.ipAddresses, iteratorFn, cooldown)
    ).filter((metrics: any): metrics is PeerMetrics => metrics !== null); // Use a type guard

    // Sort by lowest latency first, then by highest bandwidth
    peerMetrics.sort((a, b) => {
      if (a.latency === b.latency) {
        return b.bandwidth - a.bandwidth; // Higher bandwidth is better
      }
      return a.latency - b.latency; // Lower latency is better
    });

    this.sortedPeers = peerMetrics;
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
