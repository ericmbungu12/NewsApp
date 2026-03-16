// supabase/functions/fetch-news/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONTRACT_ADDRESS, checkBatchOnChain, registerBatchOnChain, getNetworkType, hashArticle } from "./blockchain.ts";
import { normalizeRegion, getRegionKey } from "./region.ts";
import { CACHE_DURATION_MS, normalizeForDisplay, normalizeForSearch, expandQueryForCoverage, detectIntent, detectEntityType, fetchAllSources, synthesizeWithGuaranteedCoverage, upsertDigestToSupabase, insertArticlesToSupabase } from "./news_tier.ts";
import { extractCoreEntity, embedText, toVectorString } from "./fuzzy_search.ts";

// ── In-memory cache + anon rate limit ────────────────────────────────────────
const cache    = new Map<string,{expiry:number;data:unknown}>();
const anonHits = new Map<string,number>();
const getIP    = (req:Request)=>req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()??req.headers.get("x-real-ip")??"unknown";
const cached   = (k:string)=>{const e=cache.get(k);return e&&e.expiry>Date.now()?e.data:null;};
const setCache = (k:string,d:unknown)=>cache.set(k,{expiry:Date.now()+CACHE_DURATION_MS,data:d});
const freshLbl = (iso:string)=>{const ms=Date.now()-new Date(iso||0).getTime();return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older";};
const NO_BV    = (x={})=>({status:"not_registered",registered:false,verified:false,publisher:null,registered_at:null,contract_address:CONTRACT_ADDRESS??null,tx_hash:null,badge:"❌ Unverified",...x});
const sbPatch  = async(url:string,key:string,path:string,body:unknown,label="Update")=>{
  try{const r=await fetch(`${url}/rest/v1/${path}`,{method:"PATCH",headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok){console.error(`❌ ${label}: ${r.status}`);return{success:false};}console.log(`✅ ${label}`);return{success:true};}
  catch(e:any){console.error(`❌ ${label}: ${e.message}`);return{success:false};}
};
const dedup = (a:any[])=>{const s=new Set<string>();return a.filter(x=>{if(!x.url||s.has(x.url))return false;s.add(x.url);return true;});};

// ── Vector search — pgvector semantic similarity ──────────────────────────────
async function vectorSearchNews(topic:string,sbUrl:string,sbKey:string,limit=20):Promise<any[]>{
  try{
    const vector=toVectorString(embedText(topic));
    const r=await fetch(`${sbUrl}/rest/v1/rpc/search_news_by_vector`,{method:"POST",headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json"},body:JSON.stringify({query_embedding:vector,match_threshold:0.4,match_count:limit})});
    if(!r.ok){console.warn("Vector search failed:",r.status);return[];}
    const results=await r.json();
    console.log(`✅ Vector search: ${results.length} similar articles from DB`);
    return results.map((a:any)=>({...a,tier:"vector_search",publishedAt:a.published_at}));
  }catch(e:any){console.warn("Vector search error:",e.message);return[];}
}

async function vectorSearchDigests(topic:string,sbUrl:string,sbKey:string,limit=5):Promise<any[]>{
  try{
    const vector=toVectorString(embedText(topic));
    const r=await fetch(`${sbUrl}/rest/v1/rpc/search_digests_by_vector`,{method:"POST",headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json"},body:JSON.stringify({query_embedding:vector,match_threshold:0.4,match_count:limit})});
    if(!r.ok)return[];
    const results=await r.json();
    console.log(`✅ Vector digest search: ${results.length} past digests`);
    return results;
  }catch(e:any){console.warn("Digest vector search error:",e.message);return[];}
}

// ── RL Engine ─────────────────────────────────────────────────────────────────
async function rankWithRL(articles:any[],query:string,twin:any|null):Promise<any[]>{
  try{
    const r=await fetch("https://newsapp-63t4.onrender.com/rank",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        articles:articles.map(a=>({url:a.url,title:a.title,description:a.description||"",source:a.source||"",topic:a.cluster_tag||"",cluster_tag:a.cluster_tag||"",published_at:a.published_at||"",freshness_label:a.freshness_label||""})),
        twin:twin?{topic_preferences:twin.topic_preferences||{},source_preferences:twin.source_preferences||{},total_clicks:twin.total_clicks||0,total_views:twin.total_views||0,total_skips:twin.total_skips||0,total_thumbs_up:twin.total_thumbs_up||0,total_thumbs_down:twin.total_thumbs_down||0,avg_view_time:twin.avg_view_time||0.0}:null,
        query,
      }),
      signal:AbortSignal.timeout(8000),
    });
    if(!r.ok){console.warn("RL error:",r.status);return articles;}
    const data=await r.json();
    console.log(`🤖 RL ranked ${data.total} (personalized:${data.personalized})`);
    return data.ranked_articles.map((ra:any)=>({...(articles.find(a=>a.url===ra.article.url)??ra.article),personalization_score:ra.personalization_score,why_recommended:ra.why}));
  }catch(e:any){console.warn("RL unavailable:",e.message);return articles;}
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async(req:Request)=>{
  const ENV={
    gnews:      Deno.env.get("GNEWS_API_KEY"),
    newsapi:    Deno.env.get("NEWSAPI_KEY"),
    currents:   Deno.env.get("CURRENTS_API_KEY"),
    thenewsapi: Deno.env.get("THENEWSAPI_KEY"),
    youtube:    Deno.env.get("YOUTUBE_API_KEY"),
    sbUrl:      Deno.env.get("SUPABASE_URL")!,
    sbKey:      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    sbAnon:     Deno.env.get("SUPABASE_ANON_KEY")!,
  };
  if(!ENV.sbUrl||!ENV.sbKey)return new Response(JSON.stringify({error:"Missing Supabase env"}),{status:500});

  try{
    // ── Auth + rate limit ─────────────────────────────────────────────────
    const ip=getIP(req);
    const authHeader=req.headers.get("Authorization");
    const isLoggedIn=!!authHeader?.match(/^Bearer .{33,}/);
    if(!isLoggedIn){
      if((anonHits.get(ip)??0)>=1)return new Response(JSON.stringify({error:"Login required",success:false,articles:[]}),{status:402});
      anonHits.set(ip,(anonHits.get(ip)??0)+1);
      setTimeout(()=>{if((anonHits.get(ip)??0)<=1)anonHits.delete(ip);},36e5);
    }

    // ── Load digital twin ─────────────────────────────────────────────────
    let userTwin=null;
    if(isLoggedIn&&authHeader){
      try{
        const uc=createClient(ENV.sbUrl,ENV.sbAnon,{global:{headers:{Authorization:authHeader}}});
        const{data:{user}}=await uc.auth.getUser();
        if(user){
          const{data:twin}=await uc.from("digital_twins").select("*").eq("user_id",user.id).single();
          if(twin){userTwin=twin;console.log(`🧠 Twin: ${user.id}`);}
        }
      }catch(e:any){console.warn("Twin failed:",e.message);}
    }

    // ── Parse request ─────────────────────────────────────────────────────
    const{topic="latest news",region="global"}=await req.json();
    const rawTopic    =topic.toString().trim();
    const regionKey   =getRegionKey(normalizeRegion(region.toString()));
    const displayTopic=normalizeForDisplay(rawTopic);
    const searchQuery =normalizeForSearch(rawTopic);
    const core        =extractCoreEntity(rawTopic);  // ← from fuzzy_search.ts ✅
    const intent      =detectIntent(rawTopic);
    const entityType  =detectEntityType(rawTopic,rawTopic);
    const queries     =expandQueryForCoverage(rawTopic,regionKey,entityType);
    console.log(`🔍 "${rawTopic}" → "${core}" | region=${regionKey} | intent=${intent}`);

    // ── Cache check ───────────────────────────────────────────────────────
    const cacheKey=`digest_${displayTopic}_${regionKey}`;
    if(cached(cacheKey))console.log(`⚡ Cache hit: ${cacheKey}`);

    // ── Fresh fetch + vector DB search simultaneously ─────────────────────
    const[freshResult,vectorArticles,similarDigests]=await Promise.all([
      fetchAllSources(searchQuery,regionKey,queries,{gnewsKey:ENV.gnews??undefined,newsapiKey:ENV.newsapi??undefined,currentsKey:ENV.currents??undefined,thenewsapiKey:ENV.thenewsapi??undefined,youtubeKey:ENV.youtube??undefined}),
      vectorSearchNews(core,ENV.sbUrl,ENV.sbKey,20),
      vectorSearchDigests(core,ENV.sbUrl,ENV.sbKey,5),
    ]);

    const{wiki,wikidata,sourceCounts}=freshResult;

    // ── Merge fresh + vector results ──────────────────────────────────────
    const mergedArticles=dedup([...freshResult.articles,...vectorArticles]);
    console.log(`📊 Fresh:${freshResult.articles.length} Vector:${vectorArticles.length} Merged:${mergedArticles.length}`);

    // ── Synthesise — real articles only ───────────────────────────────────
    const{digest_summary,digest_source_urls,digest_reliability,articles:finalArticles,coverage_tier}=
      synthesizeWithGuaranteedCoverage(mergedArticles,wiki,displayTopic,entityType);

    // ── Persist to Supabase with vector embeddings ────────────────────────
    upsertDigestToSupabase(ENV.sbUrl,ENV.sbKey,rawTopic,regionKey,digest_summary,digest_reliability,digest_source_urls).catch(()=>{});
    await insertArticlesToSupabase(ENV.sbUrl,ENV.sbKey,finalArticles,rawTopic,regionKey,CONTRACT_ADDRESS??null);

    // ── RL rank FIRST — best articles get blockchain priority ─────────────
    const preRanked=await rankWithRL(
      finalArticles.map(a=>({...a,source:a.source?.name??a.source??"Unknown",freshness_label:freshLbl(a.publishedAt),cluster_tag:a.tier??"general"})),
      displayTopic,userTwin
    );

    // ── Register ALL articles on blockchain ───────────────────────────────
    const toRegister=preRanked.filter(a=>a.description?.trim()).map(a=>({content:a.description,url:a.url}));
    console.log(`🔗 Registering ${toRegister.length} articles on-chain...`);
    const batchResults=await registerBatchOnChain(toRegister,300);
    const txMap=new Map(batchResults.map(r=>[r.url,r]));

    // Persist tx_hashes to Supabase
    await Promise.all(batchResults.filter(r=>r.txHash).map(r=>
      sbPatch(ENV.sbUrl,ENV.sbKey,`news?url=eq.${encodeURIComponent(r.url)}`,{tx_hash:r.txHash,is_verified:true,blockchain_registered_at:new Date().toISOString()},`tx ${r.url}`)
    ));

    // Batch verify all registered articles
    const registeredArts=preRanked.filter(a=>a.description?.trim());
    const batchChecks=await checkBatchOnChain(registeredArts.map(a=>({content:a.description,cachedHash:null})));
    const checkMap=new Map(registeredArts.map((a,i)=>[a.url,batchChecks[i]]));

    // ── Build final articles with blockchain verification ─────────────────
    const articles=await Promise.all(preRanked.map(async a=>{
      const reg=txMap.get(a.url);
      const chk=checkMap.get(a.url);
      let txHash=reg?.txHash??null;
      if(reg?.alreadyRegistered&&!txHash){
        try{
          const r=await fetch(`${ENV.sbUrl}/rest/v1/news?url=eq.${encodeURIComponent(a.url)}&select=tx_hash`,{headers:{apikey:ENV.sbKey,Authorization:`Bearer ${ENV.sbKey}`}});
          const rows=await r.json();if(rows?.[0]?.tx_hash)txHash=rows[0].tx_hash;
        }catch{}
      }
      const isRegistered=!!(txHash||reg?.alreadyRegistered);
      return{
        title:                a.title,
        description:          a.description??a.summary??"",
        url:                  a.url,
        image:                a.image??null,
        source:               a.source?.name??a.source??"Unknown",
        published_at:         a.publishedAt??a.published_at??new Date().toISOString(),
        freshness_label:      freshLbl(a.publishedAt??a.published_at),
        cluster_tag:          a.tier??"general",
        relevance_score:      a.relevance_score??0.85,
        similarity_score:     a.similarity??null,
        personalization_score:a.personalization_score??null,
        why_recommended:      a.why_recommended??null,
        tier:                 a.tier??"general",
        blockchain_verification:isRegistered?{
          status:"registered",registered:true,
          verified:chk?.verified??true,
          publisher:chk?.publisher??null,
          registered_at:chk?.timestamp??new Date().toISOString(),
          contract_address:CONTRACT_ADDRESS??null,
          tx_hash:txHash,
          badge:"✅ Verified on-chain",
          content_hash:a.description?"0x"+await hashArticle(a.description):null,
        }:NO_BV(),
      };
    }));

    // Cache after blockchain so tx_hashes included
    if(articles.length>0)setCache(cacheKey,{digest_summary,digest_source_urls,digest_reliability,coverage_tier});

    // ── Response ──────────────────────────────────────────────────────────
    return new Response(JSON.stringify({
      success:true,
      search:{original:rawTopic,core_entity:core,normalized_for_display:displayTopic,normalized_for_search:searchQuery,query_expansions:queries,region:regionKey,intent,entityType,coverage_tier},
      digest:{summary:digest_summary,reliability:digest_reliability,source_count:digest_source_urls.length,source_urls:digest_source_urls,coverage_quality:coverage_tier,wikipedia_background:wiki??null,wikidata_context:wikidata??null,similar_past_digests:similarDigests},
      articles,
      blockchain:{enabled:!!CONTRACT_ADDRESS,contract_address:CONTRACT_ADDRESS??null,network:getNetworkType(),verified_count:articles.filter(a=>a.blockchain_verification?.registered).length,total_articles:articles.length,coverage:"all"},
      meta:{source_breakdown:sourceCounts,total_fresh:freshResult.articles.length,total_from_vector_db:vectorArticles.length,total_merged:mergedArticles.length,total_after_synthesis:finalArticles.length,blockchain_registered:batchResults.filter(r=>r.success).length,auth_status:isLoggedIn?"logged_in":"anonymous",searches_remaining:isLoggedIn?"unlimited":0,timestamp:new Date().toISOString()},
    },null,2),{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=300"}});

  }catch(err:any){
    console.error("🔥",err);
    return new Response(JSON.stringify({
      success:false,error:"Service error",message:"Failed to fetch news. Please try again shortly.",articles:[],
      digest:{summary:"Unable to fetch news at this time. Please try again.",reliability:0,source_count:0,source_urls:[],coverage_quality:"error"},
      blockchain:{enabled:!!CONTRACT_ADDRESS,contract_address:CONTRACT_ADDRESS??null,network:getNetworkType()},
      meta:{timestamp:new Date().toISOString()},
    }),{status:500,headers:{"Content-Type":"application/json"}});
  }
});