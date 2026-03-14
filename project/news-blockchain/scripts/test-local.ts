import { ethers } from "ethers";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ✅ FIX: Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("🧪 Testing NewsProvenance contract locally...\n");

  // Connect to local Hardhat node
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  
  // Use test accounts
  const user1 = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider
  );
  
  console.log(`👤 User: ${await user1.getAddress()}`);
  
  // ✅ FIX: Use provider.getBalance(address)
  const balance = await provider.getBalance(await user1.getAddress());
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

  // ✅ FIX: Load artifact with fs + path (ESM-safe)
  const artifactPath = path.join(__dirname, "../artifacts/contracts/NewsProvenance.sol/NewsProvenance.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  
  // Load contract address from config
  const configPath = path.join(__dirname, "../config/local.json");
  let contractAddress: string;
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    contractAddress = config.contractAddress;
  } catch {
    console.error("❌ config/local.json not found. Run deploy script first!");
    console.error("💡 Or create it manually with your contract address");
    process.exit(1);
  }
  
  const contract = new ethers.Contract(contractAddress, artifact.abi, user1);

  // Create article hash
  const article = "Breaking: Blockchain Learning Journey Begins!";
  const hash = createHash("sha256").update(article).digest("hex");
  const hashBytes = ethers.toBeArray("0x" + hash);
  
  console.log(`📰 Article: "${article}"`);
  console.log(`🔐 Hash: 0x${hash}\n`);

  // Register article
  console.log("📤 Step 1: Registering article...");
  const tx1 = await contract.registerArticle(hashBytes, "ipfs://QmTest");
  await tx1.wait();
  console.log(`✅ Confirmed: ${tx1.hash.slice(0, 20)}...\n`);

  // Check article
  console.log("🔍 Step 2: Checking registration...");
  const [exists, timestamp, verified, publisher] = await contract.checkArticle(hashBytes);
  console.log(`   Exists: ${exists}`);
  console.log(`   Time: ${new Date(Number(timestamp) * 1000).toISOString()}`);
  console.log(`   Verified: ${verified}`);
  console.log(`   Publisher: ${publisher}\n`);

  // Verify article
  console.log("✅ Step 3: Verifying article...");
  const tx2 = await contract.verifyArticle(hashBytes, true);
  await tx2.wait();
  console.log("✅ Verified!\n");

  // Final check
  const [, , verifiedNow] = await contract.checkArticle(hashBytes);
  console.log(`🎯 Final status: ${verifiedNow}`);

  // Check reputation
  const rep = await contract.getPublisherReputation(await user1.getAddress());
  console.log(`📊 Reputation: ${rep}`);

  console.log("\n✨ ALL TESTS PASSED! You're doing blockchain! 🎉");
}

main().catch(console.error);