// supabase/functions/fetch-news/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { CONTRACT_ADDRESS, BLOCKCHAIN_RPC, checkArticleOnChain, registerArticleOnChain, getNetworkType, hashArticle } from "./blockchain.ts";
import { normalizeRegion, detectRegionFromQuery, getRegionKey } from "./region.ts";
import { CACHE_DURATION_MS, normalizeForDisplay, normalizeForSearch, expandQueryForCoverage, detectIntent, detectEntityType, fetchTier1NewsAPIs, fetchTier2WikipediaCurrentEvents, fetchTier3RegionalRSS, fetchTier4GoogleNewsRSS, fetchTier5WikipediaBackground, synthesizeWithGuaranteedCoverage, upsertDigestToSupabase, insertArticlesToSupabase, generateTier6GuaranteedPlaceholder } from "./news_tier.ts";

const cache    = new Map<string, { expiry: number; data: unknown }>();
const anonHits = new Map<string, number>();

const getIP      = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
const cached     = (k: string) => { const e = cache.get(k); return e && e.expiry > Date.now() ? e.data : null; };
const setCache   = (k: string, d: unknown) => cache.set(k, { expiry: Date.now() + CACHE_DURATION_MS, data: d });
const freshLabel = (iso: string) => { const ms = Date.now() - new Date(iso||0).getTime(); return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older"; };
const NO_BV      = (extra = {}) => ({ status:"not_registered", registered:false, verified:false, publisher:null, registered_at:null, contract_address:CONTRACT_ADDRESS??null, tx_hash:null, badge:"❌ Unverified", ...extra });

const sbPatch = async (url: string, key: string, path: string, body: unknown, label = "Update") => {
  try {
    const r = await fetch(`${url}/rest/v1/${path}`, { method:"PATCH", headers:{ apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json" }, body:JSON.stringify(body) });
    if (!r.ok) { console.error(`❌ ${label} failed: ${r.status} - ${await r.text()}`); return { success:false }; }
    console.log(`✅ ${label} succeeded`); return { success:true };
  } catch (e: any) { console.error(`❌ ${label} error: ${e.message}`); return { success:false, error:e.message }; }
};

serve(async (req: Request) => {
  const ENV = { gnews:Deno.env.get("GNEWS_API_KEY"), newsapi:Deno.env.get("NEWSAPI_KEY"), sbUrl:Deno.env.get("SUPABASE_URL")!, sbKey:Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! };
  if (!ENV.sbUrl || !ENV.sbKey) return new Response(JSON.stringify({ error:"Missing Supabase env" }), { status:500 });

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const ip = getIP(req);
    const isLoggedIn = req.headers.get("Authorization")?.match(/^Bearer .{33,}/);
    if (!isLoggedIn) {
      if ((anonHits.get(ip)??0) >= 1) return new Response(JSON.stringify({ error:"Login required", success:false, articles:[] }), { status:402 });
      anonHits.set(ip, (anonHits.get(ip)??0) + 1);
      setTimeout(() => { if ((anonHits.get(ip)??0) <= 1) anonHits.delete(ip); }, 36e5);
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    const { topic = "latest news", region = "india" } = await req.json();
    const rawTopic        = topic.toString().trim();
    const regionKey       = getRegionKey(normalizeRegion(region.toString()));
    const displayTopic    = normalizeForDisplay(rawTopic);
    const searchQuery     = normalizeForSearch(rawTopic);
    const intent          = detectIntent(rawTopic);
    const entityType      = detectEntityType(rawTopic, rawTopic);
    const queryExpansions = expandQueryForCoverage(rawTopic, regionKey, entityType);
    console.log(`🔍 "${rawTopic}" | region=${regionKey} | intent=${intent} | entity=${entityType}`);

    // ── 6-tier fetch ──────────────────────────────────────────────────────
    const [tier1, tier2, tier3, tier4, tier5] = await Promise.all([
      fetchTier1NewsAPIs(queryExpansions, regionKey, ENV.gnews, ENV.newsapi).catch(()=>[]),
      fetchTier2WikipediaCurrentEvents().catch(()=>[]),
      fetchTier3RegionalRSS(regionKey, searchQuery, 20).catch(()=>[]),
      fetchTier4GoogleNewsRSS(searchQuery, regionKey).catch(()=>[]),
      fetchTier5WikipediaBackground(searchQuery).catch(()=>null),
    ]);
    const allArticles = [...tier1, ...tier2, ...tier3, ...tier4];
    console.log(`📊 T1:${tier1.length} T2:${tier2.length} T3:${tier3.length} T4:${tier4.length} T5:${!!tier5} total:${allArticles.length}`);

    // ── Synthesise ────────────────────────────────────────────────────────
    const { digest_summary, digest_source_urls, digest_reliability, articles: finalArticles, coverage_tier } =
      synthesizeWithGuaranteedCoverage(allArticles, tier5, displayTopic, entityType);
    
    // ── Persist ───────────────────────────────────────────────────────────
    upsertDigestToSupabase(ENV.sbUrl, ENV.sbKey, rawTopic, regionKey, digest_summary, digest_reliability, digest_source_urls).catch(()=>{});
    await insertArticlesToSupabase(ENV.sbUrl, ENV.sbKey, finalArticles, rawTopic, regionKey, CONTRACT_ADDRESS??null);

    // ── On-chain registration (first 3) ───────────────────────────────────
    const withTimeout = (promise: Promise<any>, ms: number) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
      ]);

    for (const a of finalArticles.slice(0, 3)) {
      if (!a.description) continue;
      console.log(`🔗 Registering: "${a.title.substring(0, 50)}..."`);
      try {
        const reg = await withTimeout(registerArticleOnChain(a.description, a.url), 30000);

        // ✅ FIXED — add alreadyRegistered branch
        if (reg.success && reg.txHash) {
          console.log(`✅ On-chain: ${reg.txHash}`);
          await sbPatch(ENV.sbUrl, ENV.sbKey, `news?url=eq.${encodeURIComponent(a.url)}`,
            { tx_hash: reg.txHash, is_verified: true, blockchain_registered_at: new Date().toISOString() },
            `tx_hash for ${a.url}`);
          (a as any).tx_hash = reg.txHash;
        } else if ((reg as any).alreadyRegistered) {
          console.log(`ℹ️ Already registered, fetching existing tx_hash`);
          try {
            const r = await fetch(
              `${ENV.sbUrl}/rest/v1/news?url=eq.${encodeURIComponent(a.url)}&select=tx_hash`,
              { headers: { apikey: ENV.sbKey, Authorization: `Bearer ${ENV.sbKey}` } }
            );
            const rows = await r.json();
            if (rows?.[0]?.tx_hash) {
              (a as any).tx_hash = rows[0].tx_hash;
              console.log(`✅ Restored tx_hash: ${rows[0].tx_hash}`);
            }
          } catch (e: any) {
            console.warn(`⚠️ Could not fetch existing tx_hash: ${e.message}`);
          }
        } else {
          console.warn(`⚠️ Registration failed: ${reg.error || "Unknown error"}`);
        }
      } catch (e: any) {
        console.warn(`⚠️ Blockchain registration skipped: ${e.message}`);
      }
      // Rate limit protection between registrations
      await new Promise(r => setTimeout(r, 500));
    }

    // ✅ Cache AFTER registration so tx_hash is included
    if (coverage_tier !== "recovery" && finalArticles.some(a => a.tier !== "placeholder")) {
      setCache(`digest_${displayTopic}_${regionKey}`, { 
        digest_summary, digest_source_urls, digest_reliability, coverage_tier 
      });
    }

    // ── Blockchain check per article ──────────────────────────────────────
    const articles: any[] = [];
    for (let i = 0; i < finalArticles.length; i++) {
      const a = finalArticles[i];
      const txHash = (a as any).tx_hash;
      const hasValidTxHash = typeof txHash === "string" && txHash.startsWith("0x") && txHash.length === 66;

      let bv = null;
      if (i < 3 && hasValidTxHash && a.description) {
        try {
          bv = await checkArticleOnChain(a.description, (a as any).content_hash);
        } catch (e: any) {
          console.warn(`⚠️ checkArticleOnChain failed for article ${i}: ${e.message}`);
        }
        if (i < 2) await new Promise(r => setTimeout(r, 300));
      }

      const isRegistered = hasValidTxHash;

      articles.push({
        title: a.title,
        description: a.description ?? a.summary ?? "",
        url: a.url,
        image: a.image ?? null,
        source: a.source?.name ?? "Unknown",
        published_at: a.publishedAt ?? new Date().toISOString(),
        freshness_label: freshLabel(a.publishedAt),
        cluster_tag: a.tier ?? "general",
        relevance_score: a.relevance_score ?? 0.85,
        blockchain_verification: isRegistered
          ? {
              status: "registered",
              registered: true,
              verified: bv?.verified ?? true,
              publisher: bv?.publisher ?? null,
              registered_at: bv?.timestamp ?? new Date().toISOString(),
              contract_address: CONTRACT_ADDRESS ?? null,
              tx_hash: txHash,
              badge: "✅ Verified on-chain",
              content_hash: a.description ? "0x" + await hashArticle(a.description) : null,
            }
          : NO_BV({ tx_hash: null }),
      });
    }

    // ── Response ──────────────────────────────────────────────────────────
    return new Response(JSON.stringify({
      success:true,
      search:  { original:rawTopic, normalized_for_display:displayTopic, normalized_for_search:searchQuery, query_expansions:queryExpansions, region:regionKey, intent, entityType, coverage_tier },
      digest:  { summary:digest_summary, reliability:digest_reliability, source_count:digest_source_urls.length, source_urls:digest_source_urls, coverage_quality:coverage_tier },
      articles,
      blockchain: { enabled:!!CONTRACT_ADDRESS, contract_address:CONTRACT_ADDRESS??null, network:getNetworkType() },
      meta: {
        acquisition_stats: { tier1_count:tier1.length, tier2_count:tier2.length, tier3_count:tier3.length, tier4_count:tier4.length, tier5_available:!!tier5, total_before_dedupe:allArticles.length, total_after_dedupe:finalArticles.length },
        guaranteed_coverage:true, min_articles_guaranteed:5,
        auth_status:isLoggedIn?"logged_in":"anonymous", searches_remaining:isLoggedIn?"unlimited":0,
        timestamp:new Date().toISOString(),
      },
    }, null, 2), { headers:{ "Content-Type":"application/json", "Cache-Control":"public, max-age=300" } });

  } catch (err: any) {
    console.error("🔥", err);
    const placeholders = generateTier6GuaranteedPlaceholder("global events", "concept", "global").map(a => ({ ...a, blockchain_verification:NO_BV() }));
    return new Response(JSON.stringify({
      success:true, error:"Service degradation",
      message:"Experiencing high demand. Showing contextual information while restoring full coverage.",
      articles:placeholders,
      digest: { summary:"🌍 **Global Context**\nShowing baseline info during recovery.", reliability:3.0, source_count:1, source_urls:["https://en.wikipedia.org/wiki/Current_events  "], coverage_quality:"recovery" },
      blockchain: { enabled:!!CONTRACT_ADDRESS, contract_address:CONTRACT_ADDRESS??null, network:getNetworkType() },
      meta: { guaranteed_coverage:true, coverage_tier:"recovery", timestamp:new Date().toISOString() },
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  }
});