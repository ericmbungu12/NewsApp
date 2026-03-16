// supabase/functions/fetch-news/news_tier.ts
import { getCountryCode, buildGoogleNewsURLs, getLangForCountry } from "./region.ts";
import { hashArticle } from "./blockchain.ts";

export const CACHE_DURATION_MS = 1800000;

// ── Reliability ratings ──────────────────────────────────────────────────────
const SRC_RATING:Record<string,number> = {"Reuters":5,"BBC News":5,"Associated Press":5,"AP":5,"Bloomberg":5,"The New York Times":5,"The Hindu":5,"PTI":5,"WHO":5,"UN":5,"World Bank":5,"IMF":5,"CNN":4,"Al Jazeera":4,"TechCrunch":4,"The Verge":4,"Times of India":4,"NDTV":4,"The Indian Express":4,"Hindustan Times":4,"The Assam Tribune":4,"Sentinel Assam":4,"EastMojo":4,"Nation Africa":4,"Standard Media":4,"The Citizen":4,"New Vision":4,"ANI":4,"Wikipedia":4,"GDELT":3,"Reddit":3,"YouTube":3};
export const getReliability = (s:string) => SRC_RATING[s] ?? 3;

// ── RSS registry ─────────────────────────────────────────────────────────────
const RSS:Record<string,string[]> = {
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

// ── Shared helpers ───────────────────────────────────────────────────────────
const strip   = (s:string) => s.replace(/<[^>]+>/g,"");
const unesc   = (s:string) => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g," ");
const dedup   = (a:any[],k="url") => a.filter((x,_,s)=>s.findIndex(y=>y[k]===x[k])===s.indexOf(x));
const fw      = async(url:string,ms=3500)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);const r=await fetch(url,{signal:c.signal});clearTimeout(t);return r;};
const slug    = (s:string) => encodeURIComponent(s.replace(/[^\w\s-]/g," ").replace(/\s+/g,"_").trim());
const fresh   = (iso:string) => {const ms=Date.now()-new Date(iso||0).getTime();return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older";};
const cov     = (n:number) => n>=10?"comprehensive":n>=5?"good":n>=3?"moderate":"limited";
const rel     = (n:number) => n>=10?4.5:n>=5?4.0:3.5;
const cleanT  = (r:string) => strip(r).trim().replace(/\s*[-–|]\s*[^-–|]{3,60}$/,"").trim();
const cleanD  = (r:string,t:string) => {const d=unesc(strip(r)).replace(/https?:\/\/\S+/g,"").replace(/\s+/g," ").trim();return(d.length<30||d.toLowerCase().startsWith(t.toLowerCase().slice(0,40)))?"":d.substring(0,250)+(d.length>250?"...":"");};
const imgFrom = (b:string):string|null => /<media:content[^>]+url="([^"]+)"/i.exec(b)?.[1]??/<enclosure[^>]+url="([^"]+)"/i.exec(b)?.[1]??null;

// ── Normalisation / Intent / Entity ─────────────────────────────────────────
const STOP = /\b(what'?s?|who|where|when|why|how|tell\s+me|latest|news|updates?|happening|going\s+on|about|is\s+there|any|define|meaning\s+of|what\s+does|do\s+you\s+know\s+about|steps to|guide to|tutorial for|way to|apply for|procedure for|process of|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must)\b\s*/gi;
export const normalizeForDisplay = (q:string) => (q.toLowerCase().replace(STOP,"").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim().replace(/^([a-z])/,c=>c.toUpperCase()))||"Main_Page";
export const normalizeForSearch  = (q:string) => q?.trim().length>1?q.trim().replace(/[^\w\s\-\/\+\.@]/g," ").replace(/\s+/g," ").trim():"current events";

export function detectIntent(q:string):string {
  q=q.toLowerCase().trim();
  if(/\b(happening|going on|latest|breaking|update|news|protest|strike)\b/.test(q)&&/\b(in|at|on|around|near|across)\b/.test(q))return"current_event";
  if(/\b(happening|update|news|protest|strike|exam|result)\b/.test(q)&&/\b(university|college|campus|institute|faculty)\b/.test(q))return"institutional_event";
  if(/^distance\s+from\s+\S.+\s+to\s+\S/.test(q))return"distance";
  if(/^(who|what|when|where|why|how)\s+is\b|^define\b|^meaning of\b/.test(q))return"definition";
  if(/how\s+to\b|steps to\b|guide to\b|tutorial for\b/.test(q))return"howto";
  if(/(latest|news|happening|updates?|breaking|today|right now|current|recent)\b/.test(q))return"news";
  if(q.length>120)return"paragraph";
  return"general";
}

const PLACES=/\b(delhi|mumbai|kolkata|chennai|assam|tezpur|guwahati|bengaluru|nairobi|kenya|uganda|tanzania|rwanda|ethiopia|ghana|nigeria|senegal|mombasa|hyderabad|pune|ahmedabad|jaipur|lucknow|patna|bhopal)\b/;
export function detectEntityType(q:string,ct:string):string {
  q=q.toLowerCase();ct=ct.toLowerCase();
  if(/\b(city|town|village|district|state|country|river|mountain|forest|island)\b/.test(q)||PLACES.test(ct))return"place";
  if(/^(who is|biography of|profile of)/.test(q))return"person";
  if(/\b(university|college|school|institute|ministry|department|agency|ngo)\b/.test(ct))return"organization";
  if(/\b(flood|earthquake|cyclone|drought|election|festival|protest|strike|summit|war)\b/.test(q))return"event";
  if(/\b(apply for|how to|steps to|process of|procedure for)\b/.test(q))return"procedure";
  if(/\b(policy|law|act|bill|regulation)\b/.test(q))return"policy";
  if(/\b(disease|illness|fever|virus|treatment|vaccine|health|medical)\b/.test(q))return"health";
  if(/\b(food|cuisine|dish|recipe|meal)\b/.test(q))return"food";
  if(/\b(transport|metro|rail|bus|flight|road|traffic)\b/.test(q))return"transport";
  if(/\b(environment|climate|pollution|emission|carbon|green)\b/.test(q))return"environment";
  return"concept";
}

const IND_STATES=["Assam","Bihar","Karnataka","Kerala","Maharashtra","Tamil Nadu","Uttar Pradesh","West Bengal","Gujarat","Rajasthan","Delhi","Telangana","Andhra Pradesh","Odisha"];
export function expandQueryForCoverage(raw:string,regionKey:string,entityType:string):string[] {
  const base=raw.toLowerCase().trim();
  const noRec=!/\b(latest|recent|today|breaking|now|current|update|news)\b/i.test(base);
  const exp=[base,...(noRec?[`latest ${base}`,`${base} today`]:[]),...(regionKey.includes("india")?[`${base} India`]:[]),...(entityType==="place"?[`${base} updates`,`${base} events today`]:[])];
  const state=IND_STATES.find(s=>base.includes(s.toLowerCase()));
  if(state)exp.push(`${base} ${state}`);
  return[...new Set(exp)].slice(0,3);
}

// ── Shared RSS parser ────────────────────────────────────────────────────────
function parseRSS(xml:string,host:string,topic:string,tier="rss",rel=3.5):any[] {
  return[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi),...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map(b=>{
      const r=b[1];
      const title=cleanT(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r)?.[1]??"");
      const url=(/<link[^>]*href="([^"]+)"/i.exec(r)?.[1]??/<link>([\s\S]*?)<\/link>/i.exec(r)?.[1]??"").trim().replace(/&amp;/g,"&");
      const rawD=/<description>([\s\S]*?)<\/description>/i.exec(r)?.[1]??/<summary>([\s\S]*?)<\/summary>/i.exec(r)?.[1]??"";
      return{title,url,description:cleanD(rawD,title),image:imgFrom(r),publishedAt:(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(r)?.[1]??/<updated>([\s\S]*?)<\/updated>/i.exec(r)?.[1]??"").trim(),source:{name:host},tier,reliability:rel};
    })
    .filter(a=>a.title.length>15&&a.url&&!a.title.toLowerCase().includes("advert")&&(topic==="current events"||a.title.toLowerCase().includes(topic.toLowerCase())||a.description.toLowerCase().includes(topic.toLowerCase())));
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 1 — GNews + NewsAPI (keyed, free tiers)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier1NewsAPIs(queries:string[],regionKey:string,gnews?:string,newsapi?:string):Promise<any[]> {
  const results=(await Promise.allSettled(queries.map(async(q,i)=>{
    const sq=encodeURIComponent(q);const batch:any[]=[];
    if(gnews){const r=await fw(`https://gnews.io/api/v4/search?q=${sq}&token=${gnews}&max=15&lang=en&country=${getCountryCode(regionKey)}`,4000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>batch.push({...a,tier:"gnews",expansion_index:i}));}
    if(newsapi){const r=await fw(`https://newsapi.org/v2/everything?q=${sq}&language=en&pageSize=15&sortBy=relevancy&apiKey=${newsapi}`,4000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>batch.push({...a,tier:"newsapi",expansion_index:i,source:{name:a.source?.name??"NewsAPI"}}));}
    return batch;
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const d=dedup(results).slice(0,25);console.log(`✅ T1: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 2 — Wikipedia Current Events (free)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier2WikipediaCurrentEvents():Promise<any[]> {
  try{
    const r=await fw("https://en.wikipedia.org/w/api.php?action=parse&page=Main_Page&prop=text&format=json&origin=*",3000);
    const html=(await r.json()).parse?.text?.["*"]??"";
    const block=/id="In_the_news"[^>]*>.*?<ul>(.*?)<\/ul>/s.exec(html)?.[1]??"";
    const items=[...block.matchAll(/<li>(.*?)<\/li>/gs)].map(m=>strip(m[1]).replace(/\[.*?\]/g,"").trim()).filter(t=>t.length>20&&!t.toLowerCase().includes("advert")).slice(0,8);
    console.log(`✅ T2: ${items.length}`);
    return items.map((text,i)=>({title:text.split(".")[0].trim()+".",description:text,url:"https://en.wikipedia.org/wiki/Main_Page",image:null,source:{name:"Wikipedia Current Events"},publishedAt:new Date(Date.now()-i*3600000).toISOString(),tier:"wikipedia_current",reliability:4.5}));
  }catch(e:any){console.warn("T2 failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 3 — Regional RSS (free)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier3RegionalRSS(regionKey:string,topic:string,max=15):Promise<any[]> {
  const isIn=["india","assam","tezpur","guwahati"].some(k=>regionKey.includes(k));
  const isAf=["kenya","nairobi","uganda","tanzania","rwanda","ethiopia","ghana","nigeria","senegal"].some(k=>regionKey.includes(k));
  const feeds=[...new Set(isIn?[...RSS.india,...RSS.assam,...RSS.tezpur,...RSS.guwahati]:isAf?[...(RSS[regionKey]??[]),...RSS.africa]:RSS.global)];
  const articles=(await Promise.allSettled(feeds.map(async url=>{const r=await fw(url,2500).catch(()=>null);if(!r?.ok)return[];return parseRSS(await r.text(),new URL(url).hostname,topic);}))).flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const d=dedup(articles).slice(0,max);console.log(`✅ T3: ${d.length} from ${feeds.length} feeds`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 4 — Google News RSS (free, all countries via region.ts)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier4GoogleNewsRSS(topic:string,regionKey:string):Promise<any[]> {
  try{
    const urls=buildGoogleNewsURLs(topic,regionKey);
    const items=dedup((await Promise.allSettled(urls.map(async url=>{const r=await fw(url,3500).catch(()=>null);if(!r?.ok)return[];return parseRSS(await r.text(),"Google News",topic,"google_news",4.0);}))).flatMap(r=>r.status==="fulfilled"?r.value:[])).slice(0,25);
    console.log(`✅ T4: ${items.length} from ${urls.length} country feeds`);return items;
  }catch(e:any){console.warn("T4 failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 5 — Wikipedia Background (free)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier5WikipediaBackground(query:string):Promise<any|null> {
  for(const v of[query,query.replace(/\b(latest|news|today|breaking)\b/gi,"").trim(),query.split(" in ")[0]?.trim()].filter(v=>v&&v.length>2)){
    try{
      const r=await fw(`https://en.wikipedia.org/w/api.php?action=parse&page=${slug(v)}&prop=text|displaytitle&format=json&origin=*`,3000);
      const data=(await r.json()).parse;if(!data)continue;
      const lead=strip(/<p>(.*?)<\/p>/s.exec(data.text["*"])?.[1]??"").replace(/\[.*?\]/g,"").replace(/\s+/g," ").trim().slice(0,400);
      if(lead.length>50){console.log(`✅ T5: "${data.displaytitle}"`);return{title:data.displaytitle,summary:lead,url:`https://en.wikipedia.org/wiki/${slug(v)}`,tier:"wikipedia_background"};}
    }catch{}
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 6 — GDELT (free, global, every language, ~15min updates)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier6GDELT(topic:string,regionKey:string,max=20):Promise<any[]> {
  try{
    const q=regionKey&&!["global","world"].includes(regionKey)?`${topic} ${regionKey}`:topic;
    const p=new URLSearchParams({query:q,mode:"artlist",maxrecords:String(max),format:"json",timespan:"24h",sort:"DateDesc"});
    const r=await fw(`https://api.gdeltproject.org/api/v2/doc/doc?${p}`,5000);if(!r.ok)return[];
    const data=await r.json();
    const arts=(data.articles??[]).map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:cleanT(a.title??""),image:null,publishedAt:a.seendate?new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z")).toISOString():new Date().toISOString(),source:{name:a.domain??"GDELT"},tier:"gdelt",reliability:3.5,country:a.sourcecountry??"",language:a.language??"English"})).filter((a:any)=>a.title.length>10&&a.url);
    const d=dedup(arts).slice(0,max);console.log(`✅ T6 GDELT: ${d.length}`);return d;
  }catch(e:any){console.warn("T6 GDELT failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 7 — Reddit (free, no key)
// ════════════════════════════════════════════════════════════════════════════
const SUBS:Record<string,string[]> = {
  global:["worldnews","news"],tech:["technology","science","artificial"],
  sports:["sports","soccer","cricket","nba","tennis","formula1"],
  business:["economics","finance","investing"],health:["health","medicine"],
  africa:["africa","Kenya","Nigeria","Ghana","Ethiopia","Uganda"],
  india:["india","IndiaSpeaks"],us:["news","politics"],uk:["unitedkingdom","ukpolitics"],
};
function getSubs(topic:string,rk:string):string[] {
  const t=topic.toLowerCase();const b:string[]=[];
  if(/\b(football|soccer|cricket|nba|tennis|sport|match|league|cup)\b/.test(t))b.push(...SUBS.sports);
  if(/\b(tech|ai|software|crypto|blockchain)\b/.test(t))b.push(...SUBS.tech);
  if(/\b(economy|finance|stock|market|invest)\b/.test(t))b.push(...SUBS.business);
  if(/\b(health|disease|virus|vaccine|medical)\b/.test(t))b.push(...SUBS.health);
  const r=rk.toLowerCase();
  if(r.includes("africa")||SUBS.africa.some(s=>r.includes(s.toLowerCase())))b.push(...SUBS.africa);
  if(r.includes("india")||r==="in")b.push(...SUBS.india);
  if(r==="us")b.push(...SUBS.us);
  if(r==="uk"||r==="gb")b.push(...SUBS.uk);
  b.push("worldnews","news");
  return[...new Set(b)].slice(0,6);
}
export async function fetchTier7Reddit(topic:string,regionKey:string,max=15):Promise<any[]> {
  const subs=getSubs(topic,regionKey);
  const results=await Promise.allSettled(subs.map(async sub=>{
    try{
      const r=await fw(`https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(topic)}&sort=new&limit=5&restrict_sr=true&t=day`,4000);
      if(!r.ok)return[];
      return(await r.json()).data?.children?.map((c:any)=>{const p=c.data;return{title:cleanT(p.title??""),url:p.url??`https://reddit.com${p.permalink}`,description:(p.selftext??"").slice(0,200)||p.title,image:p.thumbnail?.startsWith("http")?p.thumbnail:null,publishedAt:new Date((p.created_utc??0)*1000).toISOString(),source:{name:`Reddit r/${sub}`},tier:"reddit",reliability:3.0,upvotes:p.score??0};}).filter((a:any)=>a.title.length>10)??[];
    }catch{return[];}
  }));
  const d=dedup(results.flatMap(r=>r.status==="fulfilled"?r.value:[])).sort((a:any,b:any)=>b.upvotes-a.upvotes).slice(0,max);
  console.log(`✅ T7 Reddit: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 8 — YouTube (public channel RSS, no key; optional API key)
// ════════════════════════════════════════════════════════════════════════════
const YT_CH:Record<string,string> = {"UCupvZG-5ko_eiXAupbDfxWw":"CNN","UCBi2mrWuNuyYy4gbM6fU18Q":"ABC News","UCeY0bbntWzzVIaj2z3QigXg":"NBC News","UC16niRr50-MSBwiO3YDb3RA":"BBC News","UCNye-wNBqNL5ZzHSJj3l8Bg":"Al Jazeera","UCIALMKvObZNtJ6AmdCLP_xQ":"Bloomberg","UChqUTb7kYRX8-EiaN3XFrSQ":"Reuters","UCHd62-u_v4DvJ8TCFtpi4GA":"DW News","UCWX3yGbODI3RYAMqGYhJohw":"France 24","UCknLrEdhRCp1aegoMqRaCZg":"Sky News","UCF9imwCEP-ZBnuFJBUGDcog":"NTV Kenya","UCZRv5HgoZ9FDPdVPYyGBbDA":"Citizen TV Kenya"};
export async function fetchTier8YouTube(topic:string,_rk:string,ytKey?:string,max=10):Promise<any[]> {
  const arts:any[]=[];
  // Method A: YouTube Data API (key optional)
  if(ytKey){
    try{
      const p=new URLSearchParams({part:"snippet",q:`${topic} news`,key:ytKey,type:"video",order:"date",maxResults:"10",publishedAfter:new Date(Date.now()-86400000).toISOString(),relevanceLanguage:"en"});
      const r=await fw(`https://www.googleapis.com/youtube/v3/search?${p}`,4000);
      if(r.ok)(await r.json()).items?.forEach((i:any)=>{const s=i.snippet??{};arts.push({title:cleanT(s.title??""),url:`https://www.youtube.com/watch?v=${i.id?.videoId}`,description:(s.description??"").slice(0,200),image:s.thumbnails?.medium?.url??null,publishedAt:s.publishedAt??new Date().toISOString(),source:{name:s.channelTitle??"YouTube"},tier:"youtube",reliability:3.5});});
    }catch(e:any){console.warn("T8 YT API:",e.message);}
  }
  // Method B: Public channel RSS feeds (no key needed)
  if(arts.length<3){
    const rss=await Promise.allSettled(Object.keys(YT_CH).slice(0,6).map(async id=>{
      const r=await fw(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,3000).catch(()=>null);if(!r?.ok)return[];
      return[...((await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/gi))].map(e=>{const x=e[1];return{title:cleanT(/<title>([\s\S]*?)<\/title>/i.exec(x)?.[1]??""),url:/<link[^>]+href="([^"]+)"/i.exec(x)?.[1]??"",description:(/<media:description>([\s\S]*?)<\/media:description>/i.exec(x)?.[1]??"").slice(0,200),image:/<media:thumbnail[^>]+url="([^"]+)"/i.exec(x)?.[1]??null,publishedAt:/<published>([\s\S]*?)<\/published>/i.exec(x)?.[1]??"",source:{name:YT_CH[id]??"YouTube"},tier:"youtube",reliability:3.5};}).filter((a:any)=>a.title.length>5&&a.url&&(topic==="current events"||a.title.toLowerCase().includes(topic.toLowerCase())||a.description.toLowerCase().includes(topic.toLowerCase())));
    }));
    arts.push(...rss.flatMap(r=>r.status==="fulfilled"?r.value:[]));
  }
  const d=dedup(arts).slice(0,max);console.log(`✅ T8 YT: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 9 — Wikidata (free, structured facts)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier9Wikidata(topic:string):Promise<any|null> {
  try{
    const sr=await fw(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(topic)}&language=en&limit=1&format=json&origin=*`,3000);
    if(!sr.ok)return null;
    const ent=(await sr.json()).search?.[0];if(!ent)return null;
    const er=await fw(`https://www.wikidata.org/wiki/Special:EntityData/${ent.id}.json`,3000);if(!er.ok)return null;
    const claims=(await er.json()).entities?.[ent.id]?.claims??{};
    const gv=(p:string)=>{const c=claims[p]?.[0]?.mainsnak?.datavalue?.value;if(!c)return null;if(typeof c==="string")return c;if(typeof c==="object"){if(c.text)return c.text;if(c.amount)return c.amount;if(c.time)return c.time;if(c.id)return c.id;}return null;};
    console.log(`✅ T9 Wikidata: ${ent.label}`);
    return{id:ent.id,label:ent.label,description:ent.description,url:`https://www.wikidata.org/wiki/${ent.id}`,wikipedia:`https://en.wikipedia.org/wiki/${slug(ent.label)}`,population:gv("P1082"),capital:gv("P36"),leader:gv("P6"),inception:gv("P571"),tier:"wikidata"};
  }catch(e:any){console.warn("T9 Wikidata failed:",e.message);return null;}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 10 — Currents API (free key, 600 req/day, 150+ countries)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier10CurrentsAPI(topic:string,regionKey:string,apiKey?:string,max=15):Promise<any[]> {
  if(!apiKey)return[];
  try{
    const p=new URLSearchParams({keywords:topic,apiKey,language:"en"});
    const cc=getCountryCode(regionKey);if(cc&&cc!=="us")p.append("country",cc);
    const r=await fw(`https://api.currentsapi.services/v1/search?${p}`,4000);if(!r.ok)return[];
    const d=dedup((await r.json()).news?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:(a.description??"").slice(0,250),image:a.image??null,publishedAt:a.published??new Date().toISOString(),source:{name:"Currents API"},tier:"currents",reliability:3.5,category:Array.isArray(a.category)?a.category[0]:"general"})).filter((a:any)=>a.title.length>10&&a.url)??[]).slice(0,max);
    console.log(`✅ T10 Currents: ${d.length}`);return d;
  }catch(e:any){console.warn("T10 Currents failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 11 — TheNewsAPI (free key, 100 req/day, 50k+ sources)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier11TheNewsAPI(topic:string,_rk:string,apiKey?:string,max=15):Promise<any[]> {
  if(!apiKey)return[];
  try{
    const p=new URLSearchParams({search:topic,api_token:apiKey,language:"en",limit:String(max),sort:"published_at"});
    const r=await fw(`https://api.thenewsapi.com/v1/news/all?${p}`,4000);if(!r.ok)return[];
    const d=dedup((await r.json()).data?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:(a.description??"").slice(0,250),image:a.image_url??null,publishedAt:a.published_at??new Date().toISOString(),source:{name:a.source??"TheNewsAPI"},tier:"thenewsapi",reliability:3.5,category:Array.isArray(a.categories)?a.categories[0]:"general"})).filter((a:any)=>a.title.length>10&&a.url)??[]).slice(0,max);
    console.log(`✅ T11 TheNewsAPI: ${d.length}`);return d;
  }catch(e:any){console.warn("T11 TheNewsAPI failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 12 — Guaranteed placeholder fallback
// ════════════════════════════════════════════════════════════════════════════
export function generateTier12Placeholder(topic:string):any[] {
  const w=`https://en.wikipedia.org/wiki/${slug(topic)}`;const now=Date.now();
  return[
    {title:`Latest developments in ${topic}`,description:`Comprehensive coverage of current events in ${topic}.`,url:w,h:0,src:"Regional Media Consortium",rel:3.5},
    {title:`Official announcements: ${topic} administration`,description:`Press releases from ${topic} authorities.`,url:`${w}#Administration`,h:2,src:"Government Portals",rel:4.0},
    {title:`Community updates: ${topic} social initiatives`,description:`Grassroots developments in ${topic}.`,url:`${w}#Culture`,h:4,src:"Community Networks",rel:3.5},
    {title:`${topic}: Economic and infrastructure developments`,description:`Infrastructure projects in ${topic}.`,url:`${w}#Economy`,h:6,src:"Development Agencies",rel:3.8},
    {title:`${topic} in context: Regional significance`,description:`Analysis of ${topic}'s regional dynamics.`,url:w,h:8,src:"Academic Sources",rel:4.2},
  ].map(({h,src,rel:r,...rest})=>({...rest,image:null,source:{name:src},publishedAt:new Date(now-h*3600000).toISOString(),tier:"placeholder",reliability:r}));
}

// ════════════════════════════════════════════════════════════════════════════
// MASTER PIPELINE — all tiers in parallel
// ════════════════════════════════════════════════════════════════════════════
export async function fetchAllSources(topic:string,regionKey:string,queries:string[],opts:{gnewsKey?:string;newsapiKey?:string;currentsKey?:string;thenewsapiKey?:string;youtubeKey?:string;}={}):Promise<{articles:any[];wiki:any|null;wikidata:any|null;sourceCounts:Record<string,number>;}> {
  console.log(`\n🌍 Fetching: "${topic}" | Region: ${regionKey}`);
  const [t1,t2,t3,t4,t6,t7,t8,t9,t10,t11]=await Promise.allSettled([
    fetchTier1NewsAPIs(queries,regionKey,opts.gnewsKey,opts.newsapiKey),
    fetchTier2WikipediaCurrentEvents(),
    fetchTier3RegionalRSS(regionKey,topic),
    fetchTier4GoogleNewsRSS(topic,regionKey),
    fetchTier6GDELT(topic,regionKey),
    fetchTier7Reddit(topic,regionKey),
    fetchTier8YouTube(topic,regionKey,opts.youtubeKey),
    fetchTier9Wikidata(topic),
    fetchTier10CurrentsAPI(topic,regionKey,opts.currentsKey),
    fetchTier11TheNewsAPI(topic,regionKey,opts.thenewsapiKey),
  ]);
  const wiki=await fetchTier5WikipediaBackground(topic);
  const get =(r:PromiseSettledResult<any>):any[]=>r.status==="fulfilled"&&Array.isArray(r.value)?r.value:[];
  const wikidata=t9.status==="fulfilled"?t9.value:null;
  const allArticles=[...get(t1),...get(t2),...get(t3),...get(t4),...get(t6),...get(t7),...get(t8),...get(t10),...get(t11)];
  const sourceCounts:Record<string,number>={};
  for(const a of allArticles)sourceCounts[a.tier??"unknown"]=(sourceCounts[a.tier??"unknown"]??0)+1;
  console.log(`\n📊`,sourceCounts,`\n📰 Total: ${allArticles.length}`);
  return{articles:allArticles,wiki,wikidata,sourceCounts};
}

// ════════════════════════════════════════════════════════════════════════════
// SYNTHESISE
// ════════════════════════════════════════════════════════════════════════════
export function synthesizeWithGuaranteedCoverage(allArticles:any[],wiki:any,cleanTopic:string,_:string) {
  const deduped=dedup(allArticles.filter(a=>a.url&&a.url!=="#"))
    .filter(a=>Date.now()-new Date(a.publishedAt||0).getTime()<7*864e5)
    .sort((a,b)=>new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime());
  const final=deduped.length>=5?deduped.slice(0,15):[...deduped,...generateTier12Placeholder(cleanTopic)].slice(0,15);
  const top3=final.slice(0,3).map(a=>{const m=Math.floor((Date.now()-new Date(a.publishedAt||0).getTime())/60000);const ago=m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`;return`(${ago}) ${a.title}`;});
  const parts=[top3.join(" • "),...(wiki?[`📚 **Background**: ${wiki.summary}`]:[]),...(deduped.length<3?[`💡 Coverage for ${cleanTopic} may be limited in English sources.`]:[])];
  return{digest_summary:parts.join(" "),digest_source_urls:[...new Set([...final.slice(0,3).map((a:any)=>a.url),wiki?.url].filter(Boolean))],digest_reliability:rel(deduped.length),articles:final,coverage_tier:cov(deduped.length)};
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════
const sbH=(k:string)=>({"apikey":k,"Authorization":`Bearer ${k}`,"Content-Type":"application/json"});
export const upsertDigestToSupabase=(url:string,key:string,topic:string,region:string,digest_summary:string,digest_reliability:number|null,source_article_urls:string[])=>
  fetch(`${url}/rest/v1/news_digests?on_conflict=topic,region`,{method:"POST",headers:{...sbH(key),"Prefer":"return=representation,resolution=merge-duplicates"},body:JSON.stringify([{topic,region,digest_summary:digest_summary||"No summary.",digest_reliability:digest_reliability??null,source_article_urls,created_at:new Date().toISOString()}])}).catch(()=>{});

export async function insertArticlesToSupabase(url:string,key:string,articles:any[],topic:string,region:string,contractAddress:string|null){
  const rows=await Promise.all(articles.map(async a=>({url:a.url,title:a.title,description:a.description||a.summary||"",content:null,image:a.image??null,source:a.source?.name??"Unknown",published_at:a.publishedAt??new Date().toISOString(),published_ms:a.published_ms||new Date(a.publishedAt||0).getTime(),topic,region,category:a.category??null,freshness_label:fresh(a.publishedAt),cluster_tag:a.tier??"general",relevance_score:a.relevance_score??0.85,ai_summary:null,ai_reliability:null,content_hash:a.description?"0x"+await hashArticle(a.description):null,tx_hash:null,is_verified:false,publisher_address:null,blockchain_registered_at:null,contract_address:contractAddress,created_at:new Date().toISOString()})));
  await fetch(`${url}/rest/v1/news?on_conflict=url`,{method:"POST",headers:{...sbH(key),"Prefer":"resolution=merge-duplicates"},body:JSON.stringify(rows)}).catch(e=>console.error("Insert failed:",e));
}