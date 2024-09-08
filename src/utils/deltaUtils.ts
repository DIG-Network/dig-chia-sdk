import * as fs from "fs";
import * as path from "path";
import { getFilePathFromSha256 } from "./hashUtils";

export const getDeltaFiles = async (
  storeId: string,
  generationIndex: number = 0,
  directoryPath: string
): Promise<string[]> => {
  if (isNaN(generationIndex)) {
    generationIndex = 0;
  }

  // Load manifest file
  const manifestFilePath = path.join(directoryPath, storeId, "manifest.dat");
  if (!fs.existsSync(manifestFilePath)) {
    console.error("Manifest file not found", manifestFilePath);
    return [];
  }

  const manifestHashes = fs
    .readFileSync(manifestFilePath, "utf-8")
    .split("\n")
    .filter(Boolean);

  console.log("");
  console.log(`Uploading delta from generation ${generationIndex}`);

  const filesInvolved: string[] = [];

  // Include the height.dat file at the top of the directory
  const heightDatFilePath = path.join(directoryPath, storeId, "height.json");
  if (fs.existsSync(heightDatFilePath)) {
    filesInvolved.push(heightDatFilePath);
  }

  // Collect files starting from generationIndex + 1
  for (let i = generationIndex; i < manifestHashes.length; i++) {
    const rootHash = manifestHashes[i];

    const datFilePath = path.join(directoryPath, storeId, `${rootHash}.dat`);

    if (!fs.existsSync(datFilePath)) {
      console.error(`Data file for root hash ${rootHash} not found`);
      return [];
    }

    const datFileContent = JSON.parse(fs.readFileSync(datFilePath, "utf-8"));

    if (datFileContent.root !== rootHash) {
      console.error(
        `Root hash in data file does not match: ${datFileContent.root} !== ${rootHash}`
      );
      return [];
    }

    // Add the .dat file itself to the list of files involved
    filesInvolved.push(datFilePath);

    // Collect all files involved, ensuring correct paths
    for (const file of Object.keys(datFileContent.files)) {
      const filePath = getFilePathFromSha256(
        datFileContent.files[file].sha256,
        path.join(directoryPath, storeId, "data")
      );
      filesInvolved.push(filePath);
    }
  }

  if (process.env.DIG_DEBUG === "1") {
    console.log("Files involved in the delta:");
    console.table(filesInvolved);
  }

  // list the manifest file last, this actually
  // helps with upload because by overriding the manifest file last, 
  // the store can still be considered valid even when the upload is interrupted
  filesInvolved.push(manifestFilePath);

  return filesInvolved;
};
