/*
 * Stopgap until better solution for finding public IPS found
 */
import superagent from "superagent";
import { Environment } from "./Environment";

const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // in milliseconds

// Regular expression for validating both IPv4 and IPv6 addresses
const ipv4Regex =
  /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const ipv6Regex =
  /^(([0-9a-fA-F]{1,4}:){7}([0-9a-fA-F]{1,4}|:)|(([0-9a-fA-F]{1,4}:){1,7}|:):(([0-9a-fA-F]{1,4}:){1,6}|:):([0-9a-fA-F]{1,4}|:):([0-9a-fA-F]{1,4}|:)|::)$/;

// Helper function to validate the IP address
const isValidIp = (ip: string): boolean => {
  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
};

export const getPublicIpAddress = async (): Promise<string | undefined> => {
  const publicIp = Environment.PUBLIC_IP;

  if (publicIp) {
    console.log("Public IP address from env:", publicIp);
    if (isValidIp(publicIp)) {
      return publicIp;
    }
    console.error("Invalid public IP address in environment variable");
    return undefined;
  }

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await superagent.get(
        "https://api.datalayer.storage/user/v1/get_user_ip"
      );

      if (response.body && response.body.success) {
        const ipAddress = response.body.ip_address;

        if (isValidIp(ipAddress)) {
          return ipAddress;
        }
        throw new Error("Invalid IP address format received");
      }
      throw new Error("Failed to retrieve public IP address");
    } catch (error: any) {
      attempt++;
      console.error(
        `Error fetching public IP address (Attempt ${attempt}):`,
        error.message
      );

      if (attempt >= MAX_RETRIES) {
        throw new Error(
          "Could not retrieve public IP address after several attempts"
        );
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
};

// Helper function to wrap IPv6 addresses in brackets
export const formatHost = (host: string): string => {
  const ipv6Pattern = /^[a-fA-F0-9:]+$/; // Simple regex to match raw IPv6 addresses (without brackets)
  const hasBrackets = /^\[.*\]$/; // Regex to check if the address already has brackets

  // If it's an IPv6 address without brackets, add them
  if (ipv6Pattern.test(host) && !hasBrackets.test(host)) {
    return `[${host}]`;
  }

  return host; // Return the host as is (IPv4, hostname, or already bracketed IPv6)
};
