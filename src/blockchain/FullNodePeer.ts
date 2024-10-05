// FullNodePeer.ts

import path from "path";
import os from "os";
import fs from "fs";
import { Peer, Tls } from "@dignetwork/datalayer-driver";
import { resolve4 } from "dns/promises";
import net from "net";
import { createSpinner } from "nanospinner";
import { MIN_HEIGHT, MIN_HEIGHT_HEADER_HASH } from "../utils/config";
import { Environment } from "../utils/Environment";
import NodeCache from "node-cache";
import Bottleneck from "bottleneck";

/**
 * Module Augmentation to extend the Peer interface with the 'on' method.
 * This resolves the TypeScript error: Property 'on' does not exist on type 'Peer'.
 */
declare module "@dignetwork/datalayer-driver" {
  interface Peer {
    on(event: string, listener: (...args: any[]) => void): this;
  }
}

/**
 * Constants defining configuration parameters.
 */
const FULLNODE_PORT = 8444;
const LOCALHOST = "127.0.0.1";
const CHIA_NODES_HOST = "chia-nodes";
const DNS_HOSTS = [
  "dns-introducer.chia.net",
  "chia.ctrlaltdel.ch",
  "seeder.dexie.space",
  "chia.hoffmang.com",
];
const CONNECTION_TIMEOUT = 2000; // in milliseconds
const CACHE_DURATION = 30000; // in milliseconds
const COOLDOWN_DURATION = 300000; // 5 minutes in milliseconds
const MAX_PEERS_TO_FETCH = 5; // Maximum number of peers to fetch from DNS
const MAX_RETRIES = 3; // Maximum number of retry attempts
const MAX_REQUESTS_PER_MINUTE = 100; // Per-peer rate limit

/**
 * Interface representing information about a peer.
 */
interface PeerInfo {
  peer: Peer; // Original Peer instance wrapped by Proxy
  weight: number;
  address: string;
  isConnected: boolean; // Indicates if the peer is currently connected
  limiter: Bottleneck; // Rate limiter for the peer
}

/**
 * Creates a proxy for the Peer instance to handle errors, retries, and rate limiting.
 * @param peer - The original Peer instance.
 * @param peerIP - The IP address of the peer.
 * @param retryCount - The current retry attempt.
 * @returns {Peer} - The proxied Peer instance.
 */
function createPeerProxy(peer: Peer, peerIP: string, retryCount: number = 0): Peer {
  // Initialize Bottleneck limiter for rate limiting
  const limiter = new Bottleneck({
    maxConcurrent: 1, // One request at a time per peer
    minTime: 60000 / MAX_REQUESTS_PER_MINUTE, // e.g., 600 ms between requests for 100 requests/min
  });

  return new Proxy(peer, {
    get(target, prop, receiver) {
      const originalMethod = (target as any)[prop];
      if (typeof originalMethod === "function") {
        return async (...args: any[]) => {
          try {
            // Schedule the method call with Bottleneck's limiter
            const result = await limiter.schedule(() => originalMethod.apply(target, args));
            // On successful operation, increase the weight slightly
            const fullNodePeer = FullNodePeer.getInstance();
            const currentWeight = fullNodePeer.peerWeights.get(peerIP) || 1;
            fullNodePeer.peerWeights.set(peerIP, currentWeight + 0.1); // Increment weight
            return result;
          } catch (error: any) {
            console.error(`Peer ${peerIP} encountered an error: ${error.message}`);

            // Check if the error is related to WebSocket or Operation timed out
            if (
              error.message.includes("WebSocket") ||
              error.message.includes("Operation timed out")
            ) {
              // Handle the disconnection and mark the peer accordingly
              FullNodePeer.getInstance().handlePeerDisconnection(peerIP);

              // If maximum retries reached, throw the error
              if (retryCount >= MAX_RETRIES) {
                console.error(`Max retries reached for method ${String(prop)} on peer ${peerIP}.`);
                throw error;
              }

              // Attempt to select a new peer and retry the method
              try {
                console.info(`Selecting a new peer to retry method ${String(prop)}...`);
                const newPeer = await FullNodePeer.getInstance().getBestPeer();

                // Extract new peer's IP address
                const newPeerIP = FullNodePeer.getInstance().extractPeerIP(newPeer);

                if (!newPeerIP) {
                  throw new Error("Unable to extract IP from the new peer.");
                }

                // Wrap the new peer with a proxy, incrementing the retry count
                const proxiedNewPeer = createPeerProxy(newPeer, newPeerIP, retryCount + 1);

                // Retry the method on the new peer
                return await (proxiedNewPeer as any)[prop](...args);
              } catch (retryError: any) {
                console.error(`Retry failed on a new peer: ${retryError.message}`);
                throw retryError;
              }
            } else {
              // For other errors, handle normally
              throw error;
            }
          }
        };
      }
      return originalMethod;
    },
  }) as Peer;
}

/**
 * FullNodePeer manages connections to full nodes, prioritizing certain peers and handling reliability.
 * It implements a singleton pattern to ensure a single instance throughout the application.
 */
export class FullNodePeer {
  // Singleton instance
  private static instance: FullNodePeer | null = null;

  // Cached peer with timestamp
  private cachedPeer: { peer: Peer; timestamp: number } | null = null;

  // Cooldown cache to exclude faulty peers temporarily
  public cooldownCache = new NodeCache({ stdTTL: COOLDOWN_DURATION / 1000 });

  // Peer reliability weights
  public peerWeights: Map<string, number> = new Map();

  // List of prioritized peers
  private prioritizedPeers: string[] = [];

  // Map to store PeerInfo
  private peerInfos: Map<string, PeerInfo> = new Map();

  // Cache for fetched peer IPs
  private peerIPCache = new NodeCache({ stdTTL: CACHE_DURATION / 1000 });

  // List of available peers for round-robin
  private availablePeers: string[] = [];

  // Current index for round-robin selection
  private currentPeerIndex: number = 0;

  /**
   * Private constructor for singleton pattern.
   */
  private constructor() {}

  /**
   * Retrieves the singleton instance of FullNodePeer.
   * @returns {FullNodePeer} The singleton instance.
   */
  public static getInstance(): FullNodePeer {
    if (!FullNodePeer.instance) {
      FullNodePeer.instance = new FullNodePeer();
    }
    return FullNodePeer.instance;
  }

  /**
   * Initializes the singleton instance by connecting to the best peer.
   */
  public async initialize(): Promise<void> {
    if (this.cachedPeer) return; // Already initialized

    try {
      const bestPeer = await this.getBestPeer();
      this.cachedPeer = { peer: bestPeer, timestamp: Date.now() };
    } catch (error: any) {
      console.error(`Initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Connects and returns the best available peer.
   * Implements singleton behavior.
   * @returns {Promise<Peer>} The connected Peer instance.
   */
  public static async connect(): Promise<Peer> {
    const instance = FullNodePeer.getInstance();
    await instance.initialize();
    return instance.cachedPeer!.peer;
  }

  /**
   * Checks if a given port on a host is reachable.
   * @param {string} host - The host IP address.
   * @param {number} port - The port number.
   * @param {number} timeout - Connection timeout in milliseconds.
   * @returns {Promise<boolean>} Whether the port is reachable.
   */
  private isPortReachable(
    host: string,
    port: number,
    timeout = CONNECTION_TIMEOUT
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
        .setTimeout(timeout)
        .once("error", () => {
          socket.destroy();
          resolve(false);
        })
        .once("timeout", () => {
          socket.destroy();
          resolve(false);
        })
        .connect(port, host, () => {
          socket.end();
          resolve(true);
        });
    });
  }

  /**
   * Validates an IPv4 address.
   * @param {string} ip - The IP address to validate.
   * @returns {boolean} Whether the IP address is valid.
   */
  private isValidIpAddress(ip: string): boolean {
    const ipv4Regex =
      /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
    return ipv4Regex.test(ip);
  }

  /**
   * Retrieves the TRUSTED_FULLNODE IP from the environment and verifies its validity.
   * @returns {string | null} The trusted full node IP or null if invalid.
   */
  private getTrustedFullNode(): string | null {
    const trustedNodeIp = Environment.TRUSTED_FULLNODE || null;

    if (trustedNodeIp && this.isValidIpAddress(trustedNodeIp)) {
      return trustedNodeIp;
    }
    return null;
  }

  /**
   * Fetches new peer IPs from DNS introducers and prioritized hosts.
   * Utilizes caching to avoid redundant DNS resolutions.
   * @returns {Promise<string[]>} An array of reachable peer IPs.
   */
  private async fetchNewPeerIPs(): Promise<string[]> {
    const trustedNodeIp = this.getTrustedFullNode();
    const priorityIps: string[] = [];

    // Define prioritized peers
    this.prioritizedPeers = [CHIA_NODES_HOST, LOCALHOST];

    // Add trustedNodeIp if available
    if (trustedNodeIp) {
      this.prioritizedPeers.unshift(trustedNodeIp);
    }

    // Prioritize trustedNodeIp
    if (
      trustedNodeIp &&
      !this.cooldownCache.has(trustedNodeIp) &&
      (await this.isPortReachable(trustedNodeIp, FULLNODE_PORT))
    ) {
      priorityIps.push(trustedNodeIp);
    }

    // Prioritize LOCALHOST
    if (
      !this.cooldownCache.has(LOCALHOST) &&
      (await this.isPortReachable(LOCALHOST, FULLNODE_PORT))
    ) {
      priorityIps.push(LOCALHOST);
    }

    // Prioritize CHIA_NODES_HOST
    if (
      !this.cooldownCache.has(CHIA_NODES_HOST) &&
      (await this.isPortReachable(CHIA_NODES_HOST, FULLNODE_PORT))
    ) {
      priorityIps.push(CHIA_NODES_HOST);
    }

    if (priorityIps.length > 0) {
      return priorityIps;
    }

    // Check if cached peer IPs exist
    const cachedPeerIPs = this.peerIPCache.get<string[]>("peerIPs");
    if (cachedPeerIPs) {
      return cachedPeerIPs;
    }

    // Fetch peers from DNS introducers
    const fetchedPeers: string[] = [];
    for (const DNS_HOST of DNS_HOSTS) {
      try {
        const ips = await resolve4(DNS_HOST);
        if (ips && ips.length > 0) {
          const shuffledIps = this.shuffleArray(ips);
          const reachableIps: string[] = [];

          for (const ip of shuffledIps) {
            if (
              !this.cooldownCache.has(ip) &&
              (await this.isPortReachable(ip, FULLNODE_PORT))
            ) {
              reachableIps.push(ip);
            }
            if (reachableIps.length === MAX_PEERS_TO_FETCH) break; // Limit to MAX_PEERS_TO_FETCH peers
          }

          if (reachableIps.length > 0) {
            fetchedPeers.push(...reachableIps);
          }
        }
      } catch (error: any) {
        console.error(`Failed to resolve IPs from ${DNS_HOST}: ${error.message}`);
      }
    }

    // Cache the fetched peer IPs
    if (fetchedPeers.length > 0) {
      this.peerIPCache.set("peerIPs", fetchedPeers);
      return fetchedPeers;
    }

    throw new Error("No reachable IPs found in any DNS records.");
  }

  /**
   * Shuffles an array using the Fisher-Yates algorithm.
   * @param {T[]} array - The array to shuffle.
   * @returns {T[]} The shuffled array.
   */
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Initializes the peer weights map.
   * Assigns higher initial weights to prioritized peers.
   * @param {string[]} peerIPs - An array of peer IPs.
   */
  private initializePeerWeights(peerIPs: string[]): void {
    for (const ip of peerIPs) {
      if (!this.peerWeights.has(ip)) {
        if (
          ip === CHIA_NODES_HOST ||
          ip === LOCALHOST ||
          ip === this.getTrustedFullNode()
        ) {
          this.peerWeights.set(ip, 5); // Higher weight for prioritized peers
        } else {
          this.peerWeights.set(ip, 1); // Default weight
        }
      }
    }
  }

  /**
   * Selects the next peer based on round-robin selection.
   * @returns {Promise<Peer>} The selected Peer instance.
   */
  private async selectNextPeer(): Promise<Peer> {
    if (this.availablePeers.length === 0) {
      throw new Error("No available peers to select.");
    }

    const peerIP = this.availablePeers[this.currentPeerIndex];
    this.currentPeerIndex = (this.currentPeerIndex + 1) % this.availablePeers.length;
    const peerInfo = this.peerInfos.get(peerIP)!;
    return peerInfo.peer;
  }

  /**
   * Retrieves all reachable peer IPs, excluding those in cooldown.
   * @returns {Promise<string[]>} An array of reachable peer IPs.
   */
  private async getPeerIPs(): Promise<string[]> {
    const peerIPs = await this.fetchNewPeerIPs();
    return peerIPs;
  }

  /**
   * Initializes the peer weights based on prioritization and reliability.
   * @param {string[]} peerIPs - An array of peer IPs.
   */
  private setupPeers(peerIPs: string[]): void {
    this.initializePeerWeights(peerIPs);
  }

  /**
   * Connects to the best available peer based on round-robin selection and reliability.
   * @returns {Promise<Peer>} The connected Peer instance.
   */
  public async getBestPeer(): Promise<Peer> {
    const now = Date.now();

    // Refresh cachedPeer if expired or disconnected
    if (
      this.cachedPeer &&
      now - this.cachedPeer.timestamp < CACHE_DURATION &&
      this.peerInfos.get(this.extractPeerIP(this.cachedPeer.peer) || "")?.isConnected
    ) {
      return this.cachedPeer.peer;
    }

    // Fetch peer IPs
    const peerIPs = await this.getPeerIPs();

    // Setup peer weights with prioritization
    this.setupPeers(peerIPs);

    // Initialize or update peerInfos and availablePeers
    for (const ip of peerIPs) {
      if (!this.peerInfos.has(ip)) {
        // Attempt to create a peer connection
        const sslFolder = path.resolve(os.homedir(), ".dig", "ssl");
        const certFile = path.join(sslFolder, "public_dig.crt");
        const keyFile = path.join(sslFolder, "public_dig.key");

        if (!fs.existsSync(sslFolder)) {
          fs.mkdirSync(sslFolder, { recursive: true });
        }

        const tls = new Tls(certFile, keyFile);

        let peer: Peer;
        try {
          peer = await Peer.new(`${ip}:${FULLNODE_PORT}`, false, tls);
        } catch (error: any) {
          console.error(`Failed to create peer for IP ${ip}: ${error.message}`);
          // Add to cooldown
          this.cooldownCache.set(ip, true);
          // Decrease weight or remove peer
          const currentWeight = this.peerWeights.get(ip) || 1;
          if (currentWeight > 1) {
            this.peerWeights.set(ip, currentWeight - 1);
          } else {
            this.peerWeights.delete(ip);
          }
          continue; // Skip adding this peer
        }

        // Wrap the peer with proxy to handle errors and retries
        const proxiedPeer = createPeerProxy(peer, ip);

        // Store PeerInfo
        this.peerInfos.set(ip, {
          peer: proxiedPeer,
          weight: this.peerWeights.get(ip) || 1,
          address: ip,
          isConnected: true, // Mark as connected
          limiter: (proxiedPeer as any).limiter, // Assign the limiter from Proxy
        });

        // Add to availablePeers
        this.availablePeers.push(ip);
      } else {
        const peerInfo = this.peerInfos.get(ip)!;
        if (!peerInfo.isConnected) {
          // Peer is back from cooldown, re-establish connection
          const sslFolder = path.resolve(os.homedir(), ".dig", "ssl");
          const certFile = path.join(sslFolder, "public_dig.crt");
          const keyFile = path.join(sslFolder, "public_dig.key");

          if (!fs.existsSync(sslFolder)) {
            fs.mkdirSync(sslFolder, { recursive: true });
          }

          const tls = new Tls(certFile, keyFile);

          let peer: Peer;
          try {
            peer = await Peer.new(`${ip}:${FULLNODE_PORT}`, false, tls);
          } catch (error: any) {
            console.error(`Failed to reconnect peer for IP ${ip}: ${error.message}`);
            // Re-add to cooldown
            this.cooldownCache.set(ip, true);
            // Decrease weight or remove peer
            const currentWeight = this.peerWeights.get(ip) || 1;
            if (currentWeight > 1) {
              this.peerWeights.set(ip, currentWeight - 1);
            } else {
              this.peerWeights.delete(ip);
            }
            continue; // Skip adding this peer
          }

          // Wrap the peer with proxy to handle errors and retries
          const proxiedPeer = createPeerProxy(peer, ip);

          // Update PeerInfo
          peerInfo.peer = proxiedPeer;
          peerInfo.isConnected = true;

          // Add back to availablePeers
          this.availablePeers.push(ip);
        }
      }
    }

    if (this.availablePeers.length === 0) {
      throw new Error("No available peers to connect.");
    }

    // Select the next peer in round-robin
    const selectedPeer = await this.selectNextPeer();

    // Cache the peer
    this.cachedPeer = { peer: selectedPeer, timestamp: now };

    console.log(`Using Fullnode Peer: ${this.extractPeerIP(selectedPeer)}`);

    return selectedPeer;
  }

  /**
   * Handles peer disconnection by marking it in cooldown and updating internal states.
   * @param {string} peerIP - The IP address of the disconnected peer.
   */
  public handlePeerDisconnection(peerIP: string): void {
    // Mark the peer in cooldown
    this.cooldownCache.set(peerIP, true);

    // Decrease weight or remove peer
    const currentWeight = this.peerWeights.get(peerIP) || 1;
    if (currentWeight > 1) {
      this.peerWeights.set(peerIP, currentWeight - 1);
    } else {
      this.peerWeights.delete(peerIP);
    }

    // Update the peer's connection status
    const peerInfo = this.peerInfos.get(peerIP);
    if (peerInfo) {
      peerInfo.isConnected = false;
      this.peerInfos.set(peerIP, peerInfo);
    }

    // Remove from availablePeers if present
    const index = this.availablePeers.indexOf(peerIP);
    if (index !== -1) {
      this.availablePeers.splice(index, 1);
      // Adjust currentPeerIndex if necessary
      if (this.currentPeerIndex >= this.availablePeers.length) {
        this.currentPeerIndex = 0;
      }
    }

    // If the disconnected peer was the cached peer, invalidate the cache
    if (
      this.cachedPeer &&
      this.extractPeerIP(this.cachedPeer.peer) === peerIP
    ) {
      this.cachedPeer = null;
    }

    console.warn(`Peer ${peerIP} has been marked as disconnected and is in cooldown.`);
  }

  /**
   * Extracts the IP address from a Peer instance.
   * @param {Peer} peer - The Peer instance.
   * @returns {string | null} The extracted IP address or null if not found.
   */
  public extractPeerIP(peer: Peer): string | null {
    for (const [ip, info] of this.peerInfos.entries()) {
      if (info.peer === peer) {
        return ip;
      }
    }
    return null;
  }

  /**
   * Waits for a coin to be confirmed (spent) on the blockchain.
   * @param {Buffer} parentCoinInfo - The parent coin information.
   * @returns {Promise<boolean>} Whether the coin was confirmed.
   */
  public async waitForConfirmation(
    parentCoinInfo: Buffer
  ): Promise<boolean> {
    const spinner = createSpinner("Waiting for confirmation...").start();
    let peer: Peer;

    try {
      peer = await this.getBestPeer();
    } catch (error: any) {
      spinner.error({ text: "Failed to connect to a peer." });
      console.error(`waitForConfirmation connection error: ${error.message}`);
      throw error;
    }

    try {
      while (true) {
        const confirmed = await (peer as any).isCoinSpent(
          parentCoinInfo,
          MIN_HEIGHT,
          Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
        );

        if (confirmed) {
          spinner.success({ text: "Coin confirmed!" });
          return true;
        }

        await FullNodePeer.delay(5000);
      }
    } catch (error: any) {
      spinner.error({ text: "Error while waiting for confirmation." });
      console.error(`waitForConfirmation error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delays execution for a specified amount of time.
   * @param {number} ms - Milliseconds to delay.
   * @returns {Promise<void>} A promise that resolves after the delay.
   */
  public static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}