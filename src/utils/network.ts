import superagent from "superagent";
import { Environment } from "./Environment";

const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // in milliseconds

// Regular expression for validating both IPv4 and IPv6 addresses
const ipv4Regex =
  /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const ipv6Regex =
  /^(([0-9a-fA-F]{1,4}:){7}([0-9a-fA-F]{1,4}|:)|(([0-9a-fA-F]{1,7}|:):){1,7}([0-9a-fA-F]{1,4}|:))$/;

// Regular expression for validating hostnames
const hostnameRegex = /^(([a-zA-Z0-9](-*[a-zA-Z0-9])*)\.)*[a-zA-Z]{2,}$/;

// Helper function to validate the IP address or hostname
const isValidHost = (host: string): boolean => {
  return ipv4Regex.test(host) || ipv6Regex.test(host) || hostnameRegex.test(host);
};

export const getPublicHost = async (): Promise<string | undefined> => {
  const publicHost = process.env.PUBLIC_IP;

  if (publicHost) {
    console.log("Public IP/Hostname from env:", publicHost);

    if (isValidHost(publicHost)) {
      return publicHost;
    }

    console.error("Invalid public IP/Hostname in environment variable");
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

        if (isValidHost(ipAddress)) {
          return ipAddress;
        }
        throw new Error("Invalid IP address or hostname format received");
      }
      throw new Error("Failed to retrieve public host");
    } catch (error: any) {
      attempt++;
      console.error(
        `Error fetching public host (Attempt ${attempt}):`,
        error.message
      );

      if (attempt >= MAX_RETRIES) {
        throw new Error(
          "Could not retrieve public host after several attempts"
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