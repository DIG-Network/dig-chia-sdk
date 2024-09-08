// encryption.ts
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedData {
  data: string;
  nonce: string;
  salt: string;
}

const generateKey = (salt: string): Buffer => {
  return crypto.pbkdf2Sync("mnemonic-seed", salt, 100000, 32, "sha512");
};

export const encryptData = (data: string): EncryptedData => {
  const nonce = crypto.randomBytes(12).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const key = generateKey(salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, Buffer.from(nonce, "hex"));
  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return { data: encrypted + tag, nonce, salt };
};

export const decryptData = (encryptedData: EncryptedData): string => {
  const { data, nonce, salt } = encryptedData;
  const encryptedText = data.slice(0, -32);
  const tag = Buffer.from(data.slice(-32), "hex");
  const key = generateKey(salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(nonce, "hex"));
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
};
