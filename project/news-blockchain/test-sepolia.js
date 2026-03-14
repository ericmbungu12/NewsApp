import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

async function test() {
  const RPC_URL = `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
  
  console.log("Ì¥ó Testing Sepolia connection...");
  console.log("RPC URL:", RPC_URL);
  console.log("INFURA_API_KEY loaded:", process.env.INFURA_API_KEY ? "‚úÖ Yes" : "‚ùå No");
  console.log("PRIVATE_KEY starts with 0x:", process.env.PRIVATE_KEY?.startsWith("0x") ? "‚úÖ Yes" : "‚ùå No");
  console.log();
  
  const provider = new ethers.JsonRpcProvider(RPC_URL, 11155111);
  
  try {
    const network = await provider.getNetwork();
    console.log("‚úÖ Connected to:", network.name, "(chainId:", Number(network.chainId) + ")");
    
    const block = await provider.getBlockNumber();
    console.log("Ì≥¶ Latest block:", block);
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance = await provider.getBalance(wallet.address);
    console.log("Ì≤∞ Your wallet balance:", ethers.formatEther(balance), "ETH");
    console.log("Ì≥ç Wallet address:", wallet.address);
    
    if (balance === 0n) {
      console.warn("‚ö†Ô∏è  Balance is 0 ‚Äî get Sepolia ETH from a faucet!");
    }
  } catch (err) {
    console.error("‚ùå Connection failed:", err.message);
  }
}

test();
