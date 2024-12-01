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

const FULLNODE_PORT = 8444;
const LOCALHOST = "127.0.0.1";
const DNS_HOSTS = [
  "dns-introducer.chia.net",
  "chia.ctrlaltdel.ch",
  "seeder.dexie.space",
  "chia.hoffmang.com",
];
const CONNECTION_TIMEOUT = 2000; // in milliseconds
const CACHE_DURATION = 30000; // in milliseconds
const COOLDOWN_DURATION = 600000; // 10 minutes in milliseconds
const MAX_PEERS_TO_FETCH = 5; // Maximum number of peers to fetch from DNS
const MAX_REQUESTS_PER_MINUTE = 100; // Per-peer rate limit

/**
 * Represents a peer with its reliability weight and address.
 */
interface PeerInfo {
  peer: Peer;
  weight: number;
  address: string;
}

/**
 * FullNodePeer manages connections to full nodes, prioritizing certain peers and handling reliability.
 */
export class FullNodePeer {
  // Singleton instance
  private static instance: FullNodePeer | null = null;

  // Cooldown cache to exclude faulty peers temporarily
  private static cooldownCache = new NodeCache({
    stdTTL: COOLDOWN_DURATION / 1000,
  });

  // Failed DNS hosts cooldown cache
  private static failedDNSCache = new NodeCache({ stdTTL: 86400 });

  // Peer reliability weights
  private static peerWeights: Map<string, number> = new Map();

  // List of prioritized peers
  private static prioritizedPeers: string[] = [];

  // Map to store PeerInfo
  private static peerInfos: Map<string, PeerInfo> = new Map();

  // Cache for fetched peer IPs
  private static peerIPCache = new NodeCache({ stdTTL: CACHE_DURATION / 1000 });

  // Cache for DNS_HOST resolved IPs with a TTL of 3 days (259200 seconds)
  private static dnsCache = new NodeCache({
    stdTTL: 259200,
    checkperiod: 3600,
  });

  // Map to store rate limiters per peer IP
  private static peerLimiters: Map<string, Bottleneck> = new Map();

  // Round-robin index
  private static roundRobinIndex: number = 0;

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
      const bestPeer = await this.getBestPeer();
      this.peer = bestPeer;
      FullNodePeer.instance = this; // Assign the initialized instance
    } catch (error: any) {
      console.error(`Fullnode Initialization failed: ${error.message}`);
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
    // Remove cached peer to ensure a new connection each time
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
    FullNodePeer.prioritizedPeers = [LOCALHOST];

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

    if (priorityIps.length > 0) {
      return priorityIps;
    }

    // Check if cached peer IPs exist
    const cachedPeerIPs = await FullNodePeer.peerIPCache.get<string[]>(
      "peerIPs"
    );
    if (cachedPeerIPs) {
      return cachedPeerIPs;
    }

    // Fetch peers from DNS introducers
    const fetchedPeers: string[] = [];
    for (const DNS_HOST of DNS_HOSTS) {
      // Check if DNS_HOST is in failedDNSCache
      if (await FullNodePeer.failedDNSCache.has(DNS_HOST)) {
        continue;
      }

      try {
        let ips: string[] = [];

        // Check if DNS_HOST's IPs are cached
        if (await FullNodePeer.dnsCache.has(DNS_HOST)) {
          ips = (await FullNodePeer.dnsCache.get<string[]>(DNS_HOST)) || [];
        } else {
          // Resolve DNS_HOST and cache the results
          ips = await resolve4(DNS_HOST);
          if (ips && ips.length > 0) {
            FullNodePeer.dnsCache.set(DNS_HOST, ips);
          }
        }

        if (ips.length > 0) {
          const shuffledIps = FullNodePeer.shuffleArray(ips);
          const reachableIps: string[] = [];

          for (const ip of shuffledIps) {
            if (
              !FullNodePeer.cooldownCache.has(ip) &&
              FullNodePeer.isValidIpAddress(ip) &&
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
        // Add DNS_HOST to failedDNSCache for cooldown
        FullNodePeer.failedDNSCache.set(DNS_HOST, true);
      }
    }

    // Cache the fetched peer IPs if any
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
        if (ip === LOCALHOST || ip === FullNodePeer.getTrustedFullNode()) {
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
  private static selectPeerRoundRobin(): string {
    const availablePrioritizedPeers = FullNodePeer.prioritizedPeers.filter(
      (ip) =>
        !FullNodePeer.cooldownCache.has(ip) && FullNodePeer.peerWeights.has(ip)
    );

    if (availablePrioritizedPeers.length > 0) {
      // Select the first available prioritized peer
      return availablePrioritizedPeers[0];
    }

    // If no prioritized peers are available, proceed with round-robin among other peers
    const regularPeers = Array.from(FullNodePeer.peerWeights.keys()).filter(
      (ip) =>
        !FullNodePeer.prioritizedPeers.includes(ip) &&
        !FullNodePeer.cooldownCache.has(ip)
    );

    if (regularPeers.length === 0) {
      throw new Error("No available peers to connect.");
    }

    const selectedPeer =
      regularPeers[FullNodePeer.roundRobinIndex % regularPeers.length];
    FullNodePeer.roundRobinIndex += 1;
    return selectedPeer;
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
  private async getBestPeer(): Promise<Peer> {
    const now = Date.now();

    // Removed cachedPeer logic to ensure a new connection each time

    // Fetch peer IPs
    const peerIPs = await FullNodePeer.getPeerIPs();

    // Setup peer weights with prioritization
    FullNodePeer.setupPeers(peerIPs);

    // Round-robin selection
    let selectedPeerIP: string;
    try {
      selectedPeerIP = FullNodePeer.selectPeerRoundRobin();
    } catch (error: any) {
      throw new Error(`Failed to select a fullnode peer: ${error.message}`);
    }

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
      peer = await Peer.new(`${selectedPeerIP}:${FULLNODE_PORT}`, false, tls);
    } catch (error: any) {
      console.error(
        `Failed to create fullnode peer for IP ${selectedPeerIP}: ${error.message}`
      );
      // Add to cooldown
      FullNodePeer.cooldownCache.set(selectedPeerIP, true);
      // Decrease weight or remove peer
      const currentWeight = FullNodePeer.peerWeights.get(selectedPeerIP) || 1;
      if (currentWeight > 1) {
        FullNodePeer.peerWeights.set(selectedPeerIP, currentWeight - 1);
      } else {
        FullNodePeer.peerWeights.delete(selectedPeerIP);
      }
      throw new Error(`Unable to connect to fullnode peer ${selectedPeerIP}`);
    }

    // Create a Bottleneck limiter for this peer
    const limiter = new Bottleneck({
      maxConcurrent: 1, // One request at a time per peer
      minTime: 60000 / MAX_REQUESTS_PER_MINUTE, // e.g., 600 ms between requests for 100 requests/min
    });

    // Store PeerInfo
    FullNodePeer.peerInfos.set(selectedPeerIP, {
      peer: peer,
      weight: FullNodePeer.peerWeights.get(selectedPeerIP) || 1,
      address: selectedPeerIP,
    });

    // Initialize rate limiter for this peer
    FullNodePeer.peerLimiters.set(selectedPeerIP, limiter);
    const proxiedPeer = this.createPeerProxy(peer, selectedPeerIP);

    console.log(`Using Fullnode Peer: ${selectedPeerIP}`);

    return proxiedPeer;
  }

  private createPeerProxy(peer: Peer, peerIP: string): Peer {
    return new Proxy(peer, {
      get: (target, prop) => {
        const originalMethod = (target as any)[prop];

        if (typeof originalMethod === "function") {
          return async (...args: any[]) => {
            let timeoutId: NodeJS.Timeout | undefined;

            // Start the timeout to forget the peer after 1 minute
            const timeoutPromise = new Promise<null>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(
                  new Error(
                    "Operation timed out. Reconnecting to a new fullnode peer."
                  )
                );
              }, 60000); // 1 minute
            });

            try {
              // Run the original method and race it against the timeout
              const result = await Promise.race([
                originalMethod.apply(target, args),
                timeoutPromise,
              ]);

              // Clear the timeout if the operation succeeded
              if (timeoutId) {
                clearTimeout(timeoutId);
              }

              return result;
            } catch (error: any) {
              FullNodePeer.handlePeerDisconnection(peerIP);

              // If the error is WebSocket-related or timeout, reset the peer
              if (
                error.message.includes("WebSocket") ||
                error.message.includes("Operation timed out")
              ) {
                console.log('Running getBestPeer from createPeerProxy...')
                const newPeer = await this.getBestPeer();
                return (newPeer as any)[prop](...args);
              }
              throw error;
            }
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
  public static handlePeerDisconnection(peerIP: string): void {
    // Add the faulty peer to the cooldown cache
    FullNodePeer.cooldownCache.set(peerIP, true);

    // Decrease weight or remove peer
    const currentWeight = FullNodePeer.peerWeights.get(peerIP) || 1;
    if (currentWeight > 1) {
      FullNodePeer.peerWeights.set(peerIP, currentWeight - 1);
    } else {
      FullNodePeer.peerWeights.delete(peerIP);
    }

    // Remove from peerInfos
    FullNodePeer.peerInfos.delete(peerIP);

    // Remove the limiter
    FullNodePeer.peerLimiters.delete(peerIP);
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
    const peer = await FullNodePeer.connect();
    while (true) {
      try {
        await peer.waitForCoinToBeSpent(
          parentCoinInfo,
          MIN_HEIGHT,
          Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
        );

        spinner.success({ text: "Coin confirmed!" });
        return true;
      } catch (error: any) {
        if (error.message.includes("UnknownCoin")) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          spinner.error({ text: "Error while waiting for confirmation." });
          console.error(`waitForConfirmation error: ${error.message}`);
          throw error;
        }
      }
    }
  }
}
