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

// Constants
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
 * Represents a peer with its reliability weight, address, and rate limiter.
 */
interface PeerInfo {
  peer: Peer;
  weight: number;
  address: string;
  isConnected: boolean; // Indicates if the peer is currently connected
  limiter: Bottleneck; // Rate limiter for the peer
}

/**
 * FullNodePeer manages connections to full nodes, prioritizing certain peers and handling reliability.
 */
export class FullNodePeer {
  // Singleton instance
  private static instance: FullNodePeer | null = null;

  // Cached peer with timestamp
  private static cachedPeer: { peer: Peer; timestamp: number } | null = null;

  // Cooldown cache to exclude faulty peers temporarily
  private static cooldownCache = new NodeCache({ stdTTL: COOLDOWN_DURATION / 1000 });

  // Peer reliability weights
  private static peerWeights: Map<string, number> = new Map();

  // List of prioritized peers
  private static prioritizedPeers: string[] = [];

  // Map to store PeerInfo
  private static peerInfos: Map<string, PeerInfo> = new Map();

  // Cache for fetched peer IPs
  private static peerIPCache = new NodeCache({ stdTTL: CACHE_DURATION / 1000 });

  // List of available peers for round-robin
  private static availablePeers: string[] = [];

  // Current index for round-robin selection
  private static currentPeerIndex: number = 0;

  // Private constructor for singleton pattern
  private constructor(private peer: Peer) {}

  /**
   * Retrieves the singleton instance of FullNodePeer.
   * @returns {FullNodePeer} The singleton instance.
   */
  public static getInstance(): FullNodePeer {
    if (!FullNodePeer.instance) {
      FullNodePeer.instance = new FullNodePeer(null as any); // Temporarily set to null
    }
    return FullNodePeer.instance;
  }

  /**
   * Initializes the singleton instance by connecting to the best peer.
   */
  public async initialize(): Promise<void> {
    if (this.peer) return; // Already initialized

    try {
      const bestPeer = await FullNodePeer.getBestPeer();
      this.peer = bestPeer;
      FullNodePeer.instance = this; // Assign the initialized instance
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
    return instance.peer;
  }

  /**
   * Checks if a given port on a host is reachable.
   * @param {string} host - The host IP address.
   * @param {number} port - The port number.
   * @param {number} timeout - Connection timeout in milliseconds.
   * @returns {Promise<boolean>} Whether the port is reachable.
   */
  private static isPortReachable(
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
  private static isValidIpAddress(ip: string): boolean {
    const ipv4Regex =
      /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
    return ipv4Regex.test(ip);
  }

  /**
   * Retrieves the TRUSTED_FULLNODE IP from the environment and verifies its validity.
   * @returns {string | null} The trusted full node IP or null if invalid.
   */
  private static getTrustedFullNode(): string | null {
    const trustedNodeIp = Environment.TRUSTED_FULLNODE || null;

    if (trustedNodeIp && FullNodePeer.isValidIpAddress(trustedNodeIp)) {
      return trustedNodeIp;
    }
    return null;
  }

  /**
   * Fetches new peer IPs from DNS introducers and prioritized hosts.
   * Utilizes caching to avoid redundant DNS resolutions.
   * @returns {Promise<string[]>} An array of reachable peer IPs.
   */
  private static async fetchNewPeerIPs(): Promise<string[]> {
    const trustedNodeIp = FullNodePeer.getTrustedFullNode();
    const priorityIps: string[] = [];

    // Define prioritized peers
    FullNodePeer.prioritizedPeers = [
      ...DNS_HOSTS, // Assuming CHIA_NODES_HOST is included in DNS_HOSTS
      LOCALHOST,
    ];

    // Add trustedNodeIp if available
    if (trustedNodeIp) {
      FullNodePeer.prioritizedPeers.unshift(trustedNodeIp);
    }

    // Prioritize trustedNodeIp
    if (
      trustedNodeIp &&
      !FullNodePeer.cooldownCache.has(trustedNodeIp) &&
      (await FullNodePeer.isPortReachable(trustedNodeIp, FULLNODE_PORT))
    ) {
      priorityIps.push(trustedNodeIp);
    }

    // Prioritize LOCALHOST
    if (
      !FullNodePeer.cooldownCache.has(LOCALHOST) &&
      (await FullNodePeer.isPortReachable(LOCALHOST, FULLNODE_PORT))
    ) {
      priorityIps.push(LOCALHOST);
    }

    // Prioritize CHIA_NODES_HOST
    if (
      !FullNodePeer.cooldownCache.has(CHIA_NODES_HOST) &&
      (await FullNodePeer.isPortReachable(CHIA_NODES_HOST, FULLNODE_PORT))
    ) {
      priorityIps.push(CHIA_NODES_HOST);
    }

    if (priorityIps.length > 0) {
      return priorityIps;
    }

    // Check if cached peer IPs exist
    const cachedPeerIPs = FullNodePeer.peerIPCache.get<string[]>("peerIPs");
    if (cachedPeerIPs) {
      return cachedPeerIPs;
    }

    // Fetch peers from DNS introducers
    const fetchedPeers: string[] = [];
    for (const DNS_HOST of DNS_HOSTS) {
      try {
        const ips = await resolve4(DNS_HOST);
        if (ips && ips.length > 0) {
          const shuffledIps = FullNodePeer.shuffleArray(ips);
          const reachableIps: string[] = [];

          for (const ip of shuffledIps) {
            if (
              !FullNodePeer.cooldownCache.has(ip) &&
              (await FullNodePeer.isPortReachable(ip, FULLNODE_PORT))
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
        console.error(
          `Failed to resolve IPs from ${DNS_HOST}: ${error.message}`
        );
      }
    }

    // Cache the fetched peer IPs
    if (fetchedPeers.length > 0) {
      FullNodePeer.peerIPCache.set("peerIPs", fetchedPeers);
      return fetchedPeers;
    }

    throw new Error("No reachable IPs found in any DNS records.");
  }

  /**
   * Shuffles an array using the Fisher-Yates algorithm.
   * @param {T[]} array - The array to shuffle.
   * @returns {T[]} The shuffled array.
   */
  private static shuffleArray<T>(array: T[]): T[] {
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
  private static initializePeerWeights(peerIPs: string[]): void {
    for (const ip of peerIPs) {
      if (!FullNodePeer.peerWeights.has(ip)) {
        if (
          ip === CHIA_NODES_HOST ||
          ip === LOCALHOST ||
          ip === FullNodePeer.getTrustedFullNode()
        ) {
          FullNodePeer.peerWeights.set(ip, 5); // Higher weight for prioritized peers
        } else {
          FullNodePeer.peerWeights.set(ip, 1); // Default weight
        }
      }
    }
  }

  /**
   * Selects the next peer based on round-robin selection.
   * @returns {string} The selected peer IP.
   */
  private static getNextPeerIP(): string {
    if (FullNodePeer.availablePeers.length === 0) {
      throw new Error("No available peers to select.");
    }
    const peerIP = FullNodePeer.availablePeers[FullNodePeer.currentPeerIndex];
    FullNodePeer.currentPeerIndex = (FullNodePeer.currentPeerIndex + 1) % FullNodePeer.availablePeers.length;
    return peerIP;
  }

  /**
   * Retrieves all reachable peer IPs, excluding those in cooldown.
   * @returns {Promise<string[]>} An array of reachable peer IPs.
   */
  private static async getPeerIPs(): Promise<string[]> {
    const peerIPs = await FullNodePeer.fetchNewPeerIPs();
    return peerIPs;
  }

  /**
   * Initializes the peer weights based on prioritization and reliability.
   * @param {string[]} peerIPs - An array of peer IPs.
   */
  private static setupPeers(peerIPs: string[]): void {
    FullNodePeer.initializePeerWeights(peerIPs);
  }

  /**
   * Connects to the best available peer based on round-robin selection and reliability.
   * @returns {Promise<Peer>} The connected Peer instance.
   */
  private static async getBestPeer(): Promise<Peer> {
    const now = Date.now();

    // Refresh cachedPeer if expired or disconnected
    if (
      FullNodePeer.cachedPeer &&
      now - FullNodePeer.cachedPeer.timestamp < CACHE_DURATION &&
      FullNodePeer.peerInfos.get(FullNodePeer.extractPeerIP(FullNodePeer.cachedPeer.peer) || "")?.isConnected
    ) {
      return FullNodePeer.cachedPeer.peer;
    }

    // Fetch peer IPs
    const peerIPs = await FullNodePeer.getPeerIPs();

    // Setup peer weights with prioritization
    FullNodePeer.setupPeers(peerIPs);

    // Initialize or update peerInfos and availablePeers
    for (const ip of peerIPs) {
      if (!FullNodePeer.peerInfos.has(ip)) {
        // Create a new Bottleneck limiter for the peer
        const limiter = new Bottleneck({
          maxConcurrent: 1, // One request at a time per peer
          minTime: 60000 / MAX_REQUESTS_PER_MINUTE, // 600 ms between requests for 100 requests/min
        });

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
          FullNodePeer.cooldownCache.set(ip, true);
          // Decrease weight or remove peer
          const currentWeight = FullNodePeer.peerWeights.get(ip) || 1;
          if (currentWeight > 1) {
            FullNodePeer.peerWeights.set(ip, currentWeight - 1);
          } else {
            FullNodePeer.peerWeights.delete(ip);
          }
          continue; // Skip adding this peer
        }

        // Wrap the peer with proxy to handle errors and retries
        const proxiedPeer = FullNodePeer.createPeerProxy(peer, ip);

        // Store PeerInfo
        FullNodePeer.peerInfos.set(ip, {
          peer: proxiedPeer,
          weight: FullNodePeer.peerWeights.get(ip) || 1,
          address: ip,
          isConnected: true, // Mark as connected
          limiter, // Assign the limiter
        });

        // Add to availablePeers
        FullNodePeer.availablePeers.push(ip);
      } else {
        const peerInfo = FullNodePeer.peerInfos.get(ip)!;
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
            FullNodePeer.cooldownCache.set(ip, true);
            // Decrease weight or remove peer
            const currentWeight = FullNodePeer.peerWeights.get(ip) || 1;
            if (currentWeight > 1) {
              FullNodePeer.peerWeights.set(ip, currentWeight - 1);
            } else {
              FullNodePeer.peerWeights.delete(ip);
            }
            continue; // Skip adding this peer
          }

          // Wrap the peer with proxy to handle errors and retries
          const proxiedPeer = FullNodePeer.createPeerProxy(peer, ip);

          // Update PeerInfo
          peerInfo.peer = proxiedPeer;
          peerInfo.isConnected = true;

          // Add back to availablePeers
          FullNodePeer.availablePeers.push(ip);
        }
      }
    }

    if (FullNodePeer.availablePeers.length === 0) {
      throw new Error("No available peers to connect.");
    }

    // Select the next peer in round-robin
    const selectedPeerIP = FullNodePeer.getNextPeerIP();
    const selectedPeerInfo = FullNodePeer.peerInfos.get(selectedPeerIP)!;

    // Cache the peer
    FullNodePeer.cachedPeer = { peer: selectedPeerInfo.peer, timestamp: now };

    console.log(`Using Fullnode Peer: ${selectedPeerIP}`);

    return selectedPeerInfo.peer;
  }

  /**
   * Creates a proxy for the peer to handle errors, implement retries, and enforce per-peer throttling.
   * @param {Peer} peer - The Peer instance.
   * @param {string} peerIP - The IP address of the peer.
   * @param {number} [retryCount=0] - The current retry attempt.
   * @returns {Peer} The proxied Peer instance.
   */
  private static createPeerProxy(peer: Peer, peerIP: string, retryCount: number = 0): Peer {
    // Listen for close events if the Peer class supports it
    // This assumes that the Peer class emits a 'close' event when the connection is closed
    // Adjust accordingly based on the actual Peer implementation
    if (typeof (peer as any).on === "function") {
      (peer as any).on("close", () => {
        console.warn(`Peer ${peerIP} connection closed.`);
        FullNodePeer.handlePeerDisconnection(peerIP);
      });

      (peer as any).on("error", (error: any) => {
        console.error(`Peer ${peerIP} encountered an error: ${error.message}`);
        FullNodePeer.handlePeerDisconnection(peerIP);
      });
    }

    return new Proxy(peer, {
      get: (target, prop) => {
        const originalMethod = (target as any)[prop];

        if (typeof originalMethod === "function") {
          return (...args: any[]) => {
            // Select the next peer in round-robin
            let selectedPeerIP: string;
            try {
              selectedPeerIP = FullNodePeer.getNextPeerIP();
            } catch (error: any) {
              return Promise.reject(error);
            }

            const selectedPeerInfo = FullNodePeer.peerInfos.get(selectedPeerIP)!;

            // Schedule the method call via the selected peer's limiter
            return selectedPeerInfo.limiter.schedule(async () => {
              const peerInfo = FullNodePeer.peerInfos.get(selectedPeerIP);
              if (!peerInfo || !peerInfo.isConnected) {
                throw new Error(`Cannot perform operation: Peer ${selectedPeerIP} is disconnected.`);
              }

              try {
                // Bind the original method to the peer instance to preserve 'this'
                const boundMethod = originalMethod.bind(peerInfo.peer);
                const result = await boundMethod(...args);
                // On successful operation, increase the weight slightly
                const currentWeight = FullNodePeer.peerWeights.get(selectedPeerIP) || 1;
                FullNodePeer.peerWeights.set(selectedPeerIP, currentWeight + 0.1); // Increment weight
                return result;
              } catch (error: any) {
                console.error(`Peer ${selectedPeerIP} encountered an error: ${error.message}`);

                // Check if the error is related to WebSocket or Operation timed out
                if (
                  error.message.includes("WebSocket") ||
                  error.message.includes("Operation timed out")
                ) {
                  // Handle the disconnection and mark the peer accordingly
                  FullNodePeer.handlePeerDisconnection(selectedPeerIP);

                  // If maximum retries reached, throw the error
                  if (retryCount >= MAX_RETRIES) {
                    console.error(`Max retries reached for method ${String(prop)} on peer ${selectedPeerIP}.`);
                    throw error;
                  }

                  // Attempt to select a new peer and retry the method
                  try {
                    console.info(`Selecting a new peer to retry method ${String(prop)}...`);
                    const newPeer = await FullNodePeer.getBestPeer();

                    // Extract new peer's IP address
                    const newPeerIP = FullNodePeer.extractPeerIP(newPeer);

                    if (!newPeerIP) {
                      throw new Error("Unable to extract IP from the new peer.");
                    }

                    // Wrap the new peer with a proxy, incrementing the retry count
                    const proxiedNewPeer = FullNodePeer.createPeerProxy(newPeer, newPeerIP, retryCount + 1);

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
            });
          };
        }
        return originalMethod;
      },
    });
  }

  /**
   * Handles peer disconnection by marking it in cooldown and updating internal states.
   * @param {string} peerIP - The IP address of the disconnected peer.
   */
  private static handlePeerDisconnection(peerIP: string): void {
    // Mark the peer in cooldown
    FullNodePeer.cooldownCache.set(peerIP, true);

    // Decrease weight or remove peer
    const currentWeight = FullNodePeer.peerWeights.get(peerIP) || 1;
    if (currentWeight > 1) {
      FullNodePeer.peerWeights.set(peerIP, currentWeight - 1);
    } else {
      FullNodePeer.peerWeights.delete(peerIP);
    }

    // Update the peer's connection status
    const peerInfo = FullNodePeer.peerInfos.get(peerIP);
    if (peerInfo) {
      peerInfo.isConnected = false;
      FullNodePeer.peerInfos.set(peerIP, peerInfo);
    }

    // Remove from availablePeers if present
    const index = FullNodePeer.availablePeers.indexOf(peerIP);
    if (index !== -1) {
      FullNodePeer.availablePeers.splice(index, 1);
      // Adjust currentPeerIndex if necessary
      if (FullNodePeer.currentPeerIndex >= FullNodePeer.availablePeers.length) {
        FullNodePeer.currentPeerIndex = 0;
      }
    }

    // If the disconnected peer was the cached peer, invalidate the cache
    if (
      FullNodePeer.cachedPeer &&
      FullNodePeer.extractPeerIP(FullNodePeer.cachedPeer.peer) === peerIP
    ) {
      FullNodePeer.cachedPeer = null;
    }

    console.warn(`Peer ${peerIP} has been marked as disconnected and is in cooldown.`);
  }

  /**
   * Extracts the IP address from a Peer instance.
   * @param {Peer} peer - The Peer instance.
   * @returns {string | null} The extracted IP address or null if not found.
   */
  private static extractPeerIP(peer: Peer): string | null {
    for (const [ip, info] of FullNodePeer.peerInfos.entries()) {
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
  public static async waitForConfirmation(
    parentCoinInfo: Buffer
  ): Promise<boolean> {
    const spinner = createSpinner("Waiting for confirmation...").start();
    let peer: Peer;

    try {
      peer = await FullNodePeer.connect();
    } catch (error: any) {
      spinner.error({ text: "Failed to connect to a peer." });
      console.error(`waitForConfirmation connection error: ${error.message}`);
      throw error;
    }

    try {
      while (true) {
        const confirmed = await peer.isCoinSpent(
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
  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
