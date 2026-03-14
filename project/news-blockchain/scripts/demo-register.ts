// scripts/demo-register.ts
// Purpose: Register a sample article on Sepolia for demo/testing
// Usage: npx hardhat run scripts/demo-register.ts --network sepolia
// Edit ARTICLE_URL below to register any article

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// âœ… EDIT THIS URL to register any article for your demo
const ARTICLE_URL = "https://timesofindia.indiatimes.com/india/big-boost-for-assam-cm-himanta-biswa-sarma-says-rs-55000-crore-projects-cleared-in-last-one-year/articleshow/128380396.cms";

async function main() {
  const RPC_URL = `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  
  if (!PRIVATE_KEY?.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
  }
  
  const provider = new ethers.JsonRpcProvider(RPC_URL, 11155111);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  // Load contract config and ABI
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "sepolia.json"), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "NewsProvenance.sol", "NewsProvenance.json"), "utf8"));
  
  const contract = new ethers.Contract(config.contractAddress, artifact.abi, signer);
  
  // Hash the article URL (must match how your backend hashes)
  const articleHash = ethers.keccak256(ethers.toUtf8Bytes(ARTICLE_URL));
  
  console.log("í¾¬ Demo: Registering Article on Sepolia");
  console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  console.log("í³° Article URL:", ARTICLE_URL);
  console.log("í´ Content Hash:", articleHash);
  console.log("í³ Contract:", config.contractAddress);
  console.log("í±¤ Publisher:", signer.address);
  console.log();
  
  // Register article: registerArticle(bytes32 _contentHash, string _metadataURI)
  console.log("í³¤ Sending registration transaction...");
  const tx = await contract.registerArticle(articleHash, ARTICLE_URL);
  
  console.log("â³ Waiting for block confirmation...");
  const receipt = await tx.wait();
  
  console.log();
  console.log("âœ… SUCCESS! Article registered on Sepolia");
  console.log("í´— Transaction: https://sepolia.etherscan.io/tx/" + receipt.hash);
  console.log("â›½ Gas used:", receipt.gasUsed.toString());
  console.log();
  
  // Verify registration on-chain
  console.log("í´ Verifying on-chain registration...");
  const [exists, registeredAt, verified, publisher] = await contract.checkArticle(articleHash);
  
  console.log("   âœ… Exists:", exists);
  console.log("   íµ Registered at:", new Date(Number(registeredAt) * 1000).toISOString());
  console.log("   âœ… Verified:", verified);
  console.log("   í±¤ Publisher:", publisher);
  console.log();
  console.log("í²¡ Next: Query this article via Supabase to see 'registered: true'");
  console.log("   curl -X POST https://sldzbngcrrgmzuthtnyy.supabase.co/functions/v1/fetch-news \\");
  console.log("     -H 'Authorization: Bearer YOUR_ANON_KEY' \\");
  console.log("     -H 'Content-Type: application/json' \\");
  console.log("     -d '{\"topic\":\"Assam projects\",\"region\":\"india\"}'");
}

main().catch((error) => {
  console.error("âŒ Demo failed:", error.message);
  process.exitCode = 1;
});
