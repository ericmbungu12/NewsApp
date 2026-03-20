// supabase/functions/fetch-news/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CONTRACT_ADDRESS, checkBatchOnChain, registerBatchOnChain,
  getNetworkType, hashArticle, verifyBatchOnChain,
} from "./blockchain.ts";
import { normalizeRegion, getRegionKey } from "./region.ts";
import {
  CACHE_DURATION_MS, normalizeForDisplay, normalizeForSearch,
  expandQueryForCoverage, detectIntent, detectEntityType,
  fetchAllSources, synthesizeWithGuaranteedCoverage,
  upsertDigestToSupabase, insertArticlesToSupabase,
  generateVerifiedDigest, generateUnverifiedDigest,
} from "./news_tier.ts";
import { extractCoreEntity, embedText, toVectorString } from "./fuzzy_search.ts";

// ── In-memory cache + anon rate limit ────────────────────────────────────────
const cache    = new Map<string, { expiry: number; data: unknown }>();
const anonHits = new Map<string, number>();

const getIP = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  req.headers.get("x-real-ip") ?? "unknown";

const cached = (k: string) => {
  const e = cache.get(k);
  return e && e.expiry > Date.now() ? e.data : null;
};
const setCache = (k: string, d: unknown) =>
  cache.set(k, { expiry: Date.now() + CACHE_DURATION_MS, data: d });

const freshLbl = (iso: string) => {
  const ms = Date.now() - new Date(iso || 0).getTime();
  return ms < 3.6e6 ? "breaking" : ms < 864e5 ? "today" : ms < 6048e5 ? "this_week" : "older";
};

const NO_BV = (x = {}) => ({
  status:           "not_registered",
  registered:       false,
  verified:         false,
  publisher:        null,
  registered_at:    null,
  contract_address: CONTRACT_ADDRESS ?? null,
  tx_hash:          null,
  badge:            "❌ Not registered",
  ...x,
});

const dedup = (a: any[]) => {
  const s = new Set<string>();
  return a.filter(x => {
    if (!x.url || s.has(x.url)) return false;
    s.add(x.url); return true;
  });
};

// Fire-and-forget patch — never blocks response
const sbPatch = (url: string, key: string, path: string, body: unknown) =>
  fetch(`${url}/rest/v1/${path}`, {
    method:  "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(5000),
  }).catch(e => console.warn(`sbPatch ${path}: ${e.message}`));

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — SOURCE RELIABILITY SCORING
// ════════════════════════════════════════════════════════════════════════════
const SOURCE_RELIABILITY_MAP: Record<string, number> = {
  "Reuters": 4.8, "AP": 4.8, "AP News": 4.8,
  "BBC News": 4.7, "BBC": 4.7, "BBC World": 4.7,
  "Al Jazeera": 4.6, "Al Jazeera English": 4.6,
  "The Guardian": 4.6, "NY Times": 4.6, "NPR": 4.6,
  "France 24": 4.5, "DW News": 4.5, "Sky News": 4.5,
  "Bloomberg": 4.5, "The Economist": 4.5,
  "ESPN": 4.3, "espn.co.uk": 4.3,
  "Sky Sports": 4.3, "Cricbuzz": 4.2,
  "Bleacher Report": 4.1, "beIN SPORTS": 4.0,
  "The Athletic": 4.2, "CBS Sports": 4.1,
  "Fox Sports": 4.0, "Goal.com": 3.9,
  "The Irish Times": 4.4, "RTE": 4.3,
  "CNA": 4.3, "Channel NewsAsia": 4.3,
  "USA Today": 4.0, "New York Post": 3.7,
  "Google News": 3.5, "Yahoo Entertainment": 3.2,
  "Slashdot.org": 3.0,
};

interface ReliabilityInfo {
  score: number; label: string; badge: string; explanation: string;
}

function getSourceReliability(source: string, tierReliability?: number): ReliabilityInfo {
  const knownScore = SOURCE_RELIABILITY_MAP[source];
  const score = Math.round((knownScore ?? tierReliability ?? 3.5) * 10) / 10;
  let label: string, badge: string, explanation: string;
  if (score >= 4.5) {
    label = "very_high"; badge = "🏅 Very High Reliability";
    explanation = `${source} is a major established outlet with strong editorial standards.`;
  } else if (score >= 4.0) {
    label = "high"; badge = "✅ High Reliability";
    explanation = `${source} is a reputable outlet with consistent fact-checking.`;
  } else if (score >= 3.5) {
    label = "moderate"; badge = "⚠️ Moderate Reliability";
    explanation = `${source} is generally reliable — verify key claims independently.`;
  } else {
    label = "low"; badge = "❓ Lower Reliability";
    explanation = `${source} is an aggregator or less-verified source — cross-check with primary outlets.`;
  }
  return { score, label, badge, explanation };
}

function buildReliabilityReport(articles: any[]): Record<string, any> {
  if (!articles.length) return {};
  const scores = articles.map(a =>
    getSourceReliability(a.source?.name ?? a.source ?? "Unknown", a.reliability).score
  );
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  const sourceBreakdown: Record<string, number> = {};
  for (const a of articles) {
    const src = a.source?.name ?? a.source ?? "Unknown";
    if (!sourceBreakdown[src])
      sourceBreakdown[src] = getSourceReliability(src, a.reliability).score;
  }
  return {
    average_reliability: Math.round(avg * 10) / 10,
    highest_reliability: Math.max(...scores),
    lowest_reliability:  Math.min(...scores),
    source_scores:       sourceBreakdown,
    reliability_summary: avg >= 4.5
      ? "Predominantly major outlets — very high confidence."
      : avg >= 4.0 ? "Mix of reputable sources — high confidence."
      : avg >= 3.5 ? "Mixed sources — moderate confidence, verify key claims."
      : "Lower-reliability sources — cross-check independently.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 5 — NARRATIVE DIVERGENCE DETECTION
// ════════════════════════════════════════════════════════════════════════════
interface NarrativePerspective {
  angle: string; framing: string; article_count: number;
  sources: string[]; representative_title: string;
  sentiment: "positive" | "negative" | "neutral" | "contested";
}

const NARRATIVE_CLUSTERS: Array<{
  angle: string; framing: string;
  sentiment: "positive" | "negative" | "neutral" | "contested";
  keywords: string[];
}> = [
  { angle: "Official result / winner declared", framing: "Outlets reporting the official outcome or declared winner.", sentiment: "neutral", keywords: ["declared","crowned","awarded","champion","winner","wins","won"] },
  { angle: "Result overturned / stripped", framing: "Outlets reporting a reversal, stripping of title, or overturned decision.", sentiment: "negative", keywords: ["stripped","overturned","reversed","forfeit","loses title","stripped of"] },
  { angle: "Protest / appeal / rejection", framing: "Outlets covering the losing side's response — protests, appeals, refusals.", sentiment: "contested", keywords: ["appeal","appeals","protest","reject","refuses","unfair","fight","denounce","fight is far"] },
  { angle: "Corruption / scandal allegation", framing: "Outlets alleging corruption, bribery, or institutional misconduct.", sentiment: "negative", keywords: ["corrupt","corruption","bribery","investigation","scandal","illegal","foul play","disgrace"] },
  { angle: "Governing body defends decision", framing: "Outlets quoting the governing body defending its ruling.", sentiment: "positive", keywords: ["president backs","stands firm","defends","justified","right decision","correct","upholds"] },
  { angle: "Fan / public reaction", framing: "Outlets covering crowd reaction, celebrations, or outrage from supporters.", sentiment: "neutral", keywords: ["fans","supporters","celebration","celebrates","rage","fury","crowd","streets","public"] },
  { angle: "Analysis / precedent / commentary", framing: "Opinion pieces and analysis examining broader implications.", sentiment: "neutral", keywords: ["precedent","analysis","opinion","commentary","implications","historic","unprecedented","what it means"] },
  { angle: "Military / conflict escalation", framing: "Outlets reporting military action, strikes, or armed conflict escalation.", sentiment: "negative", keywords: ["strike","strikes","attack","attacks","missile","bomb","war","troops","military"] },
  { angle: "Diplomatic / peace efforts", framing: "Outlets reporting negotiations, ceasefires, or diplomatic talks.", sentiment: "positive", keywords: ["ceasefire","truce","talks","diplomacy","negotiate","peace","deal","agreement"] },
  { angle: "Economic impact", framing: "Outlets covering financial, market, or economic consequences.", sentiment: "neutral", keywords: ["prices","oil","market","economy","economic","inflation","cost","financial","gas prices"] },
  { angle: "Health / outbreak", framing: "Outlets reporting health emergencies, disease outbreaks, or medical developments.", sentiment: "negative", keywords: ["outbreak","cases","deaths","disease","virus","epidemic","health","treatment","vaccine"] },
  { angle: "Election results / voting", framing: "Outlets covering election results, vote counts, or electoral processes.", sentiment: "neutral", keywords: ["election","vote","voted","results","wins election","elected","ballot","campaign"] },
];

function detectNarrativeDivergence(articles: any[]): {
  perspectives: NarrativePerspective[]; divergence_score: number; summary: string;
} {
  if (articles.length < 2) return {
    perspectives: [], divergence_score: 0,
    summary: "Not enough articles to detect narrative divergence.",
  };
  const matched = new Set<string>();
  const perspectives: NarrativePerspective[] = [];
  for (const cluster of NARRATIVE_CLUSTERS) {
    const clusterArticles = articles.filter(a => {
      if (matched.has(a.url)) return false;
      const text = `${a.title ?? ""} ${a.description ?? ""}`.toLowerCase();
      return cluster.keywords.some(kw => text.includes(kw));
    });
    if (!clusterArticles.length) continue;
    clusterArticles.forEach(a => matched.add(a.url));
    const sources = [...new Set(clusterArticles.map(a => a.source?.name ?? a.source ?? "Unknown"))].slice(0, 5);
    const best = clusterArticles.reduce((p, c) => (c.relevance_score ?? 0) > (p.relevance_score ?? 0) ? c : p);
    perspectives.push({
      angle: cluster.angle, framing: cluster.framing,
      article_count: clusterArticles.length, sources,
      representative_title: best.title ?? "", sentiment: cluster.sentiment,
    });
  }
  const unmatched = articles.filter(a => !matched.has(a.url));
  if (unmatched.length > 0) {
    perspectives.push({
      angle: "General reporting",
      framing: "Straight news coverage without a strong editorial angle.",
      article_count: unmatched.length,
      sources: [...new Set(unmatched.map(a => a.source?.name ?? a.source ?? "Unknown"))].slice(0, 5),
      representative_title: unmatched[0]?.title ?? "",
      sentiment: "neutral",
    });
  }
  perspectives.sort((a, b) => b.article_count - a.article_count);
  const uniqueSentiments = new Set(perspectives.map(p => p.sentiment)).size;
  const divergenceScore = Math.round(Math.min(1, (uniqueSentiments - 1) / 3 + (perspectives.length - 1) / 8) * 100) / 100;
  const topTwo = perspectives.slice(0, 2);
  const summary = perspectives.length <= 1
    ? "All sources are reporting this story with a consistent angle."
    : `${perspectives.length} distinct narrative angles detected. ` +
      topTwo.map(p => `${p.article_count} source${p.article_count > 1 ? "s" : ""} frame it as "${p.angle}"`).join(". ") + ".";
  return { perspectives, divergence_score: divergenceScore, summary };
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 6 — TEMPORAL NEWS GRAPH
// ════════════════════════════════════════════════════════════════════════════
interface TemporalNode {
  hour_utc: string; hour_label: string; article_count: number;
  on_chain_count: number; sources: string[]; dominant_angle: string;
  headlines: string[]; blockchain_proof: boolean;
}

function buildTemporalGraph(articles: any[]): {
  nodes: TemporalNode[]; story_duration: string;
  first_seen: string | null; last_seen: string | null; peak_hour: string | null;
} {
  if (!articles.length) return { nodes: [], story_duration: "No articles", first_seen: null, last_seen: null, peak_hour: null };
  const withTime = articles
    .map(a => ({ ...a, _ts: new Date(a.publishedAt ?? a.published_at ?? 0).getTime() }))
    .filter(a => a._ts > 0).sort((a, b) => a._ts - b._ts);
  if (!withTime.length) return { nodes: [], story_duration: "No timestamps", first_seen: null, last_seen: null, peak_hour: null };
  const buckets = new Map<string, typeof withTime>();
  for (const a of withTime) {
    const d = new Date(a._ts);
    const hour = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()))
      .toISOString().replace(":00:00.000Z", ":00Z");
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour)!.push(a);
  }
  const DAY_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const nodes: TemporalNode[] = [];
  let peakHour = "", peakCount = 0;
  for (const [hour, arts] of buckets) {
    const d = new Date(hour);
    const label = `${DAY_ABBR[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2,"0")}:00 UTC`;
    let dominantAngle = "General reporting", maxMatch = 0;
    for (const cluster of NARRATIVE_CLUSTERS) {
      const cnt = arts.filter(a => {
        const text = `${a.title ?? ""} ${a.description ?? ""}`.toLowerCase();
        return cluster.keywords.some(kw => text.includes(kw));
      }).length;
      if (cnt > maxMatch) { maxMatch = cnt; dominantAngle = cluster.angle; }
    }
    const onChainCount = arts.filter(a => a.blockchain_verification?.tx_hash || a.tx_hash).length;
    nodes.push({
      hour_utc: hour, hour_label: label,
      article_count: arts.length, on_chain_count: onChainCount,
      sources: [...new Set(arts.map(a => a.source?.name ?? a.source ?? "Unknown"))].slice(0, 4),
      dominant_angle: dominantAngle,
      headlines: arts.slice(0, 3).map(a => a.title ?? ""),
      blockchain_proof: onChainCount > 0,
    });
    if (arts.length > peakCount) { peakCount = arts.length; peakHour = hour; }
  }
  const firstTs = withTime[0]._ts;
  const lastTs  = withTime[withTime.length - 1]._ts;
  const durationHours = Math.round((lastTs - firstTs) / 3.6e6);
  const storyDuration = durationHours <= 1 ? "Story broke and peaked within 1 hour."
    : durationHours <= 24 ? `Story unfolded over ${durationHours} hours.`
    : `Story has been developing for ${Math.round(durationHours / 24)} day(s).`;
  return {
    nodes, story_duration: storyDuration,
    first_seen: new Date(firstTs).toISOString(),
    last_seen:  new Date(lastTs).toISOString(),
    peak_hour:  peakHour || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 7 — HYPER-LOCAL COVERAGE REPORT
// ════════════════════════════════════════════════════════════════════════════
const HYPER_LOCAL_TIERS = new Set([
  "gdelt","discovered_feed","rss_bridge","cascade_geo",
  "cascade_local","cascade_ddg","cascade_feedly","web_search",
]);
const MAINSTREAM_SOURCES = new Set([
  "BBC News","BBC","BBC World","Reuters","AP","AP News",
  "Al Jazeera","Al Jazeera English","The Guardian","NY Times",
  "NPR","France 24","DW News","Sky News","Bloomberg","CNN",
  "NBC News","Fox News","ABC News",
]);

function buildHyperLocalReport(articles: any[]): Record<string, any> {
  const uniqueSources = new Set(articles.map(a => a.source?.name ?? a.source ?? "Unknown"));
  const tierCounts: Record<string, number> = {};
  const hyperLocalSources = new Set<string>();
  let mainStreamCount = 0;
  for (const a of articles) {
    const tier = a.tier ?? "unknown";
    tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
    const src = a.source?.name ?? a.source ?? "Unknown";
    if (HYPER_LOCAL_TIERS.has(tier) && !MAINSTREAM_SOURCES.has(src)) hyperLocalSources.add(src);
    if (MAINSTREAM_SOURCES.has(src)) mainStreamCount++;
  }
  const hlCount = articles.filter(a => HYPER_LOCAL_TIERS.has(a.tier ?? "")).length;
  const hlSourceList = [...hyperLocalSources].slice(0, 10);
  const advantage = hlCount === 0
    ? "All results are from mainstream sources. For this topic, major outlets provided full coverage."
    : `Found ${hlCount} article${hlCount > 1 ? "s" : ""} from ${hlSourceList.length} source${hlSourceList.length > 1 ? "s" : ""} that Google News and ChatGPT typically miss — including GDELT's global network of 65,000 outlets and independently discovered feeds.`;
  return {
    total_unique_sources: uniqueSources.size,
    mainstream_count:    mainStreamCount,
    hyper_local_count:   hlCount,
    hyper_local_sources: hlSourceList,
    coverage_advantage:  advantage,
    tier_breakdown:      tierCounts,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — RANKING TRANSPARENCY REPORT
// ════════════════════════════════════════════════════════════════════════════
function buildRankingTransparency(isPersonalised: boolean): Record<string, any> {
  return {
    method: isPersonalised
      ? "Reinforcement Learning (RL) with personal digital twin"
      : "Reinforcement Learning (RL) — general ranking, no personal data",
    factors: [
      { factor: "Query relevance",         weight: "30%", description: "TF-IDF and semantic similarity between article and search query." },
      { factor: "Blockchain trust signal", weight: "20%", description: "Articles registered and verified on-chain receive a higher trust boost." },
      { factor: "Topic match",             weight: "20%", description: "Articles specifically about the searched topic rank above general news." },
      { factor: "Source reliability",      weight: "15%", description: "Established outlets with strong editorial standards rank higher." },
      { factor: "Reader engagement",       weight: "10%", description: isPersonalised
        ? "Your personal reading patterns — clicks, read time, thumbs up — from your digital twin."
        : "Aggregate engagement signals from all readers (no personal data used)." },
      { factor: "Freshness",               weight: "5%",  description: "More recent articles ranked slightly higher within the same relevance band." },
    ],
    personalised:       isPersonalised,
    ad_influence:       false,
    filter_bubble_risk: isPersonalised ? "low" : "none",
    statement: isPersonalised
      ? "Your results are ranked by your own reading patterns — not by advertising relationships or platform engagement maximisation. Your digital twin is visible and resettable in settings."
      : "Results are ranked by relevance, source reliability, and blockchain trust signals. No advertising influences ranking. No personal data is used for anonymous sessions.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TOPIC SPECIFICITY SPLIT
//
// ⚠️  MUST run BEFORE RL ranking (Phase 3 before Phase 4).
//
// WHY ORDER MATTERS:
//   OLD (broken) order:  RL rank ALL → splitByTopicRelevance
//   NEW (fixed) order:   splitByTopicRelevance → RL rank each group
//
// The old order meant which articles got blockchain-registered depended
// on the RL engine's output. The Render free tier cold-starts the Python
// process on every request, producing slightly different TF-IDF rankings
// each time. This caused different articles to be verified on curl vs app
// even for identical searches.
//
// This function is a pure keyword match — no network, no randomness.
// Same query + same article pool → always same topicSpecific set.
// RL then only controls ORDER within each group, not group membership.
// ════════════════════════════════════════════════════════════════════════════
function splitByTopicRelevance(
  articles: any[], core: string
): { topicSpecific: any[]; offTopic: any[] } {
  const topicWords = core.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (topicWords.length === 0) {
    return { topicSpecific: articles.filter(a => a.description?.trim()), offTopic: [] };
  }
  const isTopicMatch = (a: any): boolean => {
    if (!a.description?.trim() && !a.title?.trim()) return false;
    const text = `${a.title ?? ""} ${a.description ?? ""}`.toLowerCase();
    return topicWords.some(w => text.includes(w));
  };
  const topicSpecific = articles.filter(isTopicMatch);
  const offTopic      = articles.filter(a => !isTopicMatch(a));
  console.log(
    `🎯 Pre-RL split: ${topicSpecific.length} topic-specific | ` +
    `${offTopic.length} off-topic | keywords: [${topicWords.join(", ")}]`
  );
  return { topicSpecific, offTopic };
}

// ── Normalise an article into RL engine input shape ───────────────────────────
// Extracted as a helper so both rankWithRL calls use identical field mapping.
const toRLInput = (a: any) => ({
  ...a,
  source:          a.source?.name ?? a.source ?? "Unknown",
  freshness_label: freshLbl(a.publishedAt ?? a.published_at ?? ""),
  cluster_tag:     a.tier ?? "general",
  relevance_score: a.relevance_score ?? 0.5,
});

// ── Vector search helpers ─────────────────────────────────────────────────────
async function vectorSearchNews(topic: string, sbUrl: string, sbKey: string, limit = 20): Promise<any[]> {
  try {
    const vector = toVectorString(embedText(topic));
    const r = await fetch(`${sbUrl}/rest/v1/rpc/search_news_by_vector`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query_embedding: vector, match_threshold: 0.4, match_count: limit }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    const results = await r.json();
    console.log(`✅ Vector search: ${results.length}`);
    return results.map((a: any) => ({ ...a, tier: "vector_search", publishedAt: a.published_at }));
  } catch (e: any) { console.warn("Vector search:", e.message); return []; }
}

async function vectorSearchDigests(topic: string, sbUrl: string, sbKey: string, limit = 5): Promise<any[]> {
  try {
    const vector = toVectorString(embedText(topic));
    const r = await fetch(`${sbUrl}/rest/v1/rpc/search_digests_by_vector`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query_embedding: vector, match_threshold: 0.4, match_count: limit }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    return await r.json();
  } catch (e: any) { console.warn("Digest vector search:", e.message); return []; }
}

// ── RL Engine ─────────────────────────────────────────────────────────────────
async function rankWithRL(articles: any[], query: string, twin: any | null): Promise<any[]> {
  if (!articles.length) return articles;
  try {
    const r = await fetch("https://newsapp-63t4.onrender.com/rank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        articles: articles.map(a => ({
          url:             a.url,
          title:           a.title,
          description:     a.description || "",
          source:          a.source || "",
          topic:           a.cluster_tag || "",
          cluster_tag:     a.cluster_tag || "",
          published_at:    a.published_at || "",
          freshness_label: a.freshness_label || "",
          relevance_score: a.relevance_score ?? 0.5,
          blockchain_verification: a.blockchain_verification ?? null,
        })),
        twin: twin ? {
          topic_preferences:  twin.topic_preferences  || {},
          source_preferences: twin.source_preferences || {},
          total_clicks:       twin.total_clicks       || 0,
          total_views:        twin.total_views        || 0,
          total_skips:        twin.total_skips        || 0,
          total_thumbs_up:    twin.total_thumbs_up    || 0,
          total_thumbs_down:  twin.total_thumbs_down  || 0,
          avg_view_time:      twin.avg_view_time      || 0.0,
        } : null,
        query,
      }),
      signal: AbortSignal.timeout(30000), // survives Render free-tier cold start
    });
    if (!r.ok) { console.warn("RL error:", r.status); return articles; }
    const data = await r.json();
    console.log(`🤖 RL ranked ${data.total} | personalized=${data.personalized} | verified_in_top=${data.verified_in_top ?? 0}`);
    return data.ranked_articles.map((ra: any) => ({
      ...(articles.find(a => a.url === ra.article.url) ?? ra.article),
      personalization_score: ra.personalization_score,
      why_recommended:       ra.why,
    }));
  } catch (e: any) { console.warn("RL unavailable:", e.message); return articles; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const ENV = {
    groq:       Deno.env.get("GROQ_API_KEY"),
    gemini:     Deno.env.get("GEMINI_API_KEY"),
    gnews:      Deno.env.get("GNEWS_API_KEY"),
    newsapi:    Deno.env.get("NEWSAPI_KEY"),
    currents:   Deno.env.get("CURRENTS_API_KEY"),
    thenewsapi: Deno.env.get("THENEWSAPI_KEY"),
    youtube:    Deno.env.get("YOUTUBE_API_KEY"),
    newsdata:   Deno.env.get("NEWSDATA_API_KEY"),
    sbUrl:      Deno.env.get("SUPABASE_URL")!,
    sbKey:      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    sbAnon:     Deno.env.get("SUPABASE_ANON_KEY")!,
  };

  if (!ENV.sbUrl || !ENV.sbKey)
    return new Response(JSON.stringify({ error: "Missing Supabase env" }), { status: 500 });

  try {
    // ── Auth + rate limit ──────────────────────────────────────────────────
    const ip         = getIP(req);
    const authHeader = req.headers.get("Authorization");
    const isLoggedIn = !!authHeader?.match(/^Bearer .{33,}/);
    if (!isLoggedIn) {
      if ((anonHits.get(ip) ?? 0) >= 1)
        return new Response(
          JSON.stringify({ error: "Login required", success: false, articles: [] }),
          { status: 402 }
        );
      anonHits.set(ip, (anonHits.get(ip) ?? 0) + 1);
      setTimeout(() => { if ((anonHits.get(ip) ?? 0) <= 1) anonHits.delete(ip); }, 36e5);
    }

    // ── Parse request ──────────────────────────────────────────────────────
    const { topic = "latest news", region = "global" } = await req.json();
    const rawTopic     = topic.toString().trim();
    const regionKey    = getRegionKey(normalizeRegion(region.toString()));
    const displayTopic = normalizeForDisplay(rawTopic);
    const searchQuery  = normalizeForSearch(rawTopic);
    const core         = extractCoreEntity(rawTopic);
    const intent       = detectIntent(rawTopic);
    const entityType   = detectEntityType(rawTopic, rawTopic);
    const queries      = expandQueryForCoverage(rawTopic, regionKey, entityType);
    const cacheKey     = `digest_${displayTopic}_${regionKey}`;
    console.log(`\n🔍 "${rawTopic}" → "${core}" | region=${regionKey} | intent=${intent}`);

    // ── Load digital twin ──────────────────────────────────────────────────
    let userTwin: any = null;
    if (isLoggedIn && authHeader) {
      try {
        const uc = createClient(ENV.sbUrl, ENV.sbAnon, { global: { headers: { Authorization: authHeader } } });
        const { data: { user } } = await uc.auth.getUser();
        if (user) {
          const { data: twin } = await uc.from("digital_twins").select("*").eq("user_id", user.id).single();
          if (twin) { userTwin = twin; console.log(`🧠 Twin loaded`); }
        }
      } catch (e: any) { console.warn("Twin failed:", e.message); }
    }

    // ── PHASE 1: Sources + vector DB — all in parallel ─────────────────────
    const [freshResult, vectorArticles, similarDigests] = await Promise.all([
      fetchAllSources(searchQuery, regionKey, queries, {
        gnewsKey:      ENV.gnews      ?? undefined,
        newsapiKey:    ENV.newsapi    ?? undefined,
        currentsKey:   ENV.currents   ?? undefined,
        thenewsapiKey: ENV.thenewsapi ?? undefined,
        youtubeKey:    ENV.youtube    ?? undefined,
        newsdataKey:   ENV.newsdata   ?? undefined,
      }),
      vectorSearchNews(core, ENV.sbUrl, ENV.sbKey, 20),
      vectorSearchDigests(core, ENV.sbUrl, ENV.sbKey, 5),
    ]);

    const { wiki, wikidata, sourceCounts } = freshResult;

    // ── PHASE 2: Merge + synthesize ────────────────────────────────────────
    const mergedArticles = dedup([...freshResult.articles, ...vectorArticles]);
    console.log(`📊 Fresh:${freshResult.articles.length} Vector:${vectorArticles.length} Merged:${mergedArticles.length}`);

    const { digest_source_urls, digest_reliability, articles: finalArticles, coverage_tier } =
      synthesizeWithGuaranteedCoverage(mergedArticles, wiki, displayTopic, entityType);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 3: TOPIC SPLIT — deterministic keyword match, runs BEFORE RL
    //
    // This is the key fix for the curl-vs-app discrepancy.
    // splitByTopicRelevance is a pure string operation: same articles +
    // same core → always the same topicSpecific set, regardless of which
    // Render instance serves the request or how warm it is.
    // ════════════════════════════════════════════════════════════════════════
    const { topicSpecific: rawTopicSpecific, offTopic: rawOffTopic } =
      splitByTopicRelevance(finalArticles, core);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 4: RL ranks WITHIN each group separately
    //
    // Two parallel RL calls — one per group.
    // RL controls ORDER within each group, not which group an article
    // belongs to. Cold-start ranking variance no longer affects which
    // articles get blockchain-registered.
    // ════════════════════════════════════════════════════════════════════════
    const [topicSpecific, offTopic] = await Promise.all([
      rankWithRL(rawTopicSpecific.map(toRLInput), displayTopic, userTwin),
      rankWithRL(rawOffTopic.map(toRLInput),      displayTopic, userTwin),
    ]);

    console.log(`🔗 To blockchain: ${topicSpecific.length} topic-specific | Off-topic: ${offTopic.length}`);

    // Combined list for features that need the full article pool
    const allRanked = [...topicSpecific, ...offTopic];

    // ── PHASE 5: CONCURRENT — blockchain + LLMs + features 4–8 ───────────
    // Features 4–8 are pure in-memory CPU — zero network cost.
    // They run in the same Promise.all as blockchain + GROQ + Gemini,
    // adding ZERO latency to the response.
    const [
      batchResults,
      verified_digest,
      unverified_digest,
      narrativeDivergence,
      temporalGraph,
      hyperLocalReport,
      rankingTransparency,
      topicReliabilityReport,
      offTopicReliabilityReport,
    ] = await Promise.all([
      registerBatchOnChain(
        topicSpecific.map(a => ({ content: a.description, url: a.url })),
        200
      ),
      generateVerifiedDigest(topicSpecific, displayTopic, ENV.groq ?? ""),
      generateUnverifiedDigest(offTopic, displayTopic, ENV.gemini ?? ""),
      Promise.resolve(detectNarrativeDivergence(topicSpecific)),
      Promise.resolve(buildTemporalGraph(allRanked)),
      Promise.resolve(buildHyperLocalReport(allRanked)),
      Promise.resolve(buildRankingTransparency(!!userTwin)),
      Promise.resolve(buildReliabilityReport(topicSpecific)),
      Promise.resolve(buildReliabilityReport(offTopic)),
    ]);

    const txMap = new Map(batchResults.map(r => [r.url, r]));

    // Persist tx_hashes — fire and forget
    batchResults.filter(r => r.txHash).forEach(r =>
      sbPatch(ENV.sbUrl, ENV.sbKey,
        `news?url=eq.${encodeURIComponent(r.url)}`,
        { tx_hash: r.txHash, is_verified: false, blockchain_registered_at: new Date().toISOString() }
      )
    );

    // Verification — fire and forget (VERIFIER_PRIVATE_KEY / Account 2)
    verifyBatchOnChain(
      topicSpecific
        .filter(a => txMap.get(a.url)?.success)
        .map(a => ({ content: a.description }))
    ).catch(() => {});

    // Batch check on-chain status
    const batchChecks = await checkBatchOnChain(
      topicSpecific.map(a => ({ content: a.description, cachedHash: null }))
    );
    const checkMap = new Map(topicSpecific.map((a, i) => [a.url, batchChecks[i]]));

    // ── PHASE 6: Build article objects ─────────────────────────────────────
    const buildArticle = async (a: any, isTopicArticle: boolean) => {
      const reg  = txMap.get(a.url);
      const chk  = checkMap.get(a.url);
      let txHash = reg?.txHash ?? null;

      if (isTopicArticle && reg?.alreadyRegistered && !txHash) {
        try {
          const r = await fetch(
            `${ENV.sbUrl}/rest/v1/news?url=eq.${encodeURIComponent(a.url)}&select=tx_hash`,
            { headers: { apikey: ENV.sbKey, Authorization: `Bearer ${ENV.sbKey}` }, signal: AbortSignal.timeout(2000) }
          );
          const rows = await r.json();
          if (rows?.[0]?.tx_hash) txHash = rows[0].tx_hash;
        } catch {}
      }

      const isRegistered = isTopicArticle && !!(txHash || reg?.alreadyRegistered);
      const srcName      = a.source?.name ?? a.source ?? "Unknown";
      const reliability  = getSourceReliability(srcName, a.reliability);

      return {
        title:                 a.title,
        description:           a.description ?? a.summary ?? "",
        url:                   a.url,
        image:                 a.image ?? null,
        source:                srcName,
        published_at:          a.publishedAt ?? a.published_at ?? new Date().toISOString(),
        freshness_label:       freshLbl(a.publishedAt ?? a.published_at ?? ""),
        cluster_tag:           a.tier ?? "general",
        relevance_score:       a.relevance_score ?? 0.85,
        personalization_score: a.personalization_score ?? null,
        why_recommended:       a.why_recommended ?? null,
        tier:                  a.tier ?? "general",
        source_reliability: {
          score:       reliability.score,
          label:       reliability.label,
          badge:       reliability.badge,
          explanation: reliability.explanation,
        },
        blockchain_verification: isRegistered ? {
          status:           "registered",
          registered:       true,
          verified:         chk?.verified ?? false,
          publisher:        chk?.publisher ?? null,
          registered_at:    chk?.timestamp ?? new Date().toISOString(),
          contract_address: CONTRACT_ADDRESS ?? null,
          tx_hash:          txHash,
          badge:            "✅ Registered on-chain",
          content_hash:     a.description ? "0x" + await hashArticle(a.description) : null,
        } : NO_BV(),
      };
    };

    const [topicArticleObjs, offTopicArticleObjs] = await Promise.all([
      Promise.all(topicSpecific.map(a => buildArticle(a, true))),
      Promise.all(offTopic.map(a => buildArticle(a, false))),
    ]);

    const confirmedRegistered = topicArticleObjs.filter(a => a.blockchain_verification.registered);
    const failedRegistration  = topicArticleObjs.filter(a => !a.blockchain_verification.registered);
    const allUnverified       = [...failedRegistration, ...offTopicArticleObjs];
    const articles            = [...confirmedRegistered, ...allUnverified];

    // ── PHASE 7: Persist — all fire-and-forget ─────────────────────────────
    upsertDigestToSupabase(
      ENV.sbUrl, ENV.sbKey, rawTopic, regionKey,
      verified_digest, unverified_digest,
      digest_reliability, digest_source_urls
    ).catch(() => {});

    insertArticlesToSupabase(
      ENV.sbUrl, ENV.sbKey,
      confirmedRegistered.map(a => ({ ...a, publishedAt: a.published_at })),
      rawTopic, regionKey, CONTRACT_ADDRESS ?? null
    ).catch(() => {});

    insertArticlesToSupabase(
      ENV.sbUrl, ENV.sbKey,
      allUnverified.map(a => ({ ...a, publishedAt: a.published_at })),
      rawTopic, regionKey, null
    ).catch(() => {});

    setCache(cacheKey, { verified_digest, unverified_digest, digest_reliability, coverage_tier });

    // ── PHASE 8: Respond ───────────────────────────────────────────────────
    return new Response(JSON.stringify({
      success: true,

      search: {
        original:               rawTopic,
        core_entity:            core,
        normalized_for_display: displayTopic,
        normalized_for_search:  searchQuery,
        query_expansions:       queries,
        region:                 regionKey,
        intent,
        entityType,
        coverage_tier,
      },

      digest: {
        verified_digest,
        unverified_digest,
        summary:              `✅ TOPIC-SPECIFIC (ON-CHAIN):\n${verified_digest}\n\n⚠️ GENERAL NEWS:\n${unverified_digest}`,
        reliability:          digest_reliability,
        source_count:         digest_source_urls.length,
        source_urls:          digest_source_urls,
        coverage_quality:     coverage_tier,
        wikipedia_background: wiki ?? null,
        wikidata_context:     wikidata ?? null,
        similar_past_digests: similarDigests,
      },

      articles,

      reliability_report: {
        topic_specific: topicReliabilityReport,
        off_topic:      offTopicReliabilityReport,
        note: "Reliability scores reflect editorial standards and fact-checking track record. Neither Google (SEO-ranked) nor ChatGPT (no source metadata) surfaces this.",
      },

      narrative_divergence: {
        ...narrativeDivergence,
        note: "Shows how different outlets frame the same story — the full spectrum of how the world is reporting, not one narrative thread.",
      },

      temporal_graph: {
        ...temporalGraph,
        note: "How this story evolved hour by hour. Nodes with blockchain_proof=true have cryptographic timestamps — immutable proof of when information first appeared.",
      },

      hyper_local_coverage: {
        ...hyperLocalReport,
        note: "Sources like GDELT (65,000 global outlets), Feedly-discovered feeds, and RSS Bridge surface news that Google deprioritises and ChatGPT never trained on.",
      },

      ranking_transparency: {
        ...rankingTransparency,
        note: "We show you exactly why results are ranked as they are. No advertising influences our ranking — ever.",
      },

      blockchain: {
        enabled:               !!CONTRACT_ADDRESS,
        contract_address:      CONTRACT_ADDRESS ?? null,
        network:               getNetworkType(),
        topic_specific_count:  confirmedRegistered.length,
        off_topic_count:       allUnverified.length,
        total_articles:        articles.length,
        coverage:              "all_topic_specific",
        // Updated strategy label — confirms pre-RL split is active
        verification_strategy: "topic_keyword_match_pre_rl",
      },

      meta: {
        source_breakdown:      sourceCounts,
        total_fresh:           freshResult.articles.length,
        total_from_vector_db:  vectorArticles.length,
        total_merged:          mergedArticles.length,
        total_after_synthesis: finalArticles.length,
        topic_specific:        topicSpecific.length,
        off_topic:             offTopic.length,
        blockchain_registered: batchResults.filter(r => r.success).length,
        auth_status:           isLoggedIn ? "logged_in" : "anonymous",
        searches_remaining:    isLoggedIn ? "unlimited" : 0,
        timestamp:             new Date().toISOString(),
      },
    }, null, 2), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });

  } catch (err: any) {
    console.error("🔥", err);
    return new Response(JSON.stringify({
      success:  false, error: "Service error",
      message:  "Failed to fetch news. Please try again shortly.",
      articles: [],
      digest:   { summary: "Unable to fetch news.", reliability: 0, source_count: 0, source_urls: [], coverage_quality: "error" },
      blockchain: { enabled: !!CONTRACT_ADDRESS, contract_address: CONTRACT_ADDRESS ?? null, network: getNetworkType() },
      meta: { timestamp: new Date().toISOString() },
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});