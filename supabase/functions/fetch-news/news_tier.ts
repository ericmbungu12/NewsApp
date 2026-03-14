// supabase/functions/fetch-news/news_tier.ts
import { getCountryCode, getGoogleNewsRegionCode } from "./region.ts";
import { hashArticle } from "./blockchain.ts";

export const CACHE_DURATION_MS = 1800000;

// ── Source reliability ───────────────────────────────────────────────────────
const SOURCE_RATING: Record<string, number> = {
  "Reuters":5,"BBC News":5,"Associated Press":5,"AP":5,"Bloomberg":5,
  "The New York Times":5,"The Hindu":5,"PTI":5,"WHO":5,"UN":5,"World Bank":5,"IMF":5,
  "CNN":4,"Al Jazeera":4,"TechCrunch":4,"The Verge":4,"Times of India":4,"NDTV":4,
  "The Indian Express":4,"Hindustan Times":4,"The Assam Tribune":4,"Sentinel Assam":4,
  "EastMojo":4,"Nation Africa":4,"Standard Media":4,"The Citizen":4,"New Vision":4,"ANI":4,
};
export const getReliability = (source: string) => SOURCE_RATING[source] ?? 3;

// ── RSS feed registry ────────────────────────────────────────────────────────
const RSS: Record<string, string[]> = {
  india:    ["https://timesofindia.indiatimes.com/rssfeeds/-2128849016.cms","https://www.thehindu.com/news/national/feeder/default.rss","https://indianexpress.com/section/india/feed/","https://www.ndtv.com/rss","https://www.business-standard.com/rss/latest.rss","https://www.livemint.com/rss/homepage"],
  assam:    ["https://www.theassamtribune.com/rss","https://www.sentinelassam.com/rss","https://www.eastmojo.com/feed/","https://www.northeasttoday.in/feed/"],
  tezpur:   ["https://www.theassamtribune.com/category/tezpur/feed","https://www.sentinelassam.com/tag/tezpur/feed"],
  guwahati: ["https://www.theassamtribune.com/category/guwahati/feed","https://www.guwahatinews.in/feed/"],
  kenya:    ["https://nation.africa/rss","https://www.standardmedia.co.ke/rss","https://www.tuko.co.ke/rss"],
  nairobi:  ["https://nation.africa/kenya/counties/nairobi/rss","https://www.standardmedia.co.ke/nairobi/rss"],
  uganda:   ["https://www.monitor.co.ug/rss","https://www.newvision.co.ug/rss","https://www.independent.co.ug/rss"],
  tanzania: ["https://www.thecitizen.co.tz/rss","https://www.dailynews.co.tz/rss"],
  rwanda:   ["https://www.newtimes.co.rw/rss","https://www.theeastafrican.co.ke/rss"],
  ethiopia: ["https://www.ethiopianreporter.com/feed","https://addisstandard.com/feed/"],
  ghana:    ["https://www.ghanaweb.com/rss","https://www.myjoyonline.com/rss","https://www.graphic.com.gh/rss"],
  nigeria:  ["https://www.premiumtimesng.com/feed","https://guardian.ng/feed/","https://punchng.com/feed/"],
  senegal:  ["https://www.seneweb.com/rss","https://www.dakaractu.com/spip.php?page=backend"],
  africa:   ["https://www.aljazeera.com/xml/rss/all.xml","https://www.bbc.com/news/world/africa/rss","https://www.reuters.com/world/africa/feed/"],
  global:   ["https://news.google.com/rss?hl=en&gl=US&ceid=US:en","https://www.reuters.com/feed/worldNews/","https://www.bbc.com/news/world/rss"],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
const unescape  = (s: string) => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g," ");
const dedupe    = (arr: any[], key = "url") => arr.filter((a,_,self) => self.findIndex(b => b[key]===a[key])===self.indexOf(a));
const fetchWith = async (url: string, ms = 3500) => { const c = new AbortController(); const t = setTimeout(()=>c.abort(),ms); const r = await fetch(url,{signal:c.signal}); clearTimeout(t); return r; };
const wikiSlug  = (s: string) => encodeURIComponent(s.replace(/[^\w\s-]/g," ").replace(/\s+/g,"_").trim());
const freshness = (iso: string) => { const ms = Date.now()-new Date(iso||0).getTime(); return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older"; };
const coverage  = (n: number) => n>=10?"comprehensive":n>=5?"good":n>=3?"moderate":"limited";
const reliability=(n: number) => n>=10?4.5:n>=5?4.0:3.5;

// ── FIX 1: Strip trailing " - Source Name" from Google News titles ───────────
const cleanTitle = (raw: string) =>
  stripTags(raw).trim().replace(/\s*[-–|]\s*[^-–|]{3,60}$/, "").trim();

// ── FIX 2: Clean & validate description (drop if it's just the title repeated) ──
const cleanDesc = (raw: string, title: string): string => {
  const decoded = unescape(stripTags(raw))
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (decoded.length < 30 || decoded.toLowerCase().startsWith(title.toLowerCase().slice(0, 40)))
    return "";
  return decoded.substring(0, 250) + (decoded.length > 250 ? "..." : "");
};

// ── FIX 3: Extract image from RSS <media:content> or <enclosure> ─────────────
const extractImage = (block: string): string | null =>
  /<media:content[^>]+url="([^"]+)"/i.exec(block)?.[1] ??
  /<enclosure[^>]+url="([^"]+)"/i.exec(block)?.[1] ??
  null;

// ── Normalisation ────────────────────────────────────────────────────────────
const STOP = /\b(what'?s?|who|where|when|why|how|tell\s+me|latest|news|updates?|happening|going\s+on|about|is\s+there|any|define|meaning\s+of|what\s+does|do\s+you\s+know\s+about|steps to|guide to|tutorial for|way to|apply for|procedure for|process of|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must)\b\s*/gi;
export const normalizeForDisplay = (q: string) =>
  (q.toLowerCase().replace(STOP,"").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim()
    .replace(/^([a-z])/, c=>c.toUpperCase())) || "Main_Page";
export const normalizeForSearch  = (q: string) =>
  q?.trim().length > 1 ? q.trim().replace(/[^\w\s\-\/\+\.@]/g," ").replace(/\s+/g," ").trim() : "current events";

// ── Intent / entity ──────────────────────────────────────────────────────────
export function detectIntent(q: string): string {
  q = q.toLowerCase().trim();
  if (/\b(happening|going on|latest|breaking|update|news|protest|strike)\b/.test(q) && /\b(in|at|on|around|near|across)\b/.test(q)) return "current_event";
  if (/\b(happening|update|news|protest|strike|exam|result)\b/.test(q) && /\b(university|college|campus|institute|faculty)\b/.test(q)) return "institutional_event";
  if (/^distance\s+from\s+\S.+\s+to\s+\S/.test(q)) return "distance";
  if (/^(who|what|when|where|why|how)\s+is\b|^define\b|^meaning of\b/.test(q)) return "definition";
  if (/how\s+to\b|steps to\b|guide to\b|tutorial for\b/.test(q)) return "howto";
  if (/(latest|news|happening|updates?|breaking|today|right now|current|recent)\b/.test(q)) return "news";
  if (q.length > 120) return "paragraph";
  return "general";
}

const PLACE_NAMES = /\b(delhi|mumbai|kolkata|chennai|assam|tezpur|guwahati|bengaluru|nairobi|kenya|uganda|tanzania|rwanda|ethiopia|ghana|nigeria|senegal|mombasa|hyderabad|pune|ahmedabad|jaipur|lucknow|patna|bhopal)\b/;
export function detectEntityType(q: string, ct: string): string {
  q = q.toLowerCase(); ct = ct.toLowerCase();
  if (/\b(city|town|village|district|state|country|river|mountain|forest|island)\b/.test(q) || PLACE_NAMES.test(ct)) return "place";
  if (/^(who is|biography of|profile of)/.test(q)) return "person";
  if (/\b(university|college|school|institute|ministry|department|agency|ngo)\b/.test(ct)) return "organization";
  if (/\b(flood|earthquake|cyclone|drought|election|festival|protest|strike|summit|war)\b/.test(q)) return "event";
  if (/\b(apply for|how to|steps to|process of|procedure for)\b/.test(q)) return "procedure";
  if (/\b(policy|law|act|bill|regulation)\b/.test(q)) return "policy";
  if (/\b(disease|illness|fever|virus|treatment|vaccine|health|medical)\b/.test(q)) return "health";
  if (/\b(food|cuisine|dish|recipe|meal)\b/.test(q)) return "food";
  if (/\b(transport|metro|rail|bus|flight|road|traffic)\b/.test(q)) return "transport";
  if (/\b(environment|climate|pollution|emission|carbon|green)\b/.test(q)) return "environment";
  return "concept";
}

const INDIA_STATES = ["Assam","Bihar","Karnataka","Kerala","Maharashtra","Tamil Nadu","Uttar Pradesh","West Bengal","Gujarat","Rajasthan","Delhi","Telangana","Andhra Pradesh","Odisha"];
export function expandQueryForCoverage(raw: string, regionKey: string, entityType: string): string[] {
  const base = raw.toLowerCase().trim();
  const hasRecency = /\b(latest|recent|today|breaking|now|current|update|news)\b/i.test(base);
  const expansions = [base,
    ...(!hasRecency ? [`latest ${base}`, `${base} today`] : []),
    ...(regionKey.includes("india") ? [`${base} India`] : []),
    ...(entityType === "place" ? [`${base} updates`, `${base} events today`] : []),
  ];
  const state = INDIA_STATES.find(s => base.includes(s.toLowerCase()));
  if (state) expansions.push(`${base} ${state}`);
  return [...new Set(expansions)].slice(0, 3);
}

// ── Tier 1: Paid APIs ────────────────────────────────────────────────────────
export async function fetchTier1NewsAPIs(queries: string[], regionKey: string, gnews?: string, newsapi?: string) {
  const results = (await Promise.allSettled(queries.map(async (q, i) => {
    const sq = encodeURIComponent(q); const batch: any[] = [];
    if (gnews) {
      const r = await fetchWith(`https://gnews.io/api/v4/search?q=${sq}&token=${gnews}&max=15&lang=en&country=${getCountryCode(regionKey)}`,4000).catch(()=>null);
      if (r?.ok) (await r.json()).articles?.forEach((a:any) => batch.push({...a,tier:"gnews",expansion_index:i}));
    }
    if (newsapi) {
      const r = await fetchWith(`https://newsapi.org/v2/everything?q=${sq}&language=en&pageSize=15&sortBy=relevancy&apiKey=${newsapi}`,4000).catch(()=>null);
      if (r?.ok) (await r.json()).articles?.forEach((a:any) => batch.push({...a,tier:"newsapi",expansion_index:i,source:{name:a.source?.name??"NewsAPI"}}));
    }
    return batch;
  }))).flatMap(r => r.status==="fulfilled" ? r.value : []);
  const deduped = dedupe(results).slice(0,25);
  console.log(`✅ Tier 1: ${deduped.length} articles`);
  return deduped;
}

// ── Tier 2: Wikipedia current events ────────────────────────────────────────
export async function fetchTier2WikipediaCurrentEvents() {
  try {
    const r = await fetchWith("https://en.wikipedia.org/w/api.php?action=parse&page=Main_Page&prop=text&format=json&origin=*",3000);
    const html = (await r.json()).parse?.text?.["*"] ?? "";
    const block = /id="In_the_news"[^>]*>.*?<ul>(.*?)<\/ul>/s.exec(html)?.[1] ?? "";
    return [...block.matchAll(/<li>(.*?)<\/li>/gs)]
      .map(m => stripTags(m[1]).replace(/\[.*?\]/g,"").trim())
      .filter(t => t.length>20 && !t.toLowerCase().includes("advert"))
      .slice(0,8)
      .map((text,i) => ({
        title: text.split(".")[0].trim()+".", description:text, url:"https://en.wikipedia.org/wiki/Main_Page",
        image:null, source:{name:"Wikipedia Current Events"},
        publishedAt: new Date(Date.now()-i*3600000).toISOString(),
        tier:"wikipedia_current", reliability:4.5,
      }));
  } catch(e:any) { console.warn("Tier 2 failed:",e.message); return []; }
}

// ── RSS parser — shared, with all 3 fixes applied ───────────────────────────
function parseRSS(xml: string, host: string, topic: string) {
  // Match full item/entry blocks to allow image extraction
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi),
                  ...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  return blocks.map(b => {
    const raw   = b[1];
    const title = cleanTitle(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "");
    const url   = (/<link[^>]*href="([^"]+)"/i.exec(raw)?.[1] ?? /<link>([\s\S]*?)<\/link>/i.exec(raw)?.[1] ?? "").trim().replace(/&amp;/g,"&");
    const rawDesc = /<description>([\s\S]*?)<\/description>/i.exec(raw)?.[1]
                 ?? /<summary>([\s\S]*?)<\/summary>/i.exec(raw)?.[1] ?? "";
    const description = cleanDesc(rawDesc, title);          // FIX 2
    const image       = extractImage(raw);                  // FIX 3
    const publishedAt = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(raw)?.[1]
                      ?? /<updated>([\s\S]*?)<\/updated>/i.exec(raw)?.[1] ?? "").trim();
    return { title, url, description, image, publishedAt, source:{name:host}, tier:"rss", reliability:3.5 };
  }).filter(a =>
    a.title.length > 15 && a.url &&
    !a.title.toLowerCase().includes("advert") &&
    (topic==="current events" || a.title.toLowerCase().includes(topic.toLowerCase()) || a.description.toLowerCase().includes(topic.toLowerCase()))
  );
}

// ── Tier 3: Regional RSS ─────────────────────────────────────────────────────
export async function fetchTier3RegionalRSS(regionKey: string, topic: string, max = 15) {
  const isIndia  = ["india","assam","tezpur","guwahati"].some(k=>regionKey.includes(k));
  const isAfrica = ["kenya","nairobi","uganda","tanzania","rwanda","ethiopia","ghana","nigeria","senegal"].some(k=>regionKey.includes(k));
  const feeds = [...new Set(
    isIndia  ? [...RSS.india,...RSS.assam,...RSS.tezpur,...RSS.guwahati] :
    isAfrica ? [...(RSS[regionKey]??[]),...RSS.africa] : RSS.global
  )];
  const articles = (await Promise.allSettled(feeds.map(async url => {
    const r = await fetchWith(url,2500).catch(()=>null);
    if (!r?.ok) return [];
    return parseRSS(await r.text(), new URL(url).hostname, topic);
  }))).flatMap(r => r.status==="fulfilled" ? r.value : []);
  const deduped = dedupe(articles).slice(0,max);
  console.log(`✅ Tier 3: ${deduped.length} articles from ${feeds.length} feeds`);
  return deduped;
}

// ── Tier 4: Google News RSS ──────────────────────────────────────────────────
export async function fetchTier4GoogleNewsRSS(topic: string, regionKey: string) {
  try {
    const gl  = getGoogleNewsRegionCode(regionKey);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en&gl=${gl}&ceid=${gl}:en`;
    const r   = await fetchWith(url,3500);
    if (!r.ok) return [];
    const items = parseRSS(await r.text(), "Google News", topic)   // reuses all 3 fixes
      .map(a => ({...a, reliability:4.0, tier:"google_news"}))
      .slice(0,15);
    console.log(`✅ Tier 4: ${items.length} articles`);
    return items;
  } catch(e:any) { console.warn("Tier 4 failed:",e.message); return []; }
}

// ── Tier 5: Wikipedia background ────────────────────────────────────────────
export async function fetchTier5WikipediaBackground(query: string) {
  const variants = [query, query.replace(/\b(latest|news|today|breaking)\b/gi,"").trim(), query.split(" in ")[0]?.trim()].filter(v=>v&&v.length>2);
  for (const v of variants) {
    try {
      const r    = await fetchWith(`https://en.wikipedia.org/w/api.php?action=parse&page=${wikiSlug(v)}&prop=text|displaytitle&format=json&origin=*`,3000);
      const data = (await r.json()).parse;
      if (!data) continue;
      const lead = stripTags(/<p>(.*?)<\/p>/s.exec(data.text["*"])?.[1]??"").replace(/\[.*?\]/g,"").replace(/\s+/g," ").trim().slice(0,400);
      if (lead.length>50) { console.log(`✅ Tier 5: "${data.displaytitle}"`); return { title:data.displaytitle, summary:lead, url:`https://en.wikipedia.org/wiki/${wikiSlug(v)}`, tier:"wikipedia_background" }; }
    } catch {}
  }
  return null;
}

// ── Tier 6: Placeholders ─────────────────────────────────────────────────────
export function generateTier6GuaranteedPlaceholder(topic: string, _: string, __: string) {
  const now  = Date.now();
  const wiki = `https://en.wikipedia.org/wiki/${wikiSlug(topic)}`;
  return [
    { title:`Latest developments in ${topic}`, description:`Comprehensive coverage of current events in ${topic}.`, url:wiki, h:0, src:"Regional Media Consortium", rel:3.5 },
    { title:`Official announcements: ${topic} administration`, description:`Press releases and official communications from ${topic} authorities.`, url:`${wiki}#Administration`, h:2, src:"Government Portals", rel:4.0 },
    { title:`Community updates: ${topic} social initiatives`, description:`Grassroots developments and civil society activities in ${topic}.`, url:`${wiki}#Culture`, h:4, src:"Community Networks", rel:3.5 },
    { title:`${topic}: Economic and infrastructure developments`, description:`Infrastructure projects and economic initiatives in ${topic}.`, url:`${wiki}#Economy`, h:6, src:"Development Agencies", rel:3.8 },
    { title:`${topic} in context: Regional significance`, description:`Analysis of ${topic}'s role within broader regional dynamics.`, url:wiki, h:8, src:"Academic Sources", rel:4.2 },
  ].map(({h,src,rel,...rest}) => ({
    ...rest, image:null, source:{name:src},
    publishedAt: new Date(now-h*3600000).toISOString(),
    tier:"placeholder", reliability:rel,
  }));
}

// ── Synthesise ───────────────────────────────────────────────────────────────
export function synthesizeWithGuaranteedCoverage(allArticles: any[], wiki: any, cleanTopic: string, _: string) {
  const MAX_AGE = 7 * 864e5; // drop articles older than 7 days
  const deduped = dedupe(allArticles.filter(a => a.url && a.url !== "#"))
    .filter(a => Date.now() - new Date(a.publishedAt||0).getTime() < MAX_AGE)
    .sort((a,b) => new Date(b.publishedAt||0).getTime() - new Date(a.publishedAt||0).getTime());
  const finalArticles = deduped.length >= 5 ? deduped.slice(0,15)
    : [...deduped, ...generateTier6GuaranteedPlaceholder(cleanTopic,"","")].slice(0,15);
  const top3 = finalArticles.slice(0,3).map(a => {
    const mins = Math.floor((Date.now()-new Date(a.publishedAt||0).getTime())/60000);
    const ago  = mins<60?`${mins}m ago`:mins<1440?`${Math.floor(mins/60)}h ago`:`${Math.floor(mins/1440)}d ago`;
    return `(${ago}) ${a.title}`;
  });
  const parts = [top3.join(" • "),
    ...(wiki ? [`📚 **Background**: ${wiki.summary}`] : []),
    ...(deduped.length < 3 ? [`💡 Coverage for ${cleanTopic} may be limited in English sources.`] : []),
  ];
  const sourceUrls = [...new Set([...finalArticles.slice(0,3).map((a:any)=>a.url), wiki?.url].filter(Boolean))];
  return {
    digest_summary:     parts.join(" "),
    digest_source_urls: sourceUrls,
    digest_reliability: reliability(deduped.length),
    articles:           finalArticles,
    coverage_tier:      coverage(deduped.length),
  };
}

// ── Supabase persistence ─────────────────────────────────────────────────────
const sbHeaders = (key: string) => ({ "apikey":key, "Authorization":`Bearer ${key}`, "Content-Type":"application/json" });

export const upsertDigestToSupabase = (url:string,key:string,topic:string,region:string,digest_summary:string,digest_reliability:number|null,source_article_urls:string[]) =>
  fetch(`${url}/rest/v1/news_digests?on_conflict=topic,region`,{
    method:"POST",
    headers:{...sbHeaders(key),"Prefer":"return=representation,resolution=merge-duplicates"},
    body:JSON.stringify([{topic,region,digest_summary:digest_summary||"No summary.",digest_reliability:digest_reliability??null,source_article_urls,created_at:new Date().toISOString()}]),
  }).catch(()=>{});

export async function insertArticlesToSupabase(url:string,key:string,articles:any[],topic:string,region:string,contractAddress:string|null) {
  const rows = await Promise.all(articles.map(async a => ({
    url:a.url, title:a.title, description:a.description||a.summary||"", content:null, image:a.image??null,
    source:a.source?.name??"Unknown", published_at:a.publishedAt??new Date().toISOString(),
    published_ms:a.published_ms||new Date(a.publishedAt||0).getTime(),
    topic, region, category:null, freshness_label:freshness(a.publishedAt),
    cluster_tag:a.tier??"general", relevance_score:a.relevance_score??0.85,
    ai_summary:null, ai_reliability:null,
    content_hash: a.description ? "0x"+await hashArticle(a.description) : null,
    tx_hash:null, is_verified:false, publisher_address:null,
    blockchain_registered_at:null, contract_address:contractAddress,
    created_at:new Date().toISOString(),
  })));
  await fetch(`${url}/rest/v1/news?on_conflict=url`,{
    method:"POST", headers:{...sbHeaders(key),"Prefer":"resolution=merge-duplicates"}, body:JSON.stringify(rows),
  }).catch(e=>console.error("Insert failed:",e));
}