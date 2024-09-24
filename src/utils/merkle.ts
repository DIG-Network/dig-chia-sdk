import { DataIntegrityTree} from "../DataIntegrityTree";
import fs from "fs";
import path from "path";

export async function merkleIntegrityCheck(
    treePath: string,
    tmpDir: string,
    dataPath: string,
    roothash: string
  ): Promise<boolean> {
    const rootHashContent = fs.readFileSync(treePath, "utf-8");
    const tree = JSON.parse(rootHashContent);
  
    // Extract expected sha256 from dataPath
    const expectedSha256 = dataPath.replace("data", "").replace(/\//g, "");
    console.log("expectedSha256", expectedSha256);
  
    // Find the hexKey in the tree based on matching sha256
    const hexKey = Object.keys(tree.files).find((key) => {
      const fileData = tree.files[key] as { hash: string; sha256: string }; // Inline type definition
      return fileData.sha256 === expectedSha256;
    });
  
    if (!hexKey) {
      throw new Error(`No matching file found with sha256: ${expectedSha256}`);
    }
  
    // Validate the integrity with the foreign tree
    const integrity = await DataIntegrityTree.validateKeyIntegrityWithForeignTree(
      hexKey,
      expectedSha256,
      tree,
      roothash,
      path.join(tmpDir, "data")
    );
  
    console.log("Integrity check result:", integrity);
    return integrity;
  }