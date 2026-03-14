// scripts/register-test.ts - FINAL WORKING VERSION
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  
  const RPC_URL = `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  
  if (!PRIVATE_KEY?.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
  }
  
  const provider = new ethers.JsonRpcProvider(RPC_URL, 11155111);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  // Load contract config and artifact
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "sepolia.json"), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "NewsProvenance.sol", "NewsProvenance.json"), "utf8"));
  
  const contract = new ethers.Contract(config.contractAddress, artifact.abi, signer);
  
  const testUrl = "https://example.com/tezpur-test-news-" + Date.now();
  const testHash = ethers.keccak256(ethers.toUtf8Bytes(testUrl));
  const metadataURI = testUrl; // Or use IPFS URI like "ipfs://Qm..."
  
  console.log("📰 Test article URL:", testUrl);
  console.log("🔐 Article hash:", testHash);
  console.log("📎 Metadata URI:", metadataURI);
  
  // ✅ Call registerArticle with BOTH required parameters
  console.log("📤 Sending registerArticle transaction...");
  const tx = await contract.registerArticle(testHash, metadataURI);
  
  console.log("⏳ Waiting for confirmation...");
  const receipt = await tx.wait();
  
  console.log("✅ Article registered successfully!");
  console.log("🔍 TX: https://sepolia.etherscan.io/tx/" + receipt.hash);
  console.log("💡 Now query this article via Supabase to see 'verified' status");
  
  // Optional: Verify it was registered
  const [exists, registeredAt, verified, publisher] = await contract.checkArticle(testHash);
  console.log("🔍 Verification check:");
  console.log("   Exists:", exists);
  console.log("   Registered at:", new Date(Number(registeredAt) * 1000).toISOString());
  console.log("   Verified:", verified);
  console.log("   Publisher:", publisher);
}

main().catch(console.error);