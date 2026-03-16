// supabase/functions/fetch-news/news_tier.ts
// Imports all RSS logic from rss_dynamic.ts — this file handles APIs + pipeline only
import { getCountryCode } from "./region.ts";
import { hashArticle } from "./blockchain.ts";
import { fetchAllRSS, extractCoreEntity } from "./rss_dynamic.ts";

export const CACHE_DURATION_MS = 1800000;

// ── Reliability ratings ──────────────────────────────────────────────────────
const SRC_RATING:Record<string,number> = {"Reuters":5,"BBC News":5,"Associated Press":5,"AP":5,"Bloomberg":5,"The New York Times":5,"The Hindu":5,"PTI":5,"WHO":5,"UN":5,"IMF":5,"CNN":4,"Al Jazeera":4,"TechCrunch":4,"The Verge":4,"Times of India":4,"NDTV":4,"Hindustan Times":4,"The Assam Tribune":4,"Sentinel Assam":4,"EastMojo":4,"Nation Africa":4,"Standard Media":4,"The East African":4,"Wikinews":4,"Google News":4,"Wikipedia":4};
export const getReliability=(s:string)=>SRC_RATING[s]??3;

// ── Helpers ───────────────────────────────────────────────────────────────────
const strip  =(s:string)=>s.replace(/<[^>]+>/g,"");
const dedup  =(a:any[])=>{const s=new Set<string>();return a.filter(x=>{if(!x.url||s.has(x.url))return false;s.add(x.url);return true;});};
const fw     =async(url:string,ms=4000)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{"User-Agent":"Mozilla/5.0"}});clearTimeout(t);return r;}catch(e){clearTimeout(t);throw e;}};
const slug   =(s:string)=>encodeURIComponent(s.replace(/[^\w\s-]/g," ").replace(/\s+/g,"_").trim());
export const fresh  =(iso:string)=>{const ms=Date.now()-new Date(iso||0).getTime();return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older";};
const cov    =(n:number)=>n>=10?"comprehensive":n>=5?"good":n>=3?"moderate":"limited";
const rel    =(n:number)=>n>=10?4.5:n>=5?4.0:3.5;
const cleanT =(r:string)=>strip(r).trim().replace(/\s*[-–|]\s*[^-–|]{3,60}$/,"").trim();
const cleanD =(r:string)=>strip(r).replace(/https?:\/\/\S+/g,"").replace(/\s+/g," ").trim().slice(0,250);

// ── Normalisation / Intent / Entity ─────────────────────────────────────────
const STOP=/\b(what'?s?|who|where|when|why|how|tell\s+me|latest|news|updates?|happening|going\s+on|about|is\s+there|any|define|meaning\s+of|what\s+does|do\s+you\s+know\s+about|steps to|guide to|tutorial for|way to|apply for|procedure for|process of|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must)\b\s*/gi;
export const normalizeForDisplay=(q:string)=>(q.toLowerCase().replace(STOP,"").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim().replace(/^([a-z])/,c=>c.toUpperCase()))||extractCoreEntity(q);
export const normalizeForSearch =(q:string)=>q?.trim().length>1?q.trim().replace(/[^\w\s\-\/\+\.@]/g," ").replace(/\s+/g," ").trim():"current events";

export function detectIntent(q:string):string{
  q=q.toLowerCase().trim();
  if(/\b(live|happening|going on|latest|breaking|update|news|protest|strike)\b/.test(q)&&/\b(in|at|on|around|near|across)\b/.test(q))return"current_event";
  if(/\b(live|score|vs|versus|match|playing)\b/.test(q))return"live_event";
  if(/\b(happening|update|news|protest|strike|exam|result)\b/.test(q)&&/\b(university|college|campus|institute|faculty)\b/.test(q))return"institutional_event";
  if(/^(who|what|when|where|why|how)\s+is\b|^define\b|^meaning of\b/.test(q))return"definition";
  if(/how\s+to\b|steps to\b|guide to\b|tutorial for\b/.test(q))return"howto";
  if(/(latest|news|happening|updates?|breaking|today|right now|current|recent)\b/.test(q))return"news";
  return"general";
}

const PLACES=/\b(delhi|mumbai|kolkata|chennai|assam|tezpur|guwahati|bengaluru|nairobi|kenya|uganda|tanzania|rwanda|ethiopia|ghana|nigeria|senegal|mombasa|hyderabad|pune|ahmedabad|jaipur|lucknow|patna|bhopal|sonitpur|dibrugarh|jorhat|silchar|nagaon|lakhimpur|shillong|imphal|agartala|aizawl|kohima|itanagar|gangtok|kampala|dar\s+es\s+salaam|kigali|addis\s+ababa|accra|lagos|abuja|dakar|cairo|casablanca|johannesburg|cape\s+town|durban|nairobi|buenos\s+aires|sao\s+paulo|rio|mexico\s+city|bogota|lima|santiago|tokyo|beijing|shanghai|seoul|bangkok|jakarta|manila|kuala\s+lumpur|singapore|karachi|dhaka|colombo|kathmandu|kabul|tehran|baghdad|riyadh|dubai|istanbul|moscow|kyiv|warsaw|berlin|paris|rome|madrid|london|amsterdam|brussels|vienna|zurich|stockholm|oslo|copenhagen|helsinki|lisbon|athens|budapest|prague|bucharest|sofia|zagreb|belgrade|tirana|skopje|sarajevo|podgorica|pristina|chisinau|minsk|riga|vilnius|tallinn|reykjavik|sydney|melbourne|auckland|port\s+moresby|suva)\b/i;
export function detectEntityType(q:string,ct:string):string{
  q=q.toLowerCase();ct=ct.toLowerCase();
  if(/\b(city|town|village|district|state|country|river|mountain|forest|island|region|province)\b/.test(q)||PLACES.test(q)||PLACES.test(ct))return"place";
  if(/^(who is|biography of|profile of)/.test(q))return"person";
  if(/\b(university|college|school|institute|ministry|department|agency|ngo)\b/.test(ct))return"organization";
  if(/\b(flood|earthquake|cyclone|drought|election|festival|protest|strike|summit|war|conflict|disaster)\b/.test(q))return"event";
  if(/\b(apply for|how to|steps to|process of|procedure for)\b/.test(q))return"procedure";
  if(/\b(policy|law|act|bill|regulation)\b/.test(q))return"policy";
  if(/\b(disease|illness|fever|virus|treatment|vaccine|health|medical)\b/.test(q))return"health";
  if(/\b(food|cuisine|dish|recipe|meal)\b/.test(q))return"food";
  if(/\b(transport|metro|rail|bus|flight|road|traffic)\b/.test(q))return"transport";
  if(/\b(environment|climate|pollution|emission|carbon|green)\b/.test(q))return"environment";
  if(/\b(football|soccer|cricket|nba|tennis|sport|match|league|cup|live|score)\b/.test(q))return"sport";
  return"concept";
}

const IND_STATES=["Assam","Bihar","Karnataka","Kerala","Maharashtra","Tamil Nadu","Uttar Pradesh","West Bengal","Gujarat","Rajasthan","Delhi","Telangana","Andhra Pradesh","Odisha","Manipur","Meghalaya","Mizoram","Nagaland","Arunachal Pradesh","Sikkim","Tripura"];
export function expandQueryForCoverage(raw:string,regionKey:string,entityType:string):string[]{
  const base=raw.toLowerCase().trim();
  const core=extractCoreEntity(base);
  const noRec=!/\b(latest|recent|today|breaking|now|current|update|news|live)\b/i.test(base);
  const exp=[...new Set([
    base,core.toLowerCase(),
    ...(noRec?[`latest ${core}`,`${core} today`,`${core} news`]:[`${core} news`,`${core} latest`]),
    ...(entityType==="sport"||/\b(live|score|match|vs)\b/i.test(base)?[`${core} live`,`${core} score`]:[]),
    ...(["in","IN"].includes(regionKey)||/\b(assam|tezpur|guwahati|northeast)\b/i.test(base)?[`${core} India`,`${core} Assam`]:[]),
    ...(entityType==="place"?[`${core} updates`,`${core} events`]:[]),
  ])];
  const state=IND_STATES.find(s=>base.includes(s.toLowerCase()));
  if(state)exp.push(`${core} ${state}`);
  return exp.filter(Boolean).slice(0,5);
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 1 — GNews + NewsAPI (keyed, free tiers)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier1NewsAPIs(queries:string[],regionKey:string,gnews?:string,newsapi?:string):Promise<any[]>{
  const results=(await Promise.allSettled(queries.map(async(q,i)=>{
    const sq=encodeURIComponent(q);const batch:any[]=[];
    if(gnews){const r=await fw(`https://gnews.io/api/v4/search?q=${sq}&token=${gnews}&max=15&lang=en&country=${getCountryCode(regionKey)}`,4000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>batch.push({...a,tier:"gnews",expansion_index:i}));}
    if(newsapi){const r=await fw(`https://newsapi.org/v2/everything?q=${sq}&language=en&pageSize=15&sortBy=publishedAt&apiKey=${newsapi}`,4000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>batch.push({...a,tier:"newsapi",expansion_index:i,source:{name:a.source?.name??"NewsAPI"}}));}
    return batch;
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const d=dedup(results);console.log(`✅ T1 APIs: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 2 — Wikipedia Current Events (real articles, free)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier2WikipediaCurrentEvents():Promise<any[]>{
  try{
    const r=await fw("https://en.wikipedia.org/w/api.php?action=parse&page=Main_Page&prop=text&format=json&origin=*",3000);
    const html=(await r.json()).parse?.text?.["*"]??"";
    const block=/id="In_the_news"[^>]*>.*?<ul>(.*?)<\/ul>/s.exec(html)?.[1]??"";
    const items=[...block.matchAll(/<li>(.*?)<\/li>/gs)].map(m=>strip(m[1]).replace(/\[.*?\]/g,"").trim()).filter(t=>t.length>20&&!t.toLowerCase().includes("advert")).slice(0,8);
    console.log(`✅ T2 Wiki Events: ${items.length}`);
    return items.map((text,i)=>({title:text.split(".")[0].trim()+".",description:text,url:"https://en.wikipedia.org/wiki/Portal:Current_events",image:null,source:{name:"Wikipedia Current Events"},publishedAt:new Date(Date.now()-i*3600000).toISOString(),tier:"wikipedia_current",reliability:4.5}));
  }catch(e:any){console.warn("T2 failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 3 — ALL RSS (delegates to rss_dynamic.ts — covers every place on earth)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier3AllRSS(topic:string,regionKey:string):Promise<any[]>{
  return fetchAllRSS(topic,regionKey); // fully dynamic — no hardcoded feeds
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 4 — Wikipedia Background (real context, uses core entity)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier4WikipediaBackground(query:string):Promise<any|null>{
  const core=extractCoreEntity(query);
  for(const v of[core,query.split(" ")[0],query].filter((v,i,a)=>v&&v.length>2&&a.indexOf(v)===i)){
    try{
      const r=await fw(`https://en.wikipedia.org/w/api.php?action=parse&page=${slug(v)}&prop=text|displaytitle&format=json&origin=*`,3000);
      const data=(await r.json()).parse;if(!data)continue;
      const lead=strip(/<p>(.*?)<\/p>/s.exec(data.text["*"])?.[1]??"").replace(/\[.*?\]/g,"").replace(/\s+/g," ").trim().slice(0,400);
      if(lead.length>50){console.log(`✅ T4 Wiki BG: "${data.displaytitle}"`);return{title:data.displaytitle,summary:lead,url:`https://en.wikipedia.org/wiki/${slug(v)}`,tier:"wikipedia_background"};}
    }catch{}
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 5 — Wikidata (structured facts — uses core entity)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier5Wikidata(topic:string):Promise<any|null>{
  const core=extractCoreEntity(topic);
  try{
    const sr=await fw(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(core)}&language=en&limit=1&format=json&origin=*`,3000);
    if(!sr.ok)return null;
    const ent=(await sr.json()).search?.[0];if(!ent)return null;
    const er=await fw(`https://www.wikidata.org/wiki/Special:EntityData/${ent.id}.json`,3000);if(!er.ok)return null;
    const claims=(await er.json()).entities?.[ent.id]?.claims??{};
    const gv=(p:string)=>{const c=claims[p]?.[0]?.mainsnak?.datavalue?.value;if(!c)return null;if(typeof c==="string")return c;if(typeof c==="object"){if(c.text)return c.text;if(c.amount)return c.amount;if(c.time)return c.time;if(c.id)return c.id;}return null;};
    console.log(`✅ T5 Wikidata: ${ent.label}`);
    return{id:ent.id,label:ent.label,description:ent.description,url:`https://www.wikidata.org/wiki/${ent.id}`,wikipedia:`https://en.wikipedia.org/wiki/${slug(ent.label)}`,population:gv("P1082"),capital:gv("P36"),leader:gv("P6"),inception:gv("P571"),tier:"wikidata"};
  }catch(e:any){console.warn("T5 Wikidata failed:",e.message);return null;}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 6 — Currents API (free key, 600 req/day)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier6CurrentsAPI(topic:string,regionKey:string,apiKey?:string,max=15):Promise<any[]>{
  if(!apiKey)return[];
  const core=extractCoreEntity(topic);
  try{
    const p=new URLSearchParams({keywords:core,apiKey,language:"en"});
    const cc=getCountryCode(regionKey);if(cc&&cc!=="us")p.append("country",cc);
    const r=await fw(`https://api.currentsapi.services/v1/search?${p}`,4000);if(!r.ok)return[];
    const d=dedup((await r.json()).news?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:cleanD(a.description??""),image:a.image??null,publishedAt:a.published??new Date().toISOString(),source:{name:"Currents API"},tier:"currents",reliability:3.5,category:Array.isArray(a.category)?a.category[0]:"general"})).filter((a:any)=>a.title.length>10&&a.url)??[]).slice(0,max);
    console.log(`✅ T6 Currents: ${d.length}`);return d;
  }catch(e:any){console.warn("T6 Currents failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 7 — TheNewsAPI (free key, 100 req/day)
// ════════════════════════════════════════════════════════════════════════════
export async function fetchTier7TheNewsAPI(topic:string,_rk:string,apiKey?:string,max=15):Promise<any[]>{
  if(!apiKey)return[];
  const core=extractCoreEntity(topic);
  try{
    const p=new URLSearchParams({search:core,api_token:apiKey,language:"en",limit:String(max),sort:"published_at"});
    const r=await fw(`https://api.thenewsapi.com/v1/news/all?${p}`,4000);if(!r.ok)return[];
    const d=dedup((await r.json()).data?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:cleanD(a.description??""),image:a.image_url??null,publishedAt:a.published_at??new Date().toISOString(),source:{name:a.source??"TheNewsAPI"},tier:"thenewsapi",reliability:3.5})).filter((a:any)=>a.title.length>10&&a.url)??[]).slice(0,max);
    console.log(`✅ T7 TheNewsAPI: ${d.length}`);return d;
  }catch(e:any){console.warn("T7 TheNewsAPI failed:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 8 — YouTube (channel RSS + optional API key)
// ════════════════════════════════════════════════════════════════════════════
const YT_CH:Record<string,string>={"UCupvZG-5ko_eiXAupbDfxWw":"CNN","UC16niRr50-MSBwiO3YDb3RA":"BBC News","UCNye-wNBqNL5ZzHSJj3l8Bg":"Al Jazeera","UCIALMKvObZNtJ6AmdCLP_xQ":"Bloomberg","UChqUTb7kYRX8-EiaN3XFrSQ":"Reuters","UCHd62-u_v4DvJ8TCFtpi4GA":"DW News","UCWX3yGbODI3RYAMqGYhJohw":"France 24","UCknLrEdhRCp1aegoMqRaCZg":"Sky News","UCvsTdCRIE3EG9JER0j8q02Q":"Times of India","UClLDmQGQjnBnOzGRaGbFHrw":"NDTV","UCF9imwCEP-ZBnuFJBUGDcog":"NTV Kenya","UCZRv5HgoZ9FDPdVPYyGBbDA":"Citizen TV Kenya"};
export async function fetchTier8YouTube(topic:string,_rk:string,ytKey?:string,max=10):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const arts:any[]=[];
  if(ytKey){
    try{
      const p=new URLSearchParams({part:"snippet",q:`${core} news`,key:ytKey,type:"video",order:"date",maxResults:"10",publishedAfter:new Date(Date.now()-86400000).toISOString()});
      const r=await fw(`https://www.googleapis.com/youtube/v3/search?${p}`,4000);
      if(r.ok)(await r.json()).items?.forEach((i:any)=>{const s=i.snippet??{};arts.push({title:cleanT(s.title??""),url:`https://www.youtube.com/watch?v=${i.id?.videoId}`,description:cleanD(s.description??""),image:s.thumbnails?.medium?.url??null,publishedAt:s.publishedAt??new Date().toISOString(),source:{name:s.channelTitle??"YouTube"},tier:"youtube",reliability:3.5});});
    }catch(e:any){console.warn("YT API:",e.message);}
  }
  if(arts.length<3){
    const words=core.toLowerCase().split(/\s+/).filter((w:string)=>w.length>2);
    const rss=await Promise.allSettled(Object.keys(YT_CH).slice(0,8).map(async id=>{
      const r=await fw(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,3000).catch(()=>null);if(!r?.ok)return[];
      return[...((await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/gi))].map(e=>{const x=e[1];return{title:cleanT(/<title>([\s\S]*?)<\/title>/i.exec(x)?.[1]??""),url:/<link[^>]+href="([^"]+)"/i.exec(x)?.[1]??"",description:cleanD(/<media:description>([\s\S]*?)<\/media:description>/i.exec(x)?.[1]??""),image:/<media:thumbnail[^>]+url="([^"]+)"/i.exec(x)?.[1]??null,publishedAt:/<published>([\s\S]*?)<\/published>/i.exec(x)?.[1]??"",source:{name:YT_CH[id]},tier:"youtube",reliability:3.5};}).filter((a:any)=>a.title.length>5&&a.url&&words.some((w:string)=>a.title.toLowerCase().includes(w)||a.description.toLowerCase().includes(w)));
    }));
    arts.push(...rss.flatMap(r=>r.status==="fulfilled"?r.value:[]));
  }
  const d=dedup(arts).slice(0,max);console.log(`✅ T8 YouTube: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// MASTER PIPELINE — all tiers run in parallel
// ════════════════════════════════════════════════════════════════════════════
export async function fetchAllSources(
  topic:string,regionKey:string,queries:string[],
  opts:{gnewsKey?:string;newsapiKey?:string;currentsKey?:string;thenewsapiKey?:string;youtubeKey?:string;}={}
):Promise<{articles:any[];wiki:any|null;wikidata:any|null;sourceCounts:Record<string,number>;}>{
  const core=extractCoreEntity(topic);
  console.log(`\n🌍 Fetching: "${topic}" → core:"${core}" | Region: ${regionKey}`);
  const[t1,t2,t3,t5,t6,t7,t8,wiki,wikidata]=await Promise.allSettled([
    fetchTier1NewsAPIs(queries,regionKey,opts.gnewsKey,opts.newsapiKey),
    fetchTier2WikipediaCurrentEvents(),
    fetchTier3AllRSS(topic,regionKey),          // ← ALL RSS via rss_dynamic.ts
    fetchTier5Wikidata(topic),
    fetchTier6CurrentsAPI(topic,regionKey,opts.currentsKey),
    fetchTier7TheNewsAPI(topic,regionKey,opts.thenewsapiKey),
    fetchTier8YouTube(topic,regionKey,opts.youtubeKey),
    fetchTier4WikipediaBackground(topic),
    fetchTier5Wikidata(topic),
  ]);
  const get=(r:PromiseSettledResult<any>):any[]=>r.status==="fulfilled"&&Array.isArray(r.value)?r.value:[];
  const wikiResult=wiki.status==="fulfilled"?wiki.value:null;
  const wikidataResult=wikidata.status==="fulfilled"?wikidata.value:null;
  const allArticles=dedup([...get(t1),...get(t2),...get(t3),...get(t6),...get(t7),...get(t8)]);
  const sourceCounts:Record<string,number>={};
  for(const a of allArticles)sourceCounts[a.tier??"unknown"]=(sourceCounts[a.tier??"unknown"]??0)+1;
  console.log(`\n📊`,sourceCounts,`\n📰 Total real articles: ${allArticles.length}`);
  return{articles:allArticles,wiki:wikiResult,wikidata:wikidataResult,sourceCounts};
}

// ════════════════════════════════════════════════════════════════════════════
// SYNTHESISE — NO fake placeholders ever
// If no articles found: honest message only, no fake content
// ════════════════════════════════════════════════════════════════════════════
export function synthesizeWithGuaranteedCoverage(allArticles:any[],wiki:any,cleanTopic:string,_:string){
  const core=extractCoreEntity(cleanTopic);
  // Filter: real articles only — no placeholders, no stale (>7 days)
  const real=dedup(allArticles.filter(a=>a.url&&a.url!=="#"&&a.tier!=="placeholder"))
    .filter(a=>Date.now()-new Date(a.publishedAt||0).getTime()<7*864e5)
    .sort((a,b)=>new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime());

  // Build digest summary from real articles only
  const top3=real.slice(0,3).map(a=>{
    const m=Math.floor((Date.now()-new Date(a.publishedAt||0).getTime())/60000);
    const ago=m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`;
    return`(${ago}) ${a.title}`;
  });

  const parts=[
    ...(top3.length?[top3.join(" • ")]:[]),
    ...(wiki?[`📚 **Background**: ${wiki.summary}`]:[]),
    ...(real.length===0?[`ℹ️ No recent articles found for "${core}". Try searching in the local language or check back later.`]:[]),
    ...(real.length>0&&real.length<3?[`💡 Limited coverage for "${core}" — ${real.length} source(s) found.`]:[]),
  ];

  const sourceUrls=[...new Set([...real.slice(0,3).map((a:any)=>a.url),wiki?.url].filter(Boolean))];
  return{
    digest_summary:   parts.join(" ")||`Searching for "${core}"...`,
    digest_source_urls:sourceUrls,
    digest_reliability:rel(real.length),
    articles:         real,            // ← ONLY real articles, never fake
    coverage_tier:    cov(real.length),
    total_found:      real.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════
const sbH=(k:string)=>({"apikey":k,"Authorization":`Bearer ${k}`,"Content-Type":"application/json"});
export const upsertDigestToSupabase=(url:string,key:string,topic:string,region:string,digest_summary:string,digest_reliability:number|null,source_article_urls:string[])=>
  fetch(`${url}/rest/v1/news_digests?on_conflict=topic,region`,{method:"POST",headers:{...sbH(key),"Prefer":"return=representation,resolution=merge-duplicates"},body:JSON.stringify([{topic,region,digest_summary:digest_summary||"No summary.",digest_reliability:digest_reliability??null,source_article_urls,created_at:new Date().toISOString()}])}).catch(()=>{});

export async function insertArticlesToSupabase(url:string,key:string,articles:any[],topic:string,region:string,contractAddress:string|null){
  if(!articles.length)return;
  const rows=await Promise.all(articles.map(async a=>({url:a.url,title:a.title,description:a.description||a.summary||"",content:null,image:a.image??null,source:a.source?.name??"Unknown",published_at:a.publishedAt??new Date().toISOString(),published_ms:a.published_ms||new Date(a.publishedAt||0).getTime(),topic,region,category:a.category??null,freshness_label:fresh(a.publishedAt),cluster_tag:a.tier??"general",relevance_score:a.relevance_score??0.85,ai_summary:null,ai_reliability:null,content_hash:a.description?"0x"+await hashArticle(a.description):null,tx_hash:null,is_verified:false,publisher_address:null,blockchain_registered_at:null,contract_address:contractAddress,created_at:new Date().toISOString()})));
  await fetch(`${url}/rest/v1/news?on_conflict=url`,{method:"POST",headers:{...sbH(key),"Prefer":"resolution=merge-duplicates"},body:JSON.stringify(rows)}).catch(e=>console.error("Insert failed:",e));
}