// hardhat.config.ts - COMPLETE WORKING VERSION FOR HARDHAT 3 + ESM + SEPOLIA
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import * as dotenv from "dotenv";

dotenv.config();

// 🔍 Debug: Log what Hardhat sees (remove after successful deploy)
console.log("🔧 HARDHAT CONFIG DEBUG:");
console.log("  INFURA_API_KEY:", process.env.INFURA_API_KEY ? "✅ Loaded" : "❌ MISSING");
console.log("  PRIVATE_KEY starts with 0x:", process.env.PRIVATE_KEY?.startsWith("0x") ? "✅ Yes" : "❌ No");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
    cache: "./cache",
    tests: "./test",
  },
  
  networks: {
    // Local simulated network (Hardhat 3 requires 'type')
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
    },
    
    // Local HTTP node (for npx hardhat node)
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    
    // ✅ Sepolia testnet - FIXED URL (NO SPACES)
    sepolia: {
      type: "http",  // Required for Hardhat 3
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`, // ✅ NO SPACES
      accounts: process.env.PRIVATE_KEY?.startsWith("0x") 
        ? [process.env.PRIVATE_KEY] 
        : [],
      chainId: 11155111,
      timeout: 60000, // Longer timeout for testnet
    },
  },
};

export default config;