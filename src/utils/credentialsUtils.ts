import * as readline from "readline";
import crypto from "crypto";
import { NconfManager } from "./NconfManager";
import { EncryptedData, encryptData, decryptData } from "../utils/encryption";
import { Credentials } from "../types";

// Validate that the remote is a valid IP address
const validateIPAddress = (ip: string): boolean => {
  const ipRegex =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipRegex.test(ip);
};

// Encrypt and store credentials using the NconfManager
export const encryptAndStoreCredentials = async (
  nconfManager: NconfManager,
  remote: string,
  key: string,
  value: string
) => {
  const encryptedData = encryptData(value);
  const existingData = await nconfManager.getConfigValue<{
    [key: string]: EncryptedData;
  }>(remote);

  const updatedData = {
    ...(existingData || {}),
    [key]: encryptedData,
  };

  await nconfManager.setConfigValue(remote, updatedData);
  console.log(`${key} stored securely for remote ${remote}.`);
};

// Retrieve and decrypt credentials from the NconfManager
export const retrieveAndDecryptCredentials = async (
  nconfManager: NconfManager,
  remote: string,
  key: string
): Promise<string | null> => {
  const existingData = await nconfManager.getConfigValue<{
    [key: string]: EncryptedData;
  }>(remote);

  if (existingData && existingData[key]) {
    return decryptData(existingData[key]);
  }
  return null;
};

// Function to prompt for username and password
export const promptCredentials = async (remote: string): Promise<Credentials> => {
  if (!validateIPAddress(remote)) {
    throw new Error("Invalid IP address. Please enter a valid IP address.");
  }

  const nconfManager = new NconfManager("credentials.json");

  // Check if credentials are already stored
  const storedUsername = await retrieveAndDecryptCredentials(nconfManager, remote, "username");
  const storedPassword = await retrieveAndDecryptCredentials(nconfManager, remote, "password");

  if (storedUsername && storedPassword) {
    console.log(`Using stored credentials for remote ${remote}`);
    return { username: storedUsername, password: storedPassword };
  }

  // If not stored, prompt the user for credentials
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  const username = await askQuestion(`Enter your username for ${remote}: `);
  const password = await askQuestion(`Enter your password for ${remote}: `);

  // Ask if the user wants to store the credentials
  const storeCredentials = await askQuestion(
    `Would you like to store these credentials for later use? (Remember to add these to your remote node env) (y/n): `
  );

  rl.close();

  if (storeCredentials.toLowerCase() === "y") {
    await encryptAndStoreCredentials(nconfManager, remote, "username", username);
    await encryptAndStoreCredentials(nconfManager, remote, "password", password);
  }

  return { username, password };
};

export const clearCredentials = async (remote: string) => {
  const nconfManager = new NconfManager("credentials.json");

  const existingData = await nconfManager.getConfigValue<{
    [key: string]: EncryptedData;
  }>(remote);

  if (existingData && (existingData.username || existingData.password)) {
    await nconfManager.setConfigValue(remote, {}); // Clear the credentials for the remote
    console.log(`Credentials for remote ${remote} have been cleared.`);
  } else {
    console.log(`No credentials found for remote ${remote}.`);
  }
};

export function generateHighEntropyValue(length: number = 10): string {
  const possibleChars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charSetSize = possibleChars.length;
  let result = "";
  let remainingBytes = crypto.randomBytes(length * 2); // Generate more random bytes than needed

  for (let i = 0; i < length; i++) {
    let randomValue;
    do {
      if (remainingBytes.length < 1) {
        remainingBytes = crypto.randomBytes(length * 2); // Refill the buffer if it runs out
      }
      randomValue = remainingBytes[0];
      remainingBytes = remainingBytes.slice(1); // Remove the used byte
    } while (randomValue >= charSetSize * Math.floor(256 / charSetSize)); // Discard biased values

    const randomIndex = randomValue % charSetSize;
    result += possibleChars.charAt(randomIndex);
  }

  return result;
}
