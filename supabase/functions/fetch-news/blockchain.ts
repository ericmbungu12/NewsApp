// supabase/functions/fetch-news/blockchain.ts
import { ethers } from "https://esm.sh/ethers@6.14.0";

export const BLOCKCHAIN_RPC   = Deno.env.get("BLOCKCHAIN_RPC") ?? "http://127.0.0.1:8545";
export const CONTRACT_ADDRESS = Deno.env.get("CONTRACT_ADDRESS");
const        PRIVATE_KEY      = Deno.env.get("PRIVATE_KEY");
const        CHAIN_ID         = parseInt(Deno.env.get("CHAIN_ID") ?? "11155111");

// ── Updated ABI — includes all new contract functions ─────────────────────────
const ABI = [
  "function checkArticle(bytes32) external view returns (bool,uint256,bool,address)",
  "function registerArticle(bytes32,string calldata) external",
  "function registerBatch(bytes32[] calldata,string[] calldata) external",
  "function checkBatch(bytes32[] calldata) external view returns (bool[],bool[],address[])",
  "function verifyArticle(bytes32,bool) external",
  "function verifyBatch(bytes32[] calldata) external",
  "function setVerifier(address,bool) external",
  "function isVerifier(address) external view returns (bool)",
];

// ════════════════════════════════════════════════════════════════════════════
// LAYER 1 — Singleton provider + staticNetwork
// One provider instance for the entire Edge Function lifetime.
// staticNetwork: true = never fires eth_chainId automatically.
// Without this: every contract call = eth_chainId + actual call = 2x RPC hits.
// With this: eth_chainId fires exactly zero times after boot.
// ════════════════════════════════════════════════════════════════════════════
let _provider: ethers.JsonRpcProvider | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(
      BLOCKCHAIN_RPC,
      { chainId: CHAIN_ID, name: "custom" },
      { staticNetwork: true, batchMaxCount: 5 }
    );
    console.log(`🔌 Provider initialised — chain ${CHAIN_ID}, static network`);
  }
  return _provider;
}

function getContract(signer?: ethers.Signer) {
  return new ethers.Contract(CONTRACT_ADDRESS!, ABI, signer ?? getProvider());
}

export const getNetworkType = () =>
  /localhost|127\.0\.0\.1/.test(BLOCKCHAIN_RPC) ? "local-hardhat" : "testnet-or-mainnet";

// ════════════════════════════════════════════════════════════════════════════
// LAYER 3 — In-memory verification cache
// Maps content hash → result so the same article is never re-checked on-chain.
// TTL: 30 minutes. After that the cache entry expires and a fresh check runs.
// This is the biggest RPC saver: if 10 users search the same topic, only the
// first search hits Alchemy — the other 9 are served from memory instantly.
// ════════════════════════════════════════════════════════════════════════════
const CACHE_TTL = 1800000; // 30 minutes in ms

interface CacheEntry {
  result:   any;    // on-chain result (or null = not registered)
  cachedAt: number; // Date.now() when stored
}

const verifiedCache = new Map<string, CacheEntry>();

function getCached(hash: string): any | undefined {
  const entry = verifiedCache.get(hash);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL) {
    verifiedCache.delete(hash); // expired — evict
    return undefined;
  }
  return entry.result; // may be null (confirmed unregistered) or object (registered)
}

function setCached(hash: string, result: any) {
  verifiedCache.set(hash, { result, cachedAt: Date.now() });
}

// Periodically evict expired entries so memory doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [hash, entry] of verifiedCache.entries()) {
    if (now - entry.cachedAt > CACHE_TTL) {
      verifiedCache.delete(hash);
      evicted++;
    }
  }
  if (evicted > 0) console.log(`🧹 Cache: evicted ${evicted} expired entries`);
}, 600000);

// ════════════════════════════════════════════════════════════════════════════
// SHA-256 HASH
// ════════════════════════════════════════════════════════════════════════════
export async function hashArticle(content: string): Promise<string> {
  if (!content?.trim()) return "";
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content)
  );
  return Array.from(new Uint8Array(buf), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ════════════════════════════════════════════════════════════════════════════
// RETRY WRAPPER — exponential backoff on 429
// Attempt 0: immediate
// Attempt 1: wait 500ms
// Attempt 2: wait 1000ms
// Attempt 3: wait 2000ms → give up
// CALL_EXCEPTION is not retried — means contract doesn't exist at this address
// ════════════════════════════════════════════════════════════════════════════
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  label = "rpc"
): Promise<T | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const is429     = e?.error?.code === 429 || e?.message?.includes("429");
      const isCall    = e?.code === "CALL_EXCEPTION";
      const isNetwork = e?.message?.includes("failed to detect network");

      // Contract not at this address — no point retrying
      if (isCall) {
        console.warn(`⚠️ ${label}: CALL_EXCEPTION — check CONTRACT_ADDRESS matches CHAIN_ID`);
        return null;
      }

      if (attempt === maxRetries) {
        console.warn(`❌ ${label}: gave up after ${maxRetries + 1} attempts — ${e.message}`);
        return null;
      }

      if (is429 || isNetwork) {
        const delay = 500 * Math.pow(2, attempt); // 500 → 1000 → 2000
        console.warn(`⏳ ${label}: ${is429 ? "429 rate limit" : "network error"} — retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        if (isNetwork) _provider = null; // reset singleton so it re-initialises
      } else {
        console.warn(`⚠️ ${label}: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// VERIFY CONTRACT DEPLOYMENT
// Checks that bytecode exists at CONTRACT_ADDRESS on the current network.
// Called once at the start of registerBatchOnChain before any writes.
// ════════════════════════════════════════════════════════════════════════════
export async function verifyContractDeployment(): Promise<boolean> {
  if (!CONTRACT_ADDRESS) return false;
  try {
    const code = await getProvider().getCode(CONTRACT_ADDRESS);
    if (code === "0x") {
      console.error(
        `❌ No contract at ${CONTRACT_ADDRESS} on chain ${CHAIN_ID}. ` +
        `Check BLOCKCHAIN_RPC and CONTRACT_ADDRESS point to the same network.`
      );
      return false;
    }
    console.log(`✅ Contract verified at ${CONTRACT_ADDRESS}`);
    return true;
  } catch (e: any) {
    console.error(`❌ Contract verification failed: ${e.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CHECK SINGLE ARTICLE
// Layer 3 cache checked first — zero RPC calls on a hit.
// Layer 1 singleton provider used on a miss — no eth_chainId fired.
// ════════════════════════════════════════════════════════════════════════════
export async function checkArticleOnChain(
  content: string,
  cachedHash?: string | null
) {
  if (!CONTRACT_ADDRESS || !content?.trim()) return null;

  const hash =
    cachedHash?.startsWith("0x") && cachedHash.length === 66
      ? cachedHash
      : "0x" + await hashArticle(content);

  // Layer 3: cache hit — zero RPC calls
  const cached = getCached(hash);
  if (cached !== undefined) {
    console.log(`⚡ Cache hit: ${hash.slice(0, 12)}...`);
    return cached;
  }

  // Cache miss: go to chain
  const result = await withRetry(async () => {
    const [exists, timestamp, verified, publisher] =
      await getContract().checkArticle(hash);
    return exists
      ? {
          registered: true,
          verified,
          publisher,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        }
      : null;
  }, 3, `checkArticle:${hash.slice(0, 10)}`);

  setCached(hash, result); // cache null too — avoids re-checking unregistered articles
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// BATCH CHECK — sub-batches of 5 with cache filtering
// Updated for new checkBatch return signature: (bool[], bool[], address[])
// Articles already in cache are returned immediately with zero RPC calls.
// Only cache misses go to Alchemy, in groups of 5 with 300ms between groups.
// ════════════════════════════════════════════════════════════════════════════
export async function checkBatchOnChain(
  articles: { content: string; cachedHash?: string | null }[]
): Promise<(any | null)[]> {
  if (!CONTRACT_ADDRESS || !articles.length) return articles.map(() => null);

  // Pre-compute all hashes
  const hashes = await Promise.all(
    articles.map(async a =>
      a.cachedHash?.startsWith("0x") && a.cachedHash.length === 66
        ? a.cachedHash
        : "0x" + await hashArticle(a.content)
    )
  );

  // Layer 3: serve cached results immediately
  const results: (any | null)[] = new Array(articles.length).fill(null);
  const uncachedIndexes: number[] = [];

  for (let i = 0; i < hashes.length; i++) {
    const cached = getCached(hashes[i]);
    if (cached !== undefined) {
      results[i] = cached;
      console.log(`⚡ Cache hit [${i}]: ${hashes[i].slice(0, 12)}...`);
    } else {
      uncachedIndexes.push(i);
    }
  }

  if (uncachedIndexes.length === 0) {
    console.log(`⚡ All ${articles.length} articles served from cache — 0 RPC calls`);
    return results;
  }

  console.log(
    `🔍 Checking ${uncachedIndexes.length} uncached articles ` +
    `(${articles.length - uncachedIndexes.length} from cache)`
  );

  // Layer 1: hit chain only for cache misses, in batches of 5
  const BATCH_SIZE = 5;

  for (let b = 0; b < uncachedIndexes.length; b += BATCH_SIZE) {
    const batchSlice    = uncachedIndexes.slice(b, b + BATCH_SIZE);
    const batchHashes   = batchSlice.map(i => hashes[i]);
    const batchArticles = batchSlice.map(i => articles[i]);

    // New checkBatch returns [exists[], verified[], publishers[]]
    const batchResult = await withRetry<[boolean[], boolean[], string[]]>(
      () => getContract().checkBatch(batchHashes),
      3, `checkBatch[${b}]`
    );

    if (batchResult) {
      const [existsFlags, verifiedFlags, publishers] = batchResult;
      await Promise.all(
        existsFlags.map(async (exists, j) => {
          const originalIndex = batchSlice[j];
          const result = exists
            ? {
                registered: true,
                verified:   verifiedFlags[j],
                publisher:  publishers[j],
                timestamp:  null, // full details via checkArticleOnChain if needed
              }
            : null;
          results[originalIndex] = result;
          setCached(batchHashes[j], result);
        })
      );
    } else {
      // Batch call failed — fall back to individual checks
      console.warn(`⚠️ Batch[${b}] failed, checking individually`);
      for (let j = 0; j < batchArticles.length; j++) {
        const originalIndex = batchSlice[j];
        const result = await checkArticleOnChain(
          batchArticles[j].content,
          batchHashes[j]
        );
        results[originalIndex] = result;
      }
    }

    // Pause between sub-batches — keeps CU/s under free tier limit
    if (b + BATCH_SIZE < uncachedIndexes.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// BATCH REGISTER — top 20 only, single TX preferred
// Pre-check uses cache to skip articles already known to be registered.
// ════════════════════════════════════════════════════════════════════════════
export async function registerBatchOnChain(
  articles: { content: string; url: string }[],
  delayMs = 200
) {
  if (!CONTRACT_ADDRESS || !PRIVATE_KEY)
    return articles.map(a => ({
      url: a.url, txHash: null, success: false, error: "Missing config",
    }));

  // Verify contract exists before attempting any writes
  const deployed = await verifyContractDeployment();
  if (!deployed) {
    console.warn("⚠️ Skipping registration — contract not found on this network");
    return articles.map(a => ({
      url: a.url, txHash: null, success: false, error: "Contract not deployed",
    }));
  }

  const targets = articles.filter(a => a.content?.trim());
  console.log(`🔗 Registering up to ${targets.length} articles...`);

  const hashes = await Promise.all(
    targets.map(a => hashArticle(a.content).then(h => "0x" + h))
  );

  // Pre-check: use cache first, chain only for unknowns
  let alreadyFlags = new Array(targets.length).fill(false);
  const BATCH = 5;

  for (let i = 0; i < hashes.length; i += BATCH) {
    const slice         = hashes.slice(i, i + BATCH);
    const needsChain: number[] = [];

    for (let j = 0; j < slice.length; j++) {
      const cached = getCached(slice[j]);
      if (cached !== undefined) {
        alreadyFlags[i + j] = cached?.registered ?? false;
      } else {
        needsChain.push(j);
      }
    }

    if (needsChain.length > 0) {
      const unknownHashes = needsChain.map(j => slice[j]);
      const batchResult = await withRetry<[boolean[], boolean[], string[]]>(
        () => getContract().checkBatch(unknownHashes),
        3, `precheck[${i}]`
      );
      if (batchResult) {
        const [existsFlags] = batchResult;
        existsFlags.forEach((f, k) => {
          const j = needsChain[k];
          alreadyFlags[i + j] = f;
          setCached(slice[j], f ? { registered: true } : null);
        });
      }
    }

    if (i + BATCH < hashes.length) await new Promise(r => setTimeout(r, 200));
  }

  // Register only truly new articles
  const wallet    = new ethers.Wallet(PRIVATE_KEY, getProvider());
  const results: any[] = [];
  const newOnes   = targets.filter((_, i) => !alreadyFlags[i]);
  const newHashes = hashes.filter((_, i) => !alreadyFlags[i]);

  if (newOnes.length) {
    console.log(`📝 ${newOnes.length} new · ${targets.length - newOnes.length} already on-chain`);

    const txHash = await withRetry(async () => {
      const tx = await getContract(wallet).registerBatch(
        newHashes,
        newOnes.map(a => a.url)
      );
      await tx.wait();
      console.log(`✅ Batch TX: ${tx.hash} — ${newOnes.length} articles`);
      return tx.hash;
    }, 2, "registerBatch");

    if (txHash) {
      newOnes.forEach((a, i) => {
        // Cache as registered — future checks are instant
        setCached(newHashes[i], { registered: true, verified: false, tx_hash: txHash });
        results.push({ url: a.url, txHash, success: true });
      });
    } else {
      // Sequential fallback
      console.warn("⚠️ Batch TX failed — falling back to sequential");
      for (let i = 0; i < newOnes.length; i++) {
        const singleTx = await withRetry(async () => {
          const tx = await getContract(wallet).registerArticle(
            newHashes[i], newOnes[i].url
          );
          await tx.wait();
          console.log(`✅ [${i + 1}/${newOnes.length}] TX: ${tx.hash}`);
          return tx.hash;
        }, 2, `register[${i}]`);

        if (singleTx) {
          setCached(newHashes[i], { registered: true, verified: false, tx_hash: singleTx });
        }
        results.push({
          url:     newOnes[i].url,
          txHash:  singleTx ?? null,
          success: !!singleTx,
          error:   singleTx ? undefined : "TX failed after retries",
        });

        if (i < newOnes.length - 1) await new Promise(r => setTimeout(r, delayMs));
      }
    }
  } else {
    console.log(`⚡ All ${targets.length} already registered — 0 write TXs`);
  }

  // Mark already-registered in results
  targets.forEach((a, i) => {
    if (alreadyFlags[i])
      results.push({ url: a.url, txHash: null, alreadyRegistered: true, success: true });
  });

  console.log(`✅ Done: ${results.filter(r => r.success).length}/${targets.length} | cache size: ${verifiedCache.size}`);
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// VERIFY BATCH — called automatically after registration
// Uses VERIFIER_PRIVATE_KEY (Account 2) to mark articles as verified on-chain.
// Fire-and-forget from index.ts — does not block the response.
// Cache is updated immediately so next checkBatch returns verified: true.
// ════════════════════════════════════════════════════════════════════════════
export async function verifyBatchOnChain(
  articles: { content: string }[]
): Promise<boolean> {
  const verifierKey = Deno.env.get("VERIFIER_PRIVATE_KEY");
  if (!CONTRACT_ADDRESS || !verifierKey || !articles.length) {
    console.warn("⚠️ verifyBatchOnChain: skipping — no verifier key or empty list");
    return false;
  }

  try {
    const hashes = await Promise.all(
      articles
        .filter(a => a.content?.trim())
        .map(a => hashArticle(a.content).then(h => "0x" + h))
    );

    if (!hashes.length) return false;

    const verifierWallet = new ethers.Wallet(verifierKey, getProvider());

    const txHash = await withRetry(async () => {
      const tx = await getContract(verifierWallet).verifyBatch(hashes);
      await tx.wait();
      console.log(`✅ Verified ${hashes.length} articles — TX: ${tx.hash}`);
      return tx.hash;
    }, 2, "verifyBatch");

    if (txHash) {
      // Update cache immediately — next checkBatch sees verified: true
      hashes.forEach(hash => {
        const existing = getCached(hash);
        if (existing) {
          setCached(hash, { ...existing, verified: true });
        }
      });
      console.log(`✅ Cache updated — ${hashes.length} articles now verified: true`);
      return true;
    }

    return false;
  } catch (e: any) {
    console.error(`❌ verifyBatch failed: ${e.message}`);
    return false;
  }
}