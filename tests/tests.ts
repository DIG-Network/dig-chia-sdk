import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Readable } from "stream";
import { DataIntegrityTree } from "../src/DataIntegrityTree";
import { describe, it, beforeEach, afterEach } from "mocha";

const TEST_STORE_ID = "a".repeat(64);
const TEST_KEY = "test_key";
const TEST_DATA = "This is some test data";

describe("MerkleManager", () => {
  let merkleManager: DataIntegrityTree;

  beforeEach(() => {
    merkleManager = new DataIntegrityTree(TEST_STORE_ID);
  });

  afterEach(() => {
    const storeDir = path.join(require("os").homedir(), ".dig", "stores", TEST_STORE_ID);
    if (fs.existsSync(storeDir)) {
      fs.rmdirSync(storeDir, { recursive: true });
    }
  });

  it("should upsert a key and verify its integrity", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const hexKey = Buffer.from(TEST_KEY).toString("hex");
    const fileData = fs.readFileSync(
      path.join(
        require("os").homedir(),
        ".dig",
        "stores",
        TEST_STORE_ID,
        "data",
        crypto.createHash("sha256").update(TEST_DATA).digest("hex").match(/.{1,2}/g)!.join("/")
      )
    );

    expect(fileData.toString()).to.include(TEST_DATA);

    const sha256 = crypto.createHash("sha256").update(TEST_DATA).digest("hex");
    const root = merkleManager.getRoot();
    const isValid = await merkleManager.verifyKeyIntegrity(sha256, root);

    expect(isValid).to.be.true;
  });

  it("should delete a key", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    merkleManager.deleteKey(TEST_KEY);

    const keys = merkleManager.listKeys();
    expect(keys).to.not.include(Buffer.from(TEST_KEY).toString("hex"));
  });

  it("should list all keys", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const keys = merkleManager.listKeys();
    expect(keys).to.include(Buffer.from(TEST_KEY).toString("hex"));
  });

  it("should get the root of the Merkle tree", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const root = merkleManager.getRoot();
    expect(root).to.be.a("string").with.lengthOf(64);
  });

  it("should serialize and deserialize the Merkle tree", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const root = merkleManager.getRoot();
    const serializedTree = merkleManager.serialize(root);
    const deserializedTree = merkleManager.deserializeTree(root);

    expect(serializedTree).to.deep.equal(merkleManager.serialize(root));
    expect(deserializedTree.getRoot().toString("hex")).to.equal(root);
  });

  it("should commit the Merkle tree", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const root = merkleManager.commit();
    const manifest = fs.readFileSync(
      path.join(require("os").homedir(), ".dig", "stores", TEST_STORE_ID, "manifest.dat"),
      "utf8"
    ).trim().split("\n");

    expect(manifest).to.include(root);
  });

  it("should clear pending changes and revert to the latest committed state", async () => {
    const readStream1 = Readable.from([TEST_DATA]);
    await merkleManager.upsertKey(readStream1, TEST_KEY);
    const root1 = merkleManager.commit();

    const readStream2 = Readable.from(["New Data"]);
    await merkleManager.upsertKey(readStream2, "new_key");

    merkleManager.clearPendingRoot();

    const root2 = merkleManager.getRoot();
    expect(root2).to.equal(root1);
  });

  it("should get a readable stream for a file", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const hexKey = Buffer.from(TEST_KEY).toString("hex");
    const fileStream = merkleManager.getValueStream(hexKey);
    const chunks: any[] = [];

    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }

    const fileData = Buffer.concat(chunks).toString();
    expect(fileData).to.include(TEST_DATA);
  });

  it("should delete all leaves from the Merkle tree", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    merkleManager.deleteAllLeaves();

    const keys = merkleManager.listKeys();
    expect(keys).to.be.empty;
  });

  it("should get a proof for a file", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const hexKey = Buffer.from(TEST_KEY).toString("hex");
    const sha256 = crypto.createHash("sha256").update(TEST_DATA).digest("hex");
    const proof = merkleManager.getProof(hexKey, sha256);

    expect(proof).to.be.a("string");
  });

  it("should verify a proof for a file", async () => {
    const readStream = Readable.from([TEST_DATA]);

    await merkleManager.upsertKey(readStream, TEST_KEY);

    const hexKey = Buffer.from(TEST_KEY).toString("hex");
    const sha256 = crypto.createHash("sha256").update(TEST_DATA).digest("hex");
    const proof = merkleManager.getProof(hexKey, sha256);
    const isValid = merkleManager.verifyProof(proof, sha256);

    expect(isValid).to.be.true;
  });

  it("should get the difference between two Merkle tree roots", async () => {
    const readStream1 = Readable.from([TEST_DATA]);
    await merkleManager.upsertKey(readStream1, TEST_KEY);
    const root1 = merkleManager.commit();

    if (!root1) {
      throw new Error("Root hash is empty");
    }

    const readStream2 = Readable.from(["New Data"]);
    await merkleManager.upsertKey(readStream2, "new_key");
    const root2 = merkleManager.commit();

    if (!root2) {
      throw new Error("Root hash is empty");
    }

    const { added, deleted } = merkleManager.getRootDiff(root1, root2);

    expect(added).to.have.keys(Buffer.from("new_key").toString("hex"));
    expect(deleted).to.be.empty;
  });
});
