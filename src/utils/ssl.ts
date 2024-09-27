import * as fs from "fs";
import * as path from "path";
import { Tls } from "@dignetwork/datalayer-driver";
import { USER_DIR_PATH }  from './config';

export const getOrCreateSSLCerts = () => {
  const sslDir = path.join(USER_DIR_PATH, "ssl");
  const certPath = path.join(sslDir, "client.cert");
  const keyPath = path.join(sslDir, "client.key");

  // Ensure the SSL directory exists
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { recursive: true });
  }

  // Check if the certificate and key exist, if not, generate them
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    new Tls(certPath, keyPath);
    console.log("Client certificate and key generated successfully.");
  }

  // Return the paths to the cert and key files
  return {
    certPath,
    keyPath,
  };
};
