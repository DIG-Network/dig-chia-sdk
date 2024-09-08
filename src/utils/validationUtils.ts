import * as fs from "fs";
import * as zlib from "zlib";
import * as crypto from "crypto";
import {getFilePathFromSha256} from "./hashUtils";

/**
 * Validates if the SHA256 hash of the decompressed file matches the provided hash.
 *
 * @param sha256 - The expected SHA256 hash of the decompressed file.
 * @param dataDir - The root folder where the data files are stored.
 * @returns A boolean indicating whether the decompressed file's hash matches the provided hash.
 */
export const validateFileSha256 = (
  sha256: string,
  dataDir: string
): boolean => {
  // Derive the file path from the SHA256 hash
  const filePath = getFilePathFromSha256(sha256, dataDir);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  // Read and decompress the file
  const fileBuffer = fs.readFileSync(filePath);
  const decompressedBuffer = zlib.gunzipSync(fileBuffer);

  // Calculate the SHA256 hash of the decompressed content
  const hash = crypto
    .createHash("sha256")
    .update(decompressedBuffer)
    .digest("hex");

  // Compare the calculated hash with the provided hash
  return hash === sha256;
};
