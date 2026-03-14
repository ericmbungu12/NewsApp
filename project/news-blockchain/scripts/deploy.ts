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
  
  console.log("��� Deploying NewsProvenance to SEPOLIA...");
  
  const provider = new ethers.JsonRpcProvider(RPC_URL, 11155111);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("��� Deployer:", signer.address);
  const balance = await provider.getBalance(signer.address);
  console.log("��� Balance:", ethers.formatEther(balance), "ETH");
  
  if (balance === 0n) {
    console.warn("⚠️  Balance is 0 — get Sepolia ETH from faucet!");
    return;
  }
  
  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "NewsProvenance.sol", "NewsProvenance.json");
  
  if (!fs.existsSync(artifactPath)) {
    console.error("❌ Contract artifact not found. Run 'npx hardhat compile' first.");
    return;
  }
  
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  console.log("��� Sending deployment transaction...");
  
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  console.log("✅ Contract deployed successfully!");
  console.log("��� Contract Address:", address);
  
  const configDir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  
  const configPath = path.join(configDir, "sepolia.json");
  fs.writeFileSync(configPath, JSON.stringify({
    contractAddress: address,
    deployer: signer.address,
    network: "sepolia",
    chainId: 11155111,
    deployedAt: new Date().toISOString()
  }, null, 2));
  
  console.log("��� Saved to", configPath);
  console.log("��� Verify: https://sepolia.etherscan.io/address/" + address);
}

main().catch(console.error);
