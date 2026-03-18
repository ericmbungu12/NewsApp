// supabase/functions/fetch-news/news_tier.ts
import { NAME_ISO, ISO_TO_KEY, regionMap, getGoogleNewsGL, getLangForCountry, getISOsForRegion, getCountryCode } from "./region.ts";
import { hashArticle } from "./blockchain.ts";
import { extractCoreEntity, filterAndRank, expandQueryVariants, attachVectors } from "./fuzzy_search.ts";

export const CACHE_DURATION_MS = 900000; // 15 min

// ── Helpers ───────────────────────────────────────────────────────────────────
const fw    = async(url:string,ms=3000)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); try{ const r=await fetch(url,{signal:c.signal,headers:{"User-Agent":"Mozilla/5.0 (compatible; NewsBot/1.0)"}}); clearTimeout(t); return r; }catch(e){ clearTimeout(t); throw e; }};
const strip = (s:string)=>s.replace(/<[^>]+>/g,"");
const unesc = (s:string)=>s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g," ");
const cleanT= (s:string)=>strip(s).trim().replace(/\s*[-–|]\s*[^-–|]{3,60}$/,"").trim();
const cleanD= (s:string)=>unesc(strip(s)).replace(/https?:\/\/\S+/g,"").replace(/\s+/g," ").trim().slice(0,250);
const imgFn = (b:string):string|null=>/<media:content[^>]+url="([^"]+)"/i.exec(b)?.[1]??/<enclosure[^>]+url="([^"]+)"/i.exec(b)?.[1]??null;
const dedup = (a:any[])=>{ const s=new Set<string>(); return a.filter(x=>{ if(!x.url||s.has(x.url))return false; s.add(x.url); return true; }); };
const slug  = (s:string)=>encodeURIComponent(s.replace(/[^\w\s-]/g," ").replace(/\s+/g,"_").trim());
export const fresh=(iso:string)=>{ const ms=Date.now()-new Date(iso||0).getTime(); return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older"; };
const cov   = (n:number)=>n>=10?"comprehensive":n>=5?"good":n>=3?"moderate":"limited";
const rel   = (n:number)=>n>=10?4.5:n>=5?4.0:3.5;
const sbH   = (k:string)=>({"apikey":k,"Authorization":`Bearer ${k}`,"Content-Type":"application/json"});

// Minimum articles before cascade fires
const CASCADE_MIN = 5;

// ── Detect ISO from topic ──────────────────────────────────────────────────
function detectCountry(topic:string):string|null{
  const t=topic.toLowerCase();
  for(const[name,iso]of Object.entries(NAME_ISO).sort((a,b)=>b[0].length-a[0].length))
    if(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(t))return iso;
  return null;
}

// ── RSS XML parser ─────────────────────────────────────────────────────────
function parseXML(xml:string,src:string,tier="rss",reliability=3.8):any[]{
  return[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi),...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map(b=>{const r=b[1];
      const title=cleanT(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r)?.[1]??"");
      const url  =(/<link[^>]*href="([^"]+)"/i.exec(r)?.[1]??/<link>([\s\S]*?)<\/link>/i.exec(r)?.[1]??"").replace(/&amp;/g,"&").trim();
      const desc =cleanD(/<description>([\s\S]*?)<\/description>/i.exec(r)?.[1]??/<summary>([\s\S]*?)<\/summary>/i.exec(r)?.[1]??/<content[^>]*>([\s\S]*?)<\/content>/i.exec(r)?.[1]??"");
      const pub  =(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(r)?.[1]??/<updated>([\s\S]*?)<\/updated>/i.exec(r)?.[1]??/<published>([\s\S]*?)<\/published>/i.exec(r)?.[1]??"").trim();
      return title.length>5&&url.startsWith("http")&&!title.toLowerCase().includes("advert")
        ?{title,url,description:desc,image:imgFn(r),publishedAt:pub||new Date().toISOString(),source:{name:src},tier,reliability}:null;
    }).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════════
// UNIVERSAL CASCADE — geographic + language ladder
// Works for any topic, any location, any language on earth.
// Level 2–5: geographic expansion (country → sub-region → continent → global)
// Level 6:   local language query
// Level 7:   GDELT 72h hyper-local
// Level 8:   RSS Bridge DuckDuckGo
// Level 9:   Feedly feed discovery
// ════════════════════════════════════════════════════════════════════════════

function getGeographicLadder(topic:string, regionKey:string): string[] {
  const core    = extractCoreEntity(topic);
  const ladder: string[] = [];
  const iso     = detectCountry(topic);

  if (iso) {
    const countryKey  = ISO_TO_KEY[iso] ?? "";
    const countryName = countryKey.replace(/_/g, " ");

    // Level 2: country + topic
    if (countryName) ladder.push(`${countryName} ${core}`);

    // Level 3: sub-region
    const subRegionMap: Record<string,string> = {
      eastafrica:"east africa", westafrica:"west africa",
      northafrica:"north africa", southafrica:"southern africa",
      middleeast:"middle east", centralasia:"central asia",
      caribbean:"caribbean", oceania:"pacific",
      northamerica:"north america", southamerica:"south america",
    };
    for (const [region, codes] of Object.entries(regionMap)) {
      if (codes.includes(iso) && subRegionMap[region]) {
        ladder.push(`${subRegionMap[region]} ${core}`);
        break;
      }
    }

    // Level 4: continent
    const continentMap: Record<string,string> = {
      africa:"africa", eastafrica:"africa", westafrica:"africa",
      northafrica:"africa", southafrica:"africa",
      asia:"asia", middleeast:"middle east", centralasia:"asia",
      europe:"europe", northamerica:"america",
      southamerica:"south america", caribbean:"caribbean",
      oceania:"oceania",
    };
    for (const [region, codes] of Object.entries(regionMap)) {
      if (codes.includes(iso) && continentMap[region]) {
        ladder.push(`${continentMap[region]} ${core}`);
        break;
      }
    }
  }

  // Level 5: topic only — strip location, search globally
  const iso2        = detectCountry(topic);
  const countryName2= iso2 ? (ISO_TO_KEY[iso2] ?? "").replace(/_/g," ") : "";
  const mainTopic   = core
    .split(" ")
    .filter(w => !countryName2.split(" ").some(cn => cn.toLowerCase() === w.toLowerCase()))
    .join(" ")
    .trim();
  if (mainTopic && mainTopic !== core && mainTopic.length > 2) {
    ladder.push(mainTopic);
  }

  // Region key as additional context
  if (regionKey && regionKey !== "global") {
    ladder.push(`${regionKey.replace(/_/g, " ")} ${core}`);
  }

  return [...new Set(ladder)].filter(Boolean);
}

function getLocalLanguageQueries(topic: string): string[] {
  const iso = detectCountry(topic);
  if (!iso) return [];
  const core = extractCoreEntity(topic);

  const translations: Record<string, Record<string, string>> = {
    flood:       { hi:"बाढ़", bn:"বন্যা", ar:"فيضان", fr:"inondation", es:"inundación", pt:"inundação", sw:"mafuriko", id:"banjir", tr:"sel", uk:"повінь", ru:"наводнение", vi:"lũ lụt", th:"น้ำท่วม" },
    earthquake:  { hi:"भूकंप", bn:"ভূমিকম্প", ar:"زلزال", fr:"tremblement de terre", es:"terremoto", pt:"terremoto", sw:"tetemeko", id:"gempa", tr:"deprem", uk:"землетрус", ru:"землетрясение", vi:"động đất", th:"แผ่นดินไหว" },
    election:    { hi:"चुनाव", bn:"নির্বাচন", ar:"انتخابات", fr:"élection", es:"elección", pt:"eleição", sw:"uchaguzi", id:"pemilu", tr:"seçim", uk:"вибори", ru:"выборы", vi:"bầu cử", th:"การเลือกตั้ง" },
    protest:     { hi:"विरोध", bn:"প্রতিবাদ", ar:"احتجاج", fr:"manifestation", es:"protesta", pt:"protesto", sw:"maandamano", id:"protes", tr:"protesto", uk:"протест", ru:"протест", vi:"biểu tình", th:"การประท้วง" },
    hurricane:   { es:"huracán", fr:"ouragan", pt:"furacão", ar:"إعصار", id:"badai", vi:"bão", th:"พายุเฮอริเคน" },
    cyclone:     { hi:"चक्रवात", bn:"ঘূর্ণিঝড়", ar:"إعصار", fr:"cyclone", sw:"kimbunga", id:"siklon", th:"พายุไซโคลน" },
    drought:     { hi:"सूखा", ar:"جفاف", fr:"sécheresse", es:"sequía", pt:"seca", sw:"ukame", id:"kekeringan", vi:"hạn hán" },
    war:         { ar:"حرب", fr:"guerre", es:"guerra", pt:"guerra", sw:"vita", id:"perang", ru:"война", uk:"війна", vi:"chiến tranh", th:"สงคราม" },
    fire:        { hi:"आग", ar:"حريق", fr:"incendie", es:"incendio", pt:"incêndio", sw:"moto", id:"kebakaran", tr:"yangın", vi:"cháy", th:"ไฟไหม้" },
    strike:      { hi:"हड़ताल", ar:"إضراب", fr:"grève", es:"huelga", pt:"greve", sw:"mgomo", id:"mogok", th:"นัดหยุดงาน" },
    crisis:      { ar:"أزمة", fr:"crise", es:"crisis", pt:"crise", sw:"mgawanyiko", id:"krisis", ru:"кризис", vi:"khủng hoảng" },
    attack:      { ar:"هجوم", fr:"attaque", es:"ataque", pt:"ataque", sw:"mashambulizi", id:"serangan", ru:"нападение", uk:"напад" },
    disaster:    { hi:"आपदा", ar:"كارثة", fr:"catastrophe", es:"desastre", pt:"desastre", sw:"maafa", id:"bencana", ru:"катастрофа" },
    outbreak:    { hi:"प्रकोप", ar:"تفشي", fr:"épidémie", es:"brote", pt:"surto", sw:"mlipuko", id:"wabah", vi:"dịch bệnh" },
  };

  const gl   = getGoogleNewsGL(iso);
  const lang = getLangForCountry(gl).split("-")[0];
  const queries: string[] = [];

  for (const [keyword, langs] of Object.entries(translations)) {
    if (core.toLowerCase().includes(keyword) && langs[lang]) {
      const locationWord = core.split(" ").pop() ?? "";
      if (locationWord) queries.push(`${langs[lang]} ${locationWord}`);
      queries.push(`${langs[lang]} ${core}`);
      break;
    }
  }

  return queries;
}

// ── Universal cascade search ───────────────────────────────────────────────
export async function cascadeSearch(
  topic: string,
  regionKey: string,
  existingCount: number
): Promise<any[]> {
  if (existingCount >= CASCADE_MIN) return [];
  const core       = extractCoreEntity(topic);
  const allResults: any[] = [];
  let found        = existingCount;

  console.log(`🔄 Cascade: only ${found} results — expanding...`);

  // Level 2–5: Geographic expansion
  const geoQueries = getGeographicLadder(topic, regionKey);
  for (const q of geoQueries) {
    if (found >= CASCADE_MIN) break;
    try {
      const r = await fw(
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=US&ceid=US:en`,
        3000
      );
      if (!r.ok) continue;
      const batch = filterAndRank(core, parseXML(await r.text(), "Google News", "cascade_geo", 3.8), 0.08);
      allResults.push(...batch);
      found += batch.length;
      console.log(`  🌍 Cascade geo [${q}]: +${batch.length}`);
    } catch {}
  }

  // Level 6: Local language
  if (found < CASCADE_MIN) {
    const localQueries = getLocalLanguageQueries(topic);
    const iso          = detectCountry(topic) ?? "US";
    const gl           = getGoogleNewsGL(iso);
    const lang         = getLangForCountry(gl);
    for (const q of localQueries) {
      if (found >= CASCADE_MIN) break;
      try {
        const r = await fw(
          `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang}&gl=${gl}&ceid=${gl}:${lang}`,
          3000
        );
        if (!r.ok) continue;
        const batch = filterAndRank(core, parseXML(await r.text(), "Google News Local", "cascade_local", 3.8), 0.05);
        allResults.push(...batch);
        found += batch.length;
        console.log(`  🗣️ Cascade local [${q}]: +${batch.length}`);
      } catch {}
    }
  }

  // Level 7: GDELT — 72h, 65,000 global sources
  if (found < CASCADE_MIN) {
    const gdeltQueries = [core, ...getGeographicLadder(topic, regionKey).slice(0, 2)];
    for (const q of gdeltQueries) {
      if (found >= CASCADE_MIN) break;
      try {
        const p = new URLSearchParams({
          query:q, mode:"artlist", maxrecords:"20",
          format:"json", timespan:"72h", sort:"DateDesc",
        });
        const r = await fw(`https://api.gdeltproject.org/api/v2/doc/doc?${p}`, 4000);
        if (!r.ok) continue;
        const articles = ((await r.json()).articles ?? [])
          .map((a:any) => ({
            title:       cleanT(a.title ?? ""),
            url:         a.url ?? "",
            description: cleanT(a.title ?? ""),
            image:       null,
            publishedAt: a.seendate
              ? new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z")).toISOString()
              : new Date().toISOString(),
            source: { name: a.domain ?? "GDELT" },
            tier:"gdelt", reliability:3.5,
          }))
          .filter((a:any) => a.title.length > 5 && a.url);
        const batch = filterAndRank(core, articles, 0.06);
        allResults.push(...batch);
        found += batch.length;
        console.log(`  📡 Cascade GDELT [${q}]: +${batch.length}`);
      } catch {}
    }
  }

  // Level 8: RSS Bridge DuckDuckGo
  if (found < CASCADE_MIN) {
    const ddgQueries = [core, ...getGeographicLadder(topic, regionKey).slice(0, 1)];
    for (const q of ddgQueries) {
      if (found >= CASCADE_MIN) break;
      try {
        const r = await fw(
          `https://rss-bridge.org/bridge01/?action=display&bridge=DuckDuckGoBridge&q=${encodeURIComponent(q + " news")}&format=Atom`,
          5000
        );
        if (!r.ok) continue;
        const batch = filterAndRank(core, parseXML(await r.text(), "RSS Bridge", "cascade_ddg", 3.2), 0.06);
        allResults.push(...batch);
        found += batch.length;
        console.log(`  🦆 Cascade DDG [${q}]: +${batch.length}`);
      } catch {}
    }
  }

  // Level 9: Feedly feed discovery
  if (found < CASCADE_MIN) {
    try {
      const r = await fw(
        `https://feedly.com/v3/search/feeds?query=${encodeURIComponent(core + " news")}&count=5`,
        4000
      );
      if (r.ok) {
        const feeds: string[] = [];
        (await r.json()).results?.forEach((f:any) => {
          const u = f.feedId?.replace(/^feed\//, "");
          if (u?.startsWith("http")) feeds.push(u);
        });
        for (const feedUrl of feeds) {
          if (found >= CASCADE_MIN) break;
          try {
            const fr = await fw(feedUrl, 3000);
            if (!fr.ok) continue;
            const batch = filterAndRank(
              core,
              parseXML(await fr.text(), new URL(feedUrl).hostname.replace("www.", ""), "cascade_feedly", 3.5),
              0.06
            );
            allResults.push(...batch);
            found += batch.length;
            console.log(`  📰 Cascade Feedly [${feedUrl}]: +${batch.length}`);
          } catch {}
        }
      }
    } catch {}
  }

  console.log(`✅ Cascade complete: +${allResults.length} additional`);
  return dedup(allResults);
}

// ════════════════════════════════════════════════════════════════════════════
// RSS SOURCES S1–S8
// ════════════════════════════════════════════════════════════════════════════

async function rssGoogle(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const isos=[...new Set([...getISOsForRegion(regionKey),...(detectCountry(topic)??[]).toString().split(",")])].slice(0,8);
  const terms=expandQueryVariants(core).slice(0,3);
  const urls=new Set<string>([
    ...isos.flatMap(iso=>{const gl=getGoogleNewsGL(iso);const lang=getLangForCountry(gl);return terms.map(t=>`https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=${lang}&gl=${gl}&ceid=${gl}:${lang}`);}),
    ...terms.map(t=>`https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=en&gl=US&ceid=US:en`),
  ]);
  const raw=dedup((await Promise.allSettled([...urls].map(async u=>{try{const r=await fw(u,3000);if(!r.ok)return[];return parseXML(await r.text(),"Google News","google_news",4.0);}catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ Google News: ${d.length}/${raw.length}`);return d;
}

async function rssWikinews(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const iso=detectCountry(topic)??getISOsForRegion(regionKey)[0]??"US";
  const lang=getLangForCountry(getGoogleNewsGL(iso)).split("-")[0];
  const raw=dedup((await Promise.allSettled([...new Set([lang,"en"])].map(async l=>{
    try{const r=await fw(`https://${l}.wikinews.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(core)}&format=json&origin=*&srlimit=10`,3000);if(!r.ok)return[];
      return((await r.json()).query?.search??[]).map((s:any)=>({title:cleanT(s.title??""),url:`https://${l}.wikinews.org/wiki/${encodeURIComponent((s.title??"").replace(/ /g,"_"))}`,description:strip(s.snippet??"").replace(/\.\.\./g,"").trim().slice(0,200),image:null,publishedAt:new Date(s.timestamp??Date.now()).toISOString(),source:{name:"Wikinews"},tier:"wikinews",reliability:4.0}));
    }catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ Wikinews: ${d.length}`);return d;
}

const AGG:Record<string,{url:string;name:string}>={
  africa:{url:"https://www.africanews.com/feed/rss",name:"Africanews"},
  eastafrica:{url:"https://www.theeastafrican.co.ke/rss",name:"The East African"},
  westafrica:{url:"https://www.theafricareport.com/feed/",name:"The Africa Report"},
  northafrica:{url:"https://egyptindependent.com/feed/",name:"Egypt Independent"},
  southafrica:{url:"https://www.dailymaverick.co.za/feed/",name:"Daily Maverick"},
  asia:{url:"https://www.thewire.in/feed/",name:"The Wire"},
  middleeast:{url:"https://english.alarabiya.net/tools/rss",name:"Al Arabiya"},
  europe:{url:"https://www.euronews.com/rss",name:"Euronews"},
  northamerica:{url:"https://feeds.npr.org/1001/rss.xml",name:"NPR"},
  southamerica:{url:"https://www.mercopress.com/rss.asp",name:"MercoPress"},
  oceania:{url:"https://www.abc.net.au/news/feed/51120/rss.xml",name:"ABC Australia"},
  caribbean:{url:"https://www.caribbeannationalweekly.com/feed/",name:"Caribbean Weekly"},
  centralasia:{url:"https://eurasianet.org/rss.xml",name:"Eurasianet"},
  global:{url:"https://www.reuters.com/feed/worldNews/",name:"Reuters"},
};

async function rssAggregators(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const isos=[...new Set([...getISOsForRegion(regionKey),...(detectCountry(topic)?[detectCountry(topic)!]:[])])];
  const groups=new Set<string>(["global"]);
  for(const[g,codes]of Object.entries(regionMap))if(codes.some(c=>isos.includes(c))&&AGG[g])groups.add(g);
  const raw=dedup((await Promise.allSettled([...groups].map(async g=>{const{url,name}=AGG[g];try{const r=await fw(url,3000);if(!r.ok)return[];return parseXML(await r.text(),name,"regional_agg",3.8);}catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ Aggregators: ${d.length}/${raw.length}`);return d;
}

async function rssFeedly(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);const feeds:string[]=[];
  try{const r=await fw(`https://feedly.com/v3/search/feeds?query=${encodeURIComponent(core+" news")}&count=8`,3000);if(r.ok)(await r.json()).results?.forEach((f:any)=>{const u=f.feedId?.replace(/^feed\//,"");if(u?.startsWith("http"))feeds.push(u);});}catch{}
  if(!feeds.length)return[];
  const raw=dedup((await Promise.allSettled(feeds.map(async url=>{try{const r=await fw(url,3000);if(!r.ok)return[];return parseXML(await r.text(),new URL(url).hostname.replace("www.",""),"discovered_feed",3.5);}catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ Feedly: ${d.length}`);return d;
}

async function rssBridge(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const raw=dedup((await Promise.allSettled([
    `https://rss-bridge.org/bridge01/?action=display&bridge=DuckDuckGoBridge&q=${encodeURIComponent(core+" news")}&format=Atom`,
    `https://rss-bridge.org/bridge01/?action=display&bridge=GoogleSearchBridge&q=${encodeURIComponent(core+" latest")}&format=Atom`,
  ].map(async url=>{try{const r=await fw(url,4000);if(!r.ok)return[];return parseXML(await r.text(),"RSS Bridge","rss_bridge",3.5);}catch{return[];}})))
    .flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ RSS Bridge: ${d.length}`);return d;
}

// 72h window + multiple query variants
async function rssGDELT(topic:string,regionKey:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const iso=detectCountry(topic)??getISOsForRegion(regionKey)[0]??"US";
  const rn=ISO_TO_KEY[iso]??regionKey;
  const queries=[
    ...new Set([
      core,
      core!==rn?`${core} ${rn}`:null,
      `${core} latest`,
      rn!=="global"?rn:null,
    ].filter(Boolean) as string[])
  ].slice(0,4);
  const raw=dedup((await Promise.allSettled(queries.map(async q=>{
    try{
      const p=new URLSearchParams({query:q,mode:"artlist",maxrecords:"20",format:"json",timespan:"72h",sort:"DateDesc"});
      const r=await fw(`https://api.gdeltproject.org/api/v2/doc/doc?${p}`,4000);
      if(!r.ok)return[];
      return((await r.json()).articles??[]).map((a:any)=>({
        title:cleanT(a.title??""),url:a.url??"",description:cleanT(a.title??""),image:null,
        publishedAt:a.seendate?new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z")).toISOString():new Date().toISOString(),
        source:{name:a.domain??"GDELT"},tier:"gdelt",reliability:3.5,
      })).filter((a:any)=>a.title.length>5&&a.url);
    }catch{return[];}
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]));
  const d=filterAndRank(core,raw,0.10);console.log(`✅ GDELT: ${d.length}`);return d;
}

// Topic-specific via Google News site: operator
async function rssLive(topic:string,isSport=false):Promise<any[]>{
  const core    =extractCoreEntity(topic);
  const variants=expandQueryVariants(core).slice(0,2);

  const NEWS_OUTLETS=[
    "bbc.com","reuters.com","aljazeera.com",
    "theguardian.com","apnews.com","france24.com",
    "dw.com","skynews.com","nytimes.com",
    "africatimes.com","mercopress.com","channelnewsasia.com",
    "arabnews.com","rfi.fr","abc.net.au",
  ];
  const SPORT_OUTLETS=[
    "espn.com","skysports.com","cricbuzz.com",
    "goal.com","bbc.co.uk/sport","si.com",
    "bleacherreport.com","eurosport.com",
  ];

  const outlets=[...(isSport?SPORT_OUTLETS:[]),...NEWS_OUTLETS];
  const searchUrls=outlets.flatMap(outlet=>
    variants.slice(0,2).map(v=>({
      url:`https://news.google.com/rss/search?q=${encodeURIComponent(v)}+site:${outlet}&hl=en&gl=US&ceid=US:en`,
      name:outlet.split(".")[0].replace("/sport",""),
    }))
  );

  const raw=dedup(
    (await Promise.allSettled(
      searchUrls.map(async({url,name})=>{
        try{const r=await fw(url,3000);if(!r.ok)return[];return parseXML(await r.text(),name,"live_feed",4.2);}
        catch{return[];}
      })
    )).flatMap(r=>r.status==="fulfilled"?r.value:[])
  );
  const d=filterAndRank(core,raw,0.10);console.log(`✅ Live: ${d.length}`);return d;
}

// 3 query variants
async function rssWebSearch(topic:string):Promise<any[]>{
  const core=extractCoreEntity(topic);
  const variants=[`${core} news`,`${core} latest 2026`,`${core} today`];
  const arts:any[]=[];
  for(const query of variants){
    if(arts.length>=10)break;
    try{
      const r=await fw(`https://api.allorigins.win/get?url=${encodeURIComponent(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=news`)}`,4000);
      if(!r.ok)continue;
      const matches=[...((await r.json()).contents?.matchAll(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)??[])].slice(0,8);
      for(const m of matches){
        const u=decodeURIComponent(m[1].replace(/.*uddg=/,"").split("&")[0]);
        const title=strip(m[2]).trim();
        if(title.length>5&&u.startsWith("http")&&!u.includes("duckduckgo")&&!arts.find(a=>a.url===u)){
          arts.push({title:cleanT(title),url:u,description:strip(m[3]).trim().slice(0,200),image:null,publishedAt:new Date().toISOString(),source:{name:new URL(u).hostname.replace("www.","")},tier:"web_search",reliability:3.2});
        }
      }
    }catch(e:any){console.warn(`Web search [${query}]:`,e.message);}
  }
  const d=filterAndRank(core,arts,0.10);console.log(`✅ Web Search: ${d.length}`);return d;
}

// ════════════════════════════════════════════════════════════════════════════
// QUERY UNDERSTANDING
// ════════════════════════════════════════════════════════════════════════════
const STOP=/\b(what'?s?|who|where|when|why|how|tell\s+me|latest|news|updates?|happening|going\s+on|about|is\s+there|any|define|meaning\s+of|what\s+does|steps to|guide to|way to|apply for|process of|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must)\b\s*/gi;
export const normalizeForDisplay=(q:string)=>(q.toLowerCase().replace(STOP,"").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim().replace(/^([a-z])/,c=>c.toUpperCase()))||extractCoreEntity(q);
export const normalizeForSearch =(q:string)=>q?.trim().length>1?q.trim().replace(/[^\w\s\-\/\+\.@]/g," ").replace(/\s+/g," ").trim():"current events";

export function detectIntent(q:string):string{
  q=q.toLowerCase().trim();
  if(/\b(live|score|vs|versus|match|playing|streaming)\b/.test(q))return"live_event";
  if(/\b(happening|going on|latest|breaking|update|news|protest|strike)\b/.test(q)&&/\b(in|at|on|around|near|across)\b/.test(q))return"current_event";
  if(/^(who|what|when|where|why|how)\s+is\b|^define\b|^meaning of\b/.test(q))return"definition";
  if(/how\s+to\b|steps to\b|guide to\b|tutorial for\b/.test(q))return"howto";
  if(/(latest|news|happening|updates?|breaking|today|right now|current|recent)\b/.test(q))return"news";
  return"general";
}

export function detectEntityType(q:string,ct:string):string{
  q=q.toLowerCase();ct=ct.toLowerCase();
  if(/\b(city|town|village|district|state|country|river|mountain|island|region|province)\b/.test(q))return"place";
  if(/^(who is|biography of|profile of)/.test(q))return"person";
  if(/\b(university|college|school|institute|ministry|department|agency|ngo)\b/.test(ct))return"organization";
  if(/\b(flood|earthquake|cyclone|drought|election|festival|protest|strike|summit|war|conflict|disaster)\b/.test(q))return"event";
  if(/\b(football|soccer|cricket|nba|tennis|sport|match|league|cup|live|score|vs)\b/.test(q))return"sport";
  if(/\b(health|disease|illness|fever|virus|treatment|vaccine|medical)\b/.test(q))return"health";
  if(/\b(policy|law|act|bill|regulation)\b/.test(q))return"policy";
  if(/\b(environment|climate|pollution|emission|carbon|green)\b/.test(q))return"environment";
  return"concept";
}

// ════════════════════════════════════════════════════════════════════════════
// UNIVERSAL QUERY EXPANSION
// Works for any topic on earth — no predefined categories needed.
// Generates expansions purely from the words in the query itself.
// ════════════════════════════════════════════════════════════════════════════
export function expandQueryForCoverage(
  raw: string,
  regionKey: string,
  _entityType: string  // kept for signature compatibility — no longer gates expansions
): string[] {
  const core = extractCoreEntity(raw);
  const base = raw.toLowerCase();

  // 1. Base variants
  const baseVariants = expandQueryVariants(core).slice(0, 3);

  // 2. Geographic ladder — works for any location
  const geoLadder = getGeographicLadder(raw, regionKey);

  // 3. Local language
  const localLang = getLocalLanguageQueries(raw);

  // 4. Universal recency modifiers — work for ANY topic
  const recency = [
    `${core} latest`,
    `${core} today`,
    `${core} 2026`,
    `${core} news`,
    `${core} update`,
  ];

  // 5. Universal word-based context variants
  // Works for ANY topic: "coffee Ethiopia", "anime Japan", "Maori culture",
  // "quantum computing", "Amazonian deforestation", "jazz New Orleans" etc.
  const words = core
    .split(" ")
    .filter(w => w.length > 2)
    .map(w => w.toLowerCase());

  const contextVariants: string[] = [];

  // Reverse word order — "coffee Ethiopia" → "Ethiopia coffee"
  if (words.length >= 2) {
    const reversed = [...words].reverse().join(" ");
    if (reversed !== core.toLowerCase()) {
      contextVariants.push(reversed);
      contextVariants.push(`${reversed} news`);
      contextVariants.push(`${reversed} latest`);
    }
  }

  // Each individual word + "news" — catches single-concept searches
  // "quantum computing" → "quantum news", "computing news"
  if (words.length >= 2) {
    for (const w of words) {
      if (w.length > 3) contextVariants.push(`${w} news`);
    }
  }

  // 6. Year + month
  const withYear = [`${core} 2026`, `${core} March 2026`];

  // 7. Region-scoped if not already in query
  if (regionKey && regionKey !== "global") {
    const regionName = regionKey.replace(/_/g, " ");
    if (!base.includes(regionName)) {
      contextVariants.push(`${regionName} ${core}`);
      contextVariants.push(`${core} ${regionName}`);
    }
  }

  return [
    ...new Set([
      ...baseVariants,
      ...recency,
      ...contextVariants,
      ...geoLadder,
      ...localLang,
      ...withYear,
    ])
  ].filter(Boolean).slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// API TIERS T1–T9
// ════════════════════════════════════════════════════════════════════════════

export async function fetchTier1NewsAPIs(queries:string[],regionKey:string,gnews?:string,newsapi?:string):Promise<any[]>{
  const core=extractCoreEntity(queries[0]??"");
  const results=(await Promise.allSettled(queries.map(async(q,i)=>{const sq=encodeURIComponent(q);const b:any[]=[];
    if(gnews){const r=await fw(`https://gnews.io/api/v4/search?q=${sq}&token=${gnews}&max=15&lang=en&country=${getCountryCode(regionKey)}`,3000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>b.push({...a,tier:"gnews",expansion_index:i}));}
    if(newsapi){const r=await fw(`https://newsapi.org/v2/everything?q=${sq}&language=en&pageSize=15&sortBy=publishedAt&apiKey=${newsapi}`,3000).catch(()=>null);if(r?.ok)(await r.json()).articles?.forEach((a:any)=>b.push({...a,tier:"newsapi",expansion_index:i,source:{name:a.source?.name??"NewsAPI"}}));}
    return b;
  }))).flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const d=filterAndRank(core,dedup(results),0.10);console.log(`✅ T1 APIs: ${d.length}`);return d;
}

export async function fetchTier2WikipediaCurrentEvents():Promise<any[]>{
  try{
    const r=await fw("https://en.wikipedia.org/w/api.php?action=parse&page=Main_Page&prop=text&format=json&origin=*",3000);
    const html=(await r.json()).parse?.text?.["*"]??"";
    const block=/id="In_the_news"[^>]*>.*?<ul>(.*?)<\/ul>/s.exec(html)?.[1]??"";
    const items=[...block.matchAll(/<li>(.*?)<\/li>/gs)].map(m=>strip(m[1]).replace(/\[.*?\]/g,"").trim()).filter(t=>t.length>20).slice(0,8);
    console.log(`✅ T2 Wiki: ${items.length}`);
    return items.map((text,i)=>({title:text.split(".")[0].trim()+".",description:text,url:"https://en.wikipedia.org/wiki/Portal:Current_events",image:null,source:{name:"Wikipedia Current Events"},publishedAt:new Date(Date.now()-i*3600000).toISOString(),tier:"wikipedia_current",reliability:4.5}));
  }catch(e:any){console.warn("T2 failed:",e.message);return[];}
}

export async function fetchTier4WikipediaBackground(query:string):Promise<any|null>{
  const core=extractCoreEntity(query);
  for(const v of[core,query.split(" ")[0]].filter((v,i,a)=>v&&v.length>2&&a.indexOf(v)===i)){
    try{const r=await fw(`https://en.wikipedia.org/w/api.php?action=parse&page=${slug(v)}&prop=text|displaytitle&format=json&origin=*`,3000);
      const data=(await r.json()).parse;if(!data)continue;
      const lead=strip(/<p>(.*?)<\/p>/s.exec(data.text["*"])?.[1]??"").replace(/\[.*?\]/g,"").replace(/\s+/g," ").trim().slice(0,400);
      if(lead.length>50){console.log(`✅ T4 Wiki BG: "${data.displaytitle}"`);return{title:data.displaytitle,summary:lead,url:`https://en.wikipedia.org/wiki/${slug(v)}`,tier:"wikipedia_background"};}
    }catch{}
  }
  return null;
}

export async function fetchTier5Wikidata(topic:string):Promise<any|null>{
  const core=extractCoreEntity(topic);
  try{
    const sr=await fw(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(core)}&language=en&limit=1&format=json&origin=*`,3000);
    if(!sr.ok)return null;const ent=(await sr.json()).search?.[0];if(!ent)return null;
    const er=await fw(`https://www.wikidata.org/wiki/Special:EntityData/${ent.id}.json`,3000);if(!er.ok)return null;
    const claims=(await er.json()).entities?.[ent.id]?.claims??{};
    const gv=(p:string)=>{const c=claims[p]?.[0]?.mainsnak?.datavalue?.value;if(!c)return null;if(typeof c==="string")return c;if(typeof c==="object"){if(c.text)return c.text;if(c.amount)return c.amount;if(c.time)return c.time;if(c.id)return c.id;}return null;};
    console.log(`✅ T5 Wikidata: ${ent.label}`);
    return{id:ent.id,label:ent.label,description:ent.description,url:`https://www.wikidata.org/wiki/${ent.id}`,wikipedia:`https://en.wikipedia.org/wiki/${slug(ent.label)}`,population:gv("P1082"),capital:gv("P36"),leader:gv("P6"),inception:gv("P571"),tier:"wikidata"};
  }catch(e:any){console.warn("T5 Wikidata:",e.message);return null;}
}

export async function fetchTier6CurrentsAPI(topic:string,regionKey:string,apiKey?:string,max=15):Promise<any[]>{
  if(!apiKey)return[];const core=extractCoreEntity(topic);
  try{
    const p=new URLSearchParams({keywords:core,apiKey,language:"en"});const cc=getCountryCode(regionKey);if(cc&&cc!=="us")p.append("country",cc);
    const r=await fw(`https://api.currentsapi.services/v1/search?${p}`,3000);if(!r.ok)return[];
    const d=filterAndRank(core,dedup((await r.json()).news?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:cleanD(a.description??""),image:a.image??null,publishedAt:a.published??new Date().toISOString(),source:{name:"Currents API"},tier:"currents",reliability:3.5})).filter((a:any)=>a.title.length>5&&a.url)??[]),0.10).slice(0,max);
    console.log(`✅ T6 Currents: ${d.length}`);return d;
  }catch(e:any){console.warn("T6:",e.message);return[];}
}

export async function fetchTier7TheNewsAPI(topic:string,_rk:string,apiKey?:string,max=15):Promise<any[]>{
  if(!apiKey)return[];const core=extractCoreEntity(topic);
  try{
    const p=new URLSearchParams({search:core,api_token:apiKey,language:"en",limit:String(max),sort:"published_at"});
    const r=await fw(`https://api.thenewsapi.com/v1/news/all?${p}`,3000);if(!r.ok)return[];
    const d=filterAndRank(core,dedup((await r.json()).data?.map((a:any)=>({title:cleanT(a.title??""),url:a.url??"",description:cleanD(a.description??""),image:a.image_url??null,publishedAt:a.published_at??new Date().toISOString(),source:{name:a.source??"TheNewsAPI"},tier:"thenewsapi",reliability:3.5})).filter((a:any)=>a.title.length>5&&a.url)??[]),0.10).slice(0,max);
    console.log(`✅ T7 TheNewsAPI: ${d.length}`);return d;
  }catch(e:any){console.warn("T7:",e.message);return[];}
}

const YT_CH:Record<string,string>={"UCupvZG-5ko_eiXAupbDfxWw":"CNN","UC16niRr50-MSBwiO3YDb3RA":"BBC News","UCNye-wNBqNL5ZzHSJj3l8Bg":"Al Jazeera","UCIALMKvObZNtJ6AmdCLP_xQ":"Bloomberg","UChqUTb7kYRX8-EiaN3XFrSQ":"Reuters","UCHd62-u_v4DvJ8TCFtpi4GA":"DW News","UCWX3yGbODI3RYAMqGYhJohw":"France 24","UCknLrEdhRCp1aegoMqRaCZg":"Sky News","UCvsTdCRIE3EG9JER0j8q02Q":"Times of India","UClLDmQGQjnBnOzGRaGbFHrw":"NDTV","UCF9imwCEP-ZBnuFJBUGDcog":"NTV Kenya","UCZRv5HgoZ9FDPdVPYyGBbDA":"Citizen TV Kenya"};
export async function fetchTier8YouTube(topic:string,_rk:string,ytKey?:string,max=10):Promise<any[]>{
  const core=extractCoreEntity(topic);const arts:any[]=[];
  if(ytKey){try{const p=new URLSearchParams({part:"snippet",q:`${core} news`,key:ytKey,type:"video",order:"date",maxResults:"10",publishedAfter:new Date(Date.now()-86400000).toISOString()});const r=await fw(`https://www.googleapis.com/youtube/v3/search?${p}`,3000);if(r.ok)(await r.json()).items?.forEach((i:any)=>{const s=i.snippet??{};arts.push({title:cleanT(s.title??""),url:`https://www.youtube.com/watch?v=${i.id?.videoId}`,description:cleanD(s.description??""),image:s.thumbnails?.medium?.url??null,publishedAt:s.publishedAt??new Date().toISOString(),source:{name:s.channelTitle??"YouTube"},tier:"youtube",reliability:3.5});});}catch(e:any){console.warn("YT API:",e.message);}}
  if(arts.length<3){const rss=await Promise.allSettled(Object.keys(YT_CH).slice(0,8).map(async id=>{const r=await fw(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,3000).catch(()=>null);if(!r?.ok)return[];return[...((await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/gi))].map(e=>{const x=e[1];return{title:cleanT(/<title>([\s\S]*?)<\/title>/i.exec(x)?.[1]??""),url:/<link[^>]+href="([^"]+)"/i.exec(x)?.[1]??"",description:cleanD(/<media:description>([\s\S]*?)<\/media:description>/i.exec(x)?.[1]??""),image:/<media:thumbnail[^>]+url="([^"]+)"/i.exec(x)?.[1]??null,publishedAt:/<published>([\s\S]*?)<\/published>/i.exec(x)?.[1]??"",source:{name:YT_CH[id]},tier:"youtube",reliability:3.5};}).filter((a:any)=>a.title.length>5&&a.url);}));arts.push(...rss.flatMap(r=>r.status==="fulfilled"?r.value:[]));}
  const d=filterAndRank(core,dedup(arts),0.10).slice(0,max);console.log(`✅ T8 YouTube: ${d.length}`);return d;
}

export async function fetchTier9NewsData(topic:string,regionKey:string,apiKey?:string,max=15):Promise<any[]>{
  if(!apiKey)return[];const core=extractCoreEntity(topic);
  try{
    const p=new URLSearchParams({apikey:apiKey,q:core,language:"en",size:String(max)});
    const cc=getCountryCode(regionKey);if(cc&&cc!=="us")p.append("country",cc);
    const r=await fw(`https://newsdata.io/api/1/news?${p}`,4000);if(!r.ok)return[];
    const d=filterAndRank(core,dedup(((await r.json()).results??[])
      .map((a:any)=>({
        title:cleanT(a.title??""),url:a.link??"",
        description:cleanD(a.description??a.content??""),
        image:a.image_url??null,publishedAt:a.pubDate??new Date().toISOString(),
        source:{name:a.source_id??"NewsData"},tier:"newsdata",reliability:3.8,
      }))
      .filter((a:any)=>a.title.length>5&&a.url)
    ),0.10).slice(0,max);
    console.log(`✅ T9 NewsData: ${d.length}`);return d;
  }catch(e:any){console.warn("T9 NewsData:",e.message);return[];}
}

// ════════════════════════════════════════════════════════════════════════════
// MASTER PIPELINE — with cascade + universal expansion
// ════════════════════════════════════════════════════════════════════════════
export async function fetchAllSources(
  topic:string,regionKey:string,queries:string[],
  opts:{
    gnewsKey?:string;newsapiKey?:string;currentsKey?:string;
    thenewsapiKey?:string;youtubeKey?:string;newsdataKey?:string;
  }={}
):Promise<{articles:any[];wiki:any|null;wikidata:any|null;sourceCounts:Record<string,number>;}>{
  const core=extractCoreEntity(topic);
  const isSport=/\b(match|game|vs|versus|score|football|cricket|soccer|nba|tennis|formula|rugby|hockey|baseball|golf|boxing|ufc|mma)\b/i.test(topic);
  console.log(`\n🌍 "${topic}" → "${core}" | Region: ${regionKey}`);

  const[t1,t2,wiki,wikidata,t6,t7,t8,t9,rssG,rssW,rssA,rssF,rssB,rssD,rssL,rssS]=await Promise.allSettled([
    fetchTier1NewsAPIs(queries,regionKey,opts.gnewsKey,opts.newsapiKey),
    fetchTier2WikipediaCurrentEvents(),
    fetchTier4WikipediaBackground(topic),
    fetchTier5Wikidata(topic),
    fetchTier6CurrentsAPI(topic,regionKey,opts.currentsKey),
    fetchTier7TheNewsAPI(topic,regionKey,opts.thenewsapiKey),
    fetchTier8YouTube(topic,regionKey,opts.youtubeKey),
    fetchTier9NewsData(topic,regionKey,opts.newsdataKey),
    rssGoogle(topic,regionKey),
    rssWikinews(topic,regionKey),
    rssAggregators(topic,regionKey),
    rssFeedly(topic),
    rssBridge(topic),
    rssGDELT(topic,regionKey),
    rssLive(topic,isSport),
    rssWebSearch(topic),
  ]);

  const get=(r:PromiseSettledResult<any>):any[]=>r.status==="fulfilled"&&Array.isArray(r.value)?r.value:[];
  const wikiResult    =wiki.status==="fulfilled"?wiki.value:null;
  const wikidataResult=wikidata.status==="fulfilled"?wikidata.value:null;

  const merged=dedup([
    ...get(t1),...get(t2),...get(t6),...get(t7),
    ...get(t8),...get(t9),
    ...get(rssG),...get(rssW),...get(rssA),
    ...get(rssF),...get(rssB),...get(rssD),
    ...get(rssL),...get(rssS),
  ]);

  let allArticles=filterAndRank(core,merged,0.08);

  // Universal cascade — fires only when parallel sources returned scarce results.
  // Climbs the geographic and language ladder to find relevant content for
  // any topic anywhere on earth — never falls back to unrelated news.
  if(allArticles.length<CASCADE_MIN){
    console.log(`⚠️ Only ${allArticles.length} results — triggering cascade...`);
    const cascadeResults=await cascadeSearch(topic,regionKey,allArticles.length);
    allArticles=filterAndRank(core,dedup([...allArticles,...cascadeResults]),0.06);
    console.log(`📊 After cascade: ${allArticles.length} total`);
  }

  const sourceCounts:Record<string,number>={};
  for(const a of allArticles)sourceCounts[a.tier??"unknown"]=(sourceCounts[a.tier??"unknown"]??0)+1;
  console.log(`\n📊`,sourceCounts,`\n📰 Total: ${allArticles.length}`);
  return{articles:allArticles,wiki:wikiResult,wikidata:wikidataResult,sourceCounts};
}

// ════════════════════════════════════════════════════════════════════════════
// SYNTHESISE
// ════════════════════════════════════════════════════════════════════════════
export function synthesizeWithGuaranteedCoverage(allArticles:any[],wiki:any,cleanTopic:string,_:string){
  const core=extractCoreEntity(cleanTopic);
  const real=dedup(allArticles.filter(a=>a.url&&a.url!=="#"&&a.tier!=="placeholder"))
    .filter(a=>Date.now()-new Date(a.publishedAt||0).getTime()<7*864e5)
    .sort((a,b)=>new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime());
  const top3=real.slice(0,3).map(a=>{const m=Math.floor((Date.now()-new Date(a.publishedAt||0).getTime())/60000);const ago=m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`;return`(${ago}) ${a.title}`;});
  const parts=[...(top3.length?[top3.join(" • ")]:[]),...(wiki?[`📚 **Background**: ${wiki.summary}`]:[]),...(real.length===0?[`ℹ️ No recent articles found for "${core}".`]:[]),...(real.length>0&&real.length<3?[`💡 Limited coverage — ${real.length} source(s) found.`]:[])];
  return{
    digest_summary:parts.join(" ")||`Searching for "${core}"...`,
    digest_source_urls:[...new Set([...real.slice(0,3).map((a:any)=>a.url),wiki?.url].filter(Boolean))],
    digest_reliability:rel(real.length),
    articles:real,
    coverage_tier:cov(real.length),
    total_found:real.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LLM DIGEST — GROQ (verified) + Gemini 2.0 Flash (unverified) — concurrent
// ════════════════════════════════════════════════════════════════════════════
const fmtArticles=(arts:any[],max=8)=>
  arts.slice(0,max).map((a,i)=>`${i+1}. [${a.source?.name??a.source??"Unknown"}] ${a.title}`).join("\n");

export async function generateVerifiedDigest(
  articles:any[], topic:string, groqKey:string
):Promise<string>{
  const fallback=()=>articles.slice(0,3).map(a=>a.title).join(" • ")||"No verified articles available.";
  if(!groqKey||!articles.length)return fallback();
  try{
    const res=await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${groqKey}`},
      body:JSON.stringify({
        model:"llama-3.1-8b-instant",
        max_tokens:400,temperature:0.2,
        messages:[{role:"user",content:
          `Summarise these blockchain-verified news articles about "${topic}" in 3–4 factual sentences. Name sources. End with: "Sources verified on-chain."\n\n${fmtArticles(articles)}`
        }],
      }),
      signal:AbortSignal.timeout(12000),
    });
    if(!res.ok)throw new Error(`GROQ ${res.status}`);
    const text=(await res.json()).choices?.[0]?.message?.content??"";
    console.log(`✅ GROQ verified digest: ${text.length} chars`);
    return text.trim()||fallback();
  }catch(e:any){console.warn("GROQ digest failed:",e.message);return fallback();}
}

export async function generateUnverifiedDigest(
  articles:any[], topic:string, geminiKey:string
):Promise<string>{
  const fallback=()=>articles.slice(0,3).map(a=>a.title).join(" • ")||"No additional articles available.";
  if(!geminiKey||!articles.length)return fallback();
  try{
    const res=await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          contents:[{parts:[{text:
            `Summarise these news articles about "${topic}" in 3–4 factual sentences. Name sources. End with: "Sources not blockchain-verified."\n\n${fmtArticles(articles)}`
          }]}],
          generationConfig:{maxOutputTokens:400,temperature:0.2},
        }),
        signal:AbortSignal.timeout(12000),
      }
    );
    if(!res.ok)throw new Error(`Gemini ${res.status}`);
    const text=(await res.json()).candidates?.[0]?.content?.parts?.[0]?.text??"";
    console.log(`✅ Gemini unverified digest: ${text.length} chars`);
    return text.trim()||fallback();
  }catch(e:any){console.warn("Gemini digest failed:",e.message);return fallback();}
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════
export const upsertDigestToSupabase=(
  url:string,key:string,topic:string,region:string,
  verified_digest:string,unverified_digest:string,
  digest_reliability:number|null,source_article_urls:string[]
)=>
  fetch(`${url}/rest/v1/news_digests?on_conflict=topic,region`,{
    method:"POST",
    headers:{...sbH(key),"Prefer":"return=representation,resolution=merge-duplicates"},
    body:JSON.stringify([{
      topic,region,
      digest_summary:`✅ VERIFIED:\n${verified_digest}\n\n⚠️ UNVERIFIED:\n${unverified_digest}`,
      verified_digest,
      unverified_digest,
      digest_reliability:digest_reliability??null,
      source_article_urls,
      created_at:new Date().toISOString(),
    }]),
  }).catch(()=>{});

export async function insertArticlesToSupabase(
  url:string,key:string,articles:any[],topic:string,region:string,contractAddress:string|null
){
  if(!articles.length)return;
  const withVectors=attachVectors(articles);
  const rows=await Promise.all(withVectors.map(async a=>({
    url:a.url,title:a.title,description:a.description||a.summary||"",content:null,
    image:a.image??null,source:a.source?.name??a.source??"Unknown",
    published_at:a.publishedAt??new Date().toISOString(),
    published_ms:a.published_ms||new Date(a.publishedAt||0).getTime(),
    topic,region,category:a.category??null,
    freshness_label:fresh(a.publishedAt),
    cluster_tag:a.tier??"general",
    relevance_score:a.relevance_score??0.85,
    embedding:a.embedding??null,
    ai_summary:null,ai_reliability:null,
    content_hash:a.description?"0x"+await hashArticle(a.description):null,
    tx_hash:a.blockchain_verification?.tx_hash??null,
    is_verified:a.blockchain_verification?.registered??false,
    publisher_address:null,
    blockchain_registered_at:a.blockchain_verification?.registered_at??null,
    contract_address:contractAddress,
    created_at:new Date().toISOString(),
  })));
  await fetch(`${url}/rest/v1/news?on_conflict=url`,{
    method:"POST",
    headers:{...sbH(key),"Prefer":"resolution=merge-duplicates"},
    body:JSON.stringify(rows),
  }).catch(e=>console.error("Insert failed:",e));
}