// supabase/functions/fetch-news/blockchain.ts
import { ethers } from "https://esm.sh/ethers@6.14.0";

export const BLOCKCHAIN_RPC    = Deno.env.get("BLOCKCHAIN_RPC") ?? "http://127.0.0.1:8545";
export const CONTRACT_ADDRESS  = Deno.env.get("CONTRACT_ADDRESS");
const        PRIVATE_KEY       = Deno.env.get("PRIVATE_KEY");

const ABI = [
  "function checkArticle(bytes32) external view returns (bool,uint256,bool,address)",
  "function registerArticle(bytes32,string calldata) external",
];

const provider = () => new ethers.JsonRpcProvider(BLOCKCHAIN_RPC);
const contract = (signer?: ethers.Signer) =>
  new ethers.Contract(CONTRACT_ADDRESS!, ABI, signer ?? provider());

export const getNetworkType = () =>
  /localhost|127\.0\.0\.1/.test(BLOCKCHAIN_RPC) ? "local-hardhat" : "testnet-or-mainnet";

export async function hashArticle(content: string): Promise<string> {
  if (!content?.trim()) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

export async function checkArticleOnChain(content: string, cachedHash?: string | null) {
  if (!CONTRACT_ADDRESS || !content?.trim()) return null;
  try {
    const hash = cachedHash?.startsWith("0x") && cachedHash.length === 66
      ? cachedHash : "0x" + await hashArticle(content);
    const [exists, timestamp, verified, publisher] = await contract().checkArticle(hash);
    return exists
      ? { registered: true, verified, publisher, timestamp: new Date(Number(timestamp) * 1000).toISOString() }
      : null;
  } catch (e: any) {
    console.warn("Blockchain check failed:", e.message);
    return null;
  }
}

export async function registerArticleOnChain(content: string, metadataURI: string) {
  if (!CONTRACT_ADDRESS || !PRIVATE_KEY || !content)
    return { success: false, txHash: null, error: "Missing config or content" };
  try {
    const hash = "0x" + await hashArticle(content);

    // ✅ CHECK FIRST — if already registered, return existing tx info
    const existing = await checkArticleOnChain(content, hash);
    if (existing?.registered) {
      console.log(`ℹ️ Already registered on-chain, skipping`);
      return { success: true, txHash: null, alreadyRegistered: true };
    }

    const wallet = new ethers.Wallet(PRIVATE_KEY, provider());
    const tx     = await contract(wallet).registerArticle(hash, metadataURI);
    await tx.wait();
    console.log(`✅ On-chain: TX ${tx.hash}`);
    return { success: true, txHash: tx.hash };
  } catch (e: any) {
    console.error("❌ Registration failed:", e.message);
    return { success: false, txHash: null, error: e.message };
  }
}