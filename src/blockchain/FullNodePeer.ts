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
const COOLDOWN_DURATION = 60000; // in milliseconds
const MAX_PEERS_TO_FETCH = 5; // Maximum number of peers to fetch from DNS
const MAX_RETRIES = 3; // Maximum number of retry attempts
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

  // Map to store rate limiters per peer IP
  private static peerLimiters: Map<string, Bottleneck> = new Map();

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
    FullNodePeer.prioritizedPeers = [CHIA_NODES_HOST, LOCALHOST];

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
        console.error(`Failed to resolve IPs from ${DNS_HOST}: ${error.message}`);
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
   * Selects a peer based on weighted random selection.
   * Prioritized peers have higher weights.
   * @returns {string} The selected peer IP.
   */
  private static selectPeerByWeight(): string {
    const peers = Array.from(FullNodePeer.peerWeights.entries())
      .filter(([ip, _]) => !FullNodePeer.cooldownCache.has(ip))
      .map(([ip, weight]) => ({ ip, weight }));

    const totalWeight = peers.reduce((sum, peer) => sum + peer.weight, 0);
    if (totalWeight === 0) {
      throw new Error("All peers are in cooldown.");
    }

    const random = Math.random() * totalWeight;
    let cumulative = 0;

    for (const peer of peers) {
      cumulative += peer.weight;
      if (random < cumulative) {
        return peer.ip;
      }
    }

    // Fallback
    return peers[peers.length - 1].ip;
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
   * Connects to the best available peer based on weighted selection and reliability.
   * @returns {Promise<Peer>} The connected Peer instance.
   */
  private static async getBestPeer(): Promise<Peer> {
    const now = Date.now();

    // Refresh cachedPeer if expired
    if (
      FullNodePeer.cachedPeer &&
      now - FullNodePeer.cachedPeer.timestamp < CACHE_DURATION
    ) {
      return FullNodePeer.cachedPeer.peer;
    }

    // Fetch peer IPs
    const peerIPs = await FullNodePeer.getPeerIPs();

    // Setup peer weights with prioritization
    FullNodePeer.setupPeers(peerIPs);

    // Weighted random selection
    let selectedPeerIP: string;
    try {
      selectedPeerIP = FullNodePeer.selectPeerByWeight();
    } catch (error: any) {
      throw new Error(`Failed to select a peer: ${error.message}`);
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
        `Failed to create peer for IP ${selectedPeerIP}: ${error.message}`
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
      throw new Error(`Unable to connect to peer ${selectedPeerIP}`);
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

    // Cache the peer
    FullNodePeer.cachedPeer = { peer: peer, timestamp: now };

    console.log(`Using Fullnode Peer: ${selectedPeerIP}`);

    return peer;
  }

  /**
   * Handles peer disconnection by marking it in cooldown and updating internal states.
   * @param {string} peerIP - The IP address of the disconnected peer.
   */
  public handlePeerDisconnection(peerIP: string): void {
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

    // Extract peer IP to access the corresponding limiter
    const peerIP = FullNodePeer.extractPeerIP(peer);
    if (!peerIP) {
      spinner.error({ text: "Failed to extract peer IP." });
      throw new Error("Failed to extract peer IP.");
    }

    const limiter = FullNodePeer.peerLimiters.get(peerIP);
    if (!limiter) {
      spinner.error({ text: "No rate limiter found for the peer." });
      throw new Error("No rate limiter found for the peer.");
    }

    try {
      while (true) {
        // Schedule the isCoinSpent method call through the limiter
        const confirmed = await limiter.schedule(() =>
          peer.isCoinSpent(
            parentCoinInfo,
            MIN_HEIGHT,
            Buffer.from(MIN_HEIGHT_HEADER_HASH, "hex")
          )
        );

        if (confirmed) {
          spinner.success({ text: "Coin confirmed!" });
          return true;
        }

        // Wait for 5 seconds before the next check
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error: any) {
      spinner.error({ text: "Error while waiting for confirmation." });
      console.error(`waitForConfirmation error: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Usage Example
 */
async function main() {
  try {
    // Connect to the best available peer
    const fullNodePeer = await FullNodePeer.connect();

    // Example parentCoinInfo buffer (replace with actual data)
    const parentCoinInfo = Buffer.from("your_parent_coin_info_here", "hex");

    // Wait for coin confirmation
    const isConfirmed = await FullNodePeer.waitForConfirmation(parentCoinInfo);

    console.log(`Coin confirmed: ${isConfirmed}`);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

main();
