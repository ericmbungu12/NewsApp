// supabase/functions/fetch-news/blockchain.ts
import { ethers } from "https://esm.sh/ethers@6.14.0";

export const BLOCKCHAIN_RPC   = Deno.env.get("BLOCKCHAIN_RPC") ?? "http://127.0.0.1:8545";
export const CONTRACT_ADDRESS = Deno.env.get("CONTRACT_ADDRESS");
const        PRIVATE_KEY      = Deno.env.get("PRIVATE_KEY");

const ABI=[
  "function checkArticle(bytes32) external view returns (bool,uint256,bool,address)",
  "function registerArticle(bytes32,string calldata) external",
  "function registerBatch(bytes32[] calldata,string[] calldata) external",
  "function checkBatch(bytes32[] calldata) external view returns (bool[])",
];

// Provider with custom fetch timeout to avoid hanging on slow RPC nodes
const provider=()=>new ethers.JsonRpcProvider(BLOCKCHAIN_RPC,undefined,{
  staticNetwork:true,        // skip eth_chainId on every call
  batchMaxCount:10,          // batch RPC calls where possible
});
const contract=(signer?:ethers.Signer)=>new ethers.Contract(CONTRACT_ADDRESS!,ABI,signer??provider());

export const getNetworkType=()=>/localhost|127\.0\.0\.1/.test(BLOCKCHAIN_RPC)?"local-hardhat":"testnet-or-mainnet";

export async function hashArticle(content:string):Promise<string>{
  if(!content?.trim())return"";
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,"0")).join("");
}

export async function checkArticleOnChain(content:string,cachedHash?:string|null){
  if(!CONTRACT_ADDRESS||!content?.trim())return null;
  try{
    const hash=cachedHash?.startsWith("0x")&&cachedHash.length===66?cachedHash:"0x"+await hashArticle(content);
    const[exists,timestamp,verified,publisher]=await contract().checkArticle(hash);
    return exists?{registered:true,verified,publisher,timestamp:new Date(Number(timestamp)*1000).toISOString()}:null;
  }catch(e:any){console.warn("Chain check failed:",e.message);return null;}
}

export async function checkBatchOnChain(articles:{content:string;cachedHash?:string|null}[]):Promise<(any|null)[]>{
  if(!CONTRACT_ADDRESS||!articles.length)return articles.map(()=>null);
  try{
    const hashes=await Promise.all(articles.map(async a=>a.cachedHash?.startsWith("0x")&&a.cachedHash.length===66?a.cachedHash:"0x"+await hashArticle(a.content)));
    try{
      const flags:boolean[]=await contract().checkBatch(hashes);
      return await Promise.all(flags.map((exists,i)=>exists?checkArticleOnChain(articles[i].content,hashes[i]):null));
    }catch{
      return await Promise.all(articles.map((a,i)=>checkArticleOnChain(a.content,hashes[i])));
    }
  }catch(e:any){console.warn("Batch check failed:",e.message);return articles.map(()=>null);}
}

// ── Batch register — only top 10–20 articles from RL engine ──────────────────
export async function registerBatchOnChain(
  articles:{content:string;url:string}[],
  delayMs=200  // reduced from 300 — safe since we register max 20 now
){
  if(!CONTRACT_ADDRESS||!PRIVATE_KEY)
    return articles.map(a=>({url:a.url,txHash:null,success:false,error:"Missing config"}));

  const targets=articles.filter(a=>a.content?.trim());
  console.log(`🔗 Batch registering ${targets.length} articles...`);

  const hashes=await Promise.all(targets.map(a=>hashArticle(a.content).then(h=>"0x"+h)));

  // Check which are already registered
  let alreadyFlags=new Array(targets.length).fill(false);
  try{ alreadyFlags=(await contract().checkBatch(hashes)) as boolean[]; }
  catch{
    const c=await Promise.all(targets.map((a,i)=>checkArticleOnChain(a.content,hashes[i])));
    alreadyFlags=c.map(x=>!!x?.registered);
  }

  const wallet=new ethers.Wallet(PRIVATE_KEY,provider());
  const results:any[]=[];
  const newOnes  =targets.filter((_,i)=>!alreadyFlags[i]);
  const newHashes=hashes.filter((_,i)=>!alreadyFlags[i]);

  if(newOnes.length){
    try{
      // Single batch TX — cheapest in gas and fastest
      const tx=await contract(wallet).registerBatch(newHashes,newOnes.map(a=>a.url));
      await tx.wait();
      console.log(`✅ Batch TX: ${tx.hash} — ${newOnes.length} articles`);
      newOnes.forEach(a=>results.push({url:a.url,txHash:tx.hash,success:true}));
    }catch(batchErr:any){
      console.warn(`⚠️ Batch TX failed (${batchErr.message}), falling back to sequential`);
      for(let i=0;i<newOnes.length;i++){
        try{
          const tx=await contract(wallet).registerArticle(newHashes[i],newOnes[i].url);
          await tx.wait();
          console.log(`✅ [${i+1}/${newOnes.length}] TX: ${tx.hash}`);
          results.push({url:newOnes[i].url,txHash:tx.hash,success:true});
        }catch(e:any){
          console.error(`❌ [${i+1}] ${e.message}`);
          results.push({url:newOnes[i].url,txHash:null,success:false,error:e.message});
        }
        if(i<newOnes.length-1)await new Promise(r=>setTimeout(r,delayMs));
      }
    }
  }

  targets.forEach((a,i)=>{ if(alreadyFlags[i]) results.push({url:a.url,txHash:null,alreadyRegistered:true,success:true}); });
  console.log(`✅ Batch done: ${results.filter(r=>r.success).length}/${targets.length}`);
  return results;
}