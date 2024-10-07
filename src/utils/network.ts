// @ts-ignore
import stun, { STUN_BINDING_REQUEST } from 'node-stun';

// Get the Coturn server hostname from the environment variable or default to "localhost"
const COTURN_SERVER = process.env.STUN_SERVER || 'coturn';  // "coturn" refers to the Coturn service in Docker Compose
const COTURN_PORT = 3478;  // Standard STUN port


export const getPublicHost = async (): Promise<string | undefined> => {
  return new Promise((resolve, reject) => {
    const client = stun.createClient();

    client.request(
      COTURN_SERVER,
      COTURN_PORT,
      { request: STUN_BINDING_REQUEST },
      (err: any, response: any) => {
        if (err) {
          reject(`Failed to connect to Coturn server: ${err.message}`);
          return;
        }

        // Extract public IP and port from the STUN response
        const { address, port } = response.getXorAddress();
        if (address && port) {
          resolve(address);
        } else {
          reject('Failed to obtain public IP from Coturn server');
        }
      }
    );
  });
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
