// supabase/functions/fetch-news/rss_dynamic.ts
// Dynamic RSS discovery for ANY place on earth.
// All country/ISO/language data imported from region.ts — zero hardcoding.
import { NAME_ISO, ISO_TO_KEY, regionMap, getGoogleNewsGL, getLangForCountry, getISOsForRegion, buildGoogleNewsURLs } from "./region.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────
const fw    = async(url:string,ms=5000)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{"User-Agent":"Mozilla/5.0 (compatible; NewsBot/1.0)"}});clearTimeout(t);return r;}catch(e){clearTimeout(t);throw e;}};
const strip = (s:string)=>s.replace(/<[^>]+>/g,"");
const unesc = (s:string)=>s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g," ");
const cleanT= (s:string)=>strip(s).trim().replace(/\s*[-–|]\s*[^-–|]{3,60}$/,"").trim();
const cleanD= (s:string)=>unesc(strip(s)).replace(/https?:\/\/\S+/g,"").replace(/\s+/g," ").trim().slice(0,250);
const imgFn = (b:string):string|null=>/<media:content[^>]+url="([^"]+)"/i.exec(b)?.[1]??/<enclosure[^>]+url="([^"]+)"/i.exec(b)?.[1]??null;
const dedup = (a:any[])=>{const s=new Set<string>();return a.filter(x=>{if(!x.url||s.has(x.url))return false;s.add(x.url);return true;});};

// ── Core entity extractor ─────────────────────────────────────────────────────
const NOISE=/\b(right\s+now|just\s+now|currently|live|real.?time|latest|breaking|recent|today|tonight|this\s+(week|month)|updates?|news|what'?s?|who|where|when|why|how|tell\s+me|about|is\s+there|any|define|meaning\s+of|what\s+does|steps\s+to|guide\s+to|way\s+to|apply\s+for|process\s+of|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must)\b\s*/gi;
export const extractCoreEntity=(q:string):string=>{const c=q.toLowerCase().replace(NOISE,"").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();return c.length>1?c.replace(/^([a-z])/,x=>x.toUpperCase()):q.trim();};

// ── Detect ISO from topic text — uses NAME_ISO from region.ts ─────────────────
export function detectCountryFromTopic(topic:string):string|null{
  const t=topic.toLowerCase();
  // Sort by length descending so "south africa" matches before "africa"
  for(const[name,iso]of Object.entries(NAME_ISO).sort((a,b)=>b[0].length-a[0].length))
    if(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(t))return iso;
  return null;
}

// ── RSS XML parser ────────────────────────────────────────────────────────────
function parseXML(xml:string,src:string,topic:string,tier="dynamic_rss",reliability=3.8):any[]{
  const words=extractCoreEntity(topic).toLowerCase().split(/\s+/).filter(w=>w.length>2);
  return[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi),...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map(b=>{const r=b[1];
      const title =cleanT(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r)?.[1]??"");
      const url   =(/<link[^>]*href="([^"]+)"/i.exec(r)?.[1]??/<link>([\s\S]*?)<\/link>/i.exec(r)?.[1]??"").replace(/&amp;/g,"&").trim();
      const desc  =cleanD(/<description>([\s\S]*?)<\/description>/i.exec(r)?.[1]??/<summary>([\s\S]*?)<\/summary>/i.exec(r)?.[1]??/<content[^>]*>([\s\S]*?)<\/content>/i.exec(r)?.[1]??"");
      const pub   =(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(r)?.[1]??/<updated>([\s\S]*?)<\/updated>/i.exec(r)?.[1]??/<published>([\s\S]*?)<\/published>/i.exec(r)?.[1]??"").trim();
      const ok    =words.length===0||words.some(w=>(title+" "+desc).toLowerCase().includes(w));
      return ok&&title.length>10&&url.startsWith("http")&&!title.toLowerCase().includes("advert")
        ?{title,url,description:desc,image:imgFn(r),publishedAt:pub||new Date().toISOString(),source:{name:src},tier,reliability}:null;
    }).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — Google News RSS
// Uses buildGoogleNewsURLs from region.ts — covers every country on earth
// ════════════════════════════════════════════════════════════════════════════
export async function fetchGoogleNewsRSS(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const detected=detectCountryFromTopic(topic);
  // Get ISOs for searched region + any country detected in topic itself
  const isos=[...new Set([...getISOsForRegion(regionKey),...(detected?[detected]:[])])].slice(0,8);
  // Build URLs for each term × each country — uses region.ts helpers
  const terms=[core,`${core} news`];
  const urls=new Set<string>([
    // Country-specific feeds from region.ts
    ...isos.flatMap(iso=>{const gl=getGoogleNewsGL(iso);const lang=getLangForCountry(gl);return terms.map(t=>`https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=${lang}&gl=${gl}&ceid=${gl}:${lang}`);}),
    // Global English fallback
    ...terms.map(t=>`https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=en&gl=US&ceid=US:en`),
  ]);
  const all=dedup((await Promise.allSettled([...urls].map(async u=>{try{const r=await fw(u,4000);if(!r.ok)return[];return parseXML(await r.text(),"Google News",topic,"google_news",4.0);}catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ Google News: ${all.length}`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — Wikinews (actual news articles, 30+ languages)
// Language detected via getLangForCountry from region.ts
// ════════════════════════════════════════════════════════════════════════════
export async function fetchWikinews(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const iso=(detectCountryFromTopic(topic)??getISOsForRegion(regionKey)[0]??"US");
  const gl=getGoogleNewsGL(iso);
  // getLangForCountry returns full language code — Wikinews uses 2-letter subdomain
  const lang=getLangForCountry(gl).split("-")[0];
  const langs=[...new Set([lang,"en"])];
  const all=dedup((await Promise.allSettled(langs.map(async l=>{
    try{
      const r=await fw(`https://${l}.wikinews.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(core)}&format=json&origin=*&srlimit=10`,4000);
      if(!r.ok)return[];
      return((await r.json()).query?.search??[]).map((s:any)=>({
        title:cleanT(s.title??""),
        url:`https://${l}.wikinews.org/wiki/${encodeURIComponent((s.title??"").replace(/ /g,"_"))}`,
        description:strip(s.snippet??"").replace(/\.\.\./g,"").trim().slice(0,200),
        image:null,publishedAt:new Date(s.timestamp??Date.now()).toISOString(),
        source:{name:"Wikinews"},tier:"wikinews",reliability:4.0,
      })).filter((a:any)=>a.title.length>5);
    }catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ Wikinews: ${all.length}`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — Regional Aggregators
// Auto-selected using regionMap from region.ts — no hardcoded ISO arrays
// ════════════════════════════════════════════════════════════════════════════
// One aggregator feed per region group — keyed to match regionMap keys
const AGG:Record<string,{url:string;name:string}>={
  africa:        {url:"https://www.africanews.com/feed/rss",          name:"Africanews"},
  eastafrica:    {url:"https://www.theeastafrican.co.ke/rss",          name:"The East African"},
  westafrica:    {url:"https://www.theafricareport.com/feed/",          name:"The Africa Report"},
  northafrica:   {url:"https://egyptindependent.com/feed/",             name:"Egypt Independent"},
  southafrica:   {url:"https://www.dailymaverick.co.za/feed/",          name:"Daily Maverick"},
  asia:          {url:"https://www.thewire.in/feed/",                   name:"The Wire"},
  middleeast:    {url:"https://english.alarabiya.net/tools/rss",        name:"Al Arabiya"},
  europe:        {url:"https://www.euronews.com/rss",                   name:"Euronews"},
  northamerica:  {url:"https://feeds.npr.org/1001/rss.xml",             name:"NPR"},
  southamerica:  {url:"https://www.mercopress.com/rss.asp",             name:"MercoPress"},
  oceania:       {url:"https://www.abc.net.au/news/feed/51120/rss.xml", name:"ABC Australia"},
  caribbean:     {url:"https://www.caribbeannationalweekly.com/feed/",  name:"Caribbean Weekly"},
  centralasia:   {url:"https://eurasianet.org/rss.xml",                 name:"Eurasianet"},
  global:        {url:"https://www.reuters.com/feed/worldNews/",         name:"Reuters"},
};

export async function fetchRegionalAggregators(topic:string,regionKey:string):Promise<any[]>{
  const isos=[...new Set([...getISOsForRegion(regionKey),...(detectCountryFromTopic(topic)??[]).toString().split(",")])];
  // Find which regionMap groups contain these ISOs — uses regionMap from region.ts directly
  const matchedGroups=new Set<string>(["global"]);
  for(const[group,codes]of Object.entries(regionMap))
    if(codes.some(c=>isos.includes(c))&&AGG[group])matchedGroups.add(group);
  const feeds=[...matchedGroups].map(g=>AGG[g]).filter(Boolean);
  const all=dedup((await Promise.allSettled(feeds.map(async({url,name})=>{
    try{const r=await fw(url,4000);if(!r.ok)return[];return parseXML(await r.text(),name,topic,"regional_agg",3.8);}catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ Regional Agg: ${all.length} from ${feeds.length} feeds`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 4 — Feedly Discovery (finds RSS feeds for any topic dynamically)
// ════════════════════════════════════════════════════════════════════════════
export async function discoverAndFetchFeeds(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const discovered:string[]=[];
  try{
    const r=await fw(`https://feedly.com/v3/search/feeds?query=${encodeURIComponent(core+" news")}&count=8`,5000);
    if(r.ok)(await r.json()).results?.forEach((f:any)=>{const u=f.feedId?.replace(/^feed\//,"");if(u?.startsWith("http"))discovered.push(u);});
  }catch(e:any){console.warn("Feedly:",e.message);}
  if(!discovered.length)return[];
  const all=dedup((await Promise.allSettled(discovered.map(async url=>{
    try{const r=await fw(url,4000);if(!r.ok)return[];return parseXML(await r.text(),new URL(url).hostname.replace("www.",""),topic,"discovered_feed",3.5);}catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ Feedly: ${all.length} from ${discovered.length} feeds`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 5 — RSS Bridge (converts any site to RSS — covers remote places)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchRSSBridge(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const urls=[
    `https://rss-bridge.org/bridge01/?action=display&bridge=DuckDuckGoBridge&q=${encodeURIComponent(core+" news")}&format=Atom`,
    `https://rss-bridge.org/bridge01/?action=display&bridge=GoogleSearchBridge&q=${encodeURIComponent(core+" latest")}&format=Atom`,
  ];
  const all=dedup((await Promise.allSettled(urls.map(async url=>{
    try{const r=await fw(url,6000);if(!r.ok)return[];return parseXML(await r.text(),"RSS Bridge",topic,"rss_bridge",3.5);}catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ RSS Bridge: ${all.length}`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 6 — GDELT (hyper-local, every language, ~15min updates)
// Uses ISO_TO_KEY from region.ts for location-scoped search
// ════════════════════════════════════════════════════════════════════════════
export async function fetchGDELT(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const detected=detectCountryFromTopic(topic);
  const iso=detected??getISOsForRegion(regionKey)[0]??"US";
  const regionName=ISO_TO_KEY[iso]??regionKey;
  const queries=[core,core!==regionName?`${core} ${regionName}`:core].filter((v,i,a)=>a.indexOf(v)===i);
  const all=dedup((await Promise.allSettled(queries.map(async q=>{
    try{
      const p=new URLSearchParams({query:q,mode:"artlist",maxrecords:"25",format:"json",timespan:"48h",sort:"DateDesc"});
      const r=await fw(`https://api.gdeltproject.org/api/v2/doc/doc?${p}`,6000);if(!r.ok)return[];
      return((await r.json()).articles??[]).map((a:any)=>({
        title:cleanT(a.title??""),url:a.url??"",description:cleanT(a.title??""),image:null,
        publishedAt:a.seendate?new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z")).toISOString():new Date().toISOString(),
        source:{name:a.domain??"GDELT"},tier:"gdelt",reliability:3.5,country:a.sourcecountry??"",
      })).filter((a:any)=>a.title.length>10&&a.url);
    }catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ GDELT: ${all.length}`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 7 — Live & Breaking feeds (news + sports)
// ════════════════════════════════════════════════════════════════════════════
const LIVE=[
  {url:"https://www.bbc.com/news/world/rss.xml",         name:"BBC World"},
  {url:"https://feeds.reuters.com/reuters/topNews",       name:"Reuters"},
  {url:"https://www.aljazeera.com/xml/rss/all.xml",       name:"Al Jazeera"},
  {url:"https://rss.dw.com/rdf/rss-en-all",               name:"DW News"},
  {url:"https://feeds.skynews.com/feeds/rss/world.xml",   name:"Sky News"},
  {url:"https://www.france24.com/en/rss",                 name:"France 24"},
  {url:"https://rss.nytimes.com/services/xml/rss/nyt/World.xml",name:"NY Times"},
  {url:"https://www.theguardian.com/world/rss",           name:"The Guardian"},
];
const SPORTS=[
  {url:"https://www.espn.com/espn/rss/news",             name:"ESPN"},
  {url:"https://www.espn.com/espn/rss/soccer/news",      name:"ESPN Soccer"},
  {url:"https://www.espn.com/espn/rss/cricket/news",     name:"ESPN Cricket"},
  {url:"https://www.skysports.com/rss/12040",            name:"Sky Sports"},
  {url:"https://feeds.bbci.co.uk/sport/rss.xml",         name:"BBC Sport"},
  {url:"https://www.cricbuzz.com/rss/match_list",        name:"Cricbuzz"},
];
export async function fetchLiveFeeds(topic:string,isSport=false):Promise<any[]>{
  const feeds=[...(isSport?SPORTS:[]),...LIVE];
  const all=dedup((await Promise.allSettled(feeds.map(async({url,name})=>{
    try{const r=await fw(url,4000);if(!r.ok)return[];return parseXML(await r.text(),name,topic,"live_feed",4.2);}catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  console.log(`✅ Live Feeds: ${all.length}`);return all;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 8 — Web Search fallback (DuckDuckGo — for very remote places)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchWebSearch(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const arts:any[]=[];
  try{
    const q=encodeURIComponent(`${core} news`);
    const r=await fw(`https://api.allorigins.win/get?url=${encodeURIComponent(`https://html.duckduckgo.com/html/?q=${q}&ia=news`)}`,6000);
    if(r.ok){
      const html=(await r.json()).contents??"";
      [...html.matchAll(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
        .slice(0,12).forEach(m=>{
          const rawUrl=decodeURIComponent(m[1].replace(/.*uddg=/,"").split("&")[0]);
          const title=strip(m[2]).trim();
          const desc=strip(m[3]).trim();
          if(title.length>10&&rawUrl.startsWith("http")&&!rawUrl.includes("duckduckgo"))
            arts.push({title:cleanT(title),url:rawUrl,description:desc.slice(0,200),image:null,publishedAt:new Date().toISOString(),source:{name:new URL(rawUrl).hostname.replace("www.","")},tier:"web_search",reliability:3.2});
        });
    }
  }catch(e:any){console.warn("Web search:",e.message);}
  console.log(`✅ Web Search: ${arts.length}`);return arts;
}

// ════════════════════════════════════════════════════════════════════════════
// MASTER EXPORT — fetchAllRSS()
// Called by news_tier.ts Tier 3 — runs all 8 sources in parallel
// Returns ONLY real articles sorted by recency, no placeholders
// ════════════════════════════════════════════════════════════════════════════
export async function fetchAllRSS(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const isSport=/\b(live|match|game|vs|versus|score|playing|football|cricket|soccer|nba|tennis|formula)\b/i.test(topic);
  console.log(`\n📡 RSS: "${topic}" → "${core}" | region:${regionKey} | sport:${isSport}`);
  const[g,w,a,f,b,d,l,s]=await Promise.allSettled([
    fetchGoogleNewsRSS(topic,regionKey),
    fetchWikinews(topic,regionKey),
    fetchRegionalAggregators(topic,regionKey),
    discoverAndFetchFeeds(topic),
    fetchRSSBridge(topic),
    fetchGDELT(topic,regionKey),
    fetchLiveFeeds(topic,isSport),
    fetchWebSearch(topic),
  ]);
  const get=(r:PromiseSettledResult<any>):any[]=>r.status==="fulfilled"&&Array.isArray(r.value)?r.value:[];
  const all=dedup([...get(g),...get(w),...get(a),...get(f),...get(b),...get(d),...get(l),...get(s)])
    .sort((a,b)=>new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime());
  console.log(`\n📰 RSS total: ${all.length} real articles for "${core}"`);
  return all;
}