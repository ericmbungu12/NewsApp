// supabase/functions/fetch-news/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONTRACT_ADDRESS, checkBatchOnChain, registerBatchOnChain, getNetworkType, hashArticle } from "./blockchain.ts";
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
const cache    = new Map<string,{expiry:number;data:unknown}>();
const anonHits = new Map<string,number>();
const BLOCKCHAIN_LIMIT = 20;

const getIP    = (req:Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
const cached   = (k:string) => { const e=cache.get(k); return e&&e.expiry>Date.now()?e.data:null; };
const setCache = (k:string,d:unknown) => cache.set(k,{expiry:Date.now()+CACHE_DURATION_MS,data:d});
const freshLbl = (iso:string) => { const ms=Date.now()-new Date(iso||0).getTime(); return ms<3.6e6?"breaking":ms<864e5?"today":ms<6048e5?"this_week":"older"; };
const NO_BV    = (x={}) => ({status:"not_registered",registered:false,verified:false,publisher:null,registered_at:null,contract_address:CONTRACT_ADDRESS??null,tx_hash:null,badge:"❌ Unverified",...x});
const dedup    = (a:any[]) => { const s=new Set<string>(); return a.filter(x=>{ if(!x.url||s.has(x.url))return false; s.add(x.url); return true; }); };

// Fire-and-forget patch — never blocks response
const sbPatch = (url:string,key:string,path:string,body:unknown) =>
  fetch(`${url}/rest/v1/${path}`,{
    method:"PATCH",
    headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(5000),
  }).catch(e=>console.warn(`sbPatch ${path}: ${e.message}`));

// ── Vector search helpers ─────────────────────────────────────────────────────
async function vectorSearchNews(topic:string,sbUrl:string,sbKey:string,limit=20):Promise<any[]>{
  try{
    const vector=toVectorString(embedText(topic));
    const r=await fetch(`${sbUrl}/rest/v1/rpc/search_news_by_vector`,{
      method:"POST",
      headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({query_embedding:vector,match_threshold:0.4,match_count:limit}),
      signal:AbortSignal.timeout(3000),
    });
    if(!r.ok) return [];
    const results=await r.json();
    console.log(`✅ Vector search: ${results.length}`);
    return results.map((a:any)=>({...a,tier:"vector_search",publishedAt:a.published_at}));
  }catch(e:any){ console.warn("Vector search:",e.message); return []; }
}

async function vectorSearchDigests(topic:string,sbUrl:string,sbKey:string,limit=5):Promise<any[]>{
  try{
    const vector=toVectorString(embedText(topic));
    const r=await fetch(`${sbUrl}/rest/v1/rpc/search_digests_by_vector`,{
      method:"POST",
      headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({query_embedding:vector,match_threshold:0.4,match_count:limit}),
      signal:AbortSignal.timeout(3000),
    });
    if(!r.ok) return [];
    return await r.json();
  }catch(e:any){ console.warn("Digest vector search:",e.message); return []; }
}

// ── RL Engine ─────────────────────────────────────────────────────────────────
async function rankWithRL(articles:any[],query:string,twin:any|null):Promise<any[]>{
  try{
    const r=await fetch("https://newsapp-63t4.onrender.com/rank",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        articles:articles.map(a=>({
          url:a.url, title:a.title, description:a.description||"",
          source:a.source||"", topic:a.cluster_tag||"",
          cluster_tag:a.cluster_tag||"", published_at:a.published_at||"",
          freshness_label:a.freshness_label||"",
          relevance_score:a.relevance_score??0.5,
          blockchain_verification:a.blockchain_verification??null,
        })),
        twin:twin?{
          topic_preferences:twin.topic_preferences||{},
          source_preferences:twin.source_preferences||{},
          total_clicks:twin.total_clicks||0,
          total_views:twin.total_views||0,
          total_skips:twin.total_skips||0,
          total_thumbs_up:twin.total_thumbs_up||0,
          total_thumbs_down:twin.total_thumbs_down||0,
          avg_view_time:twin.avg_view_time||0.0,
        }:null,
        query,
      }),
      signal:AbortSignal.timeout(30000),
    });
    if(!r.ok){ console.warn("RL error:",r.status); return articles; }
    const data=await r.json();
    console.log(`🤖 RL ranked ${data.total} | personalized=${data.personalized} | verified_in_top=${data.verified_in_top??0}`);
    return data.ranked_articles.map((ra:any)=>({
      ...(articles.find(a=>a.url===ra.article.url)??ra.article),
      personalization_score:ra.personalization_score,
      why_recommended:ra.why,
    }));
  }catch(e:any){ console.warn("RL unavailable:",e.message); return articles; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async(req:Request)=>{
  const ENV={
    groq:       Deno.env.get("GROQ_API_KEY"),
    gemini:     Deno.env.get("GEMINI_API_KEY"),
    gnews:      Deno.env.get("GNEWS_API_KEY"),
    newsapi:    Deno.env.get("NEWSAPI_KEY"),
    currents:   Deno.env.get("CURRENTS_API_KEY"),
    thenewsapi: Deno.env.get("THENEWSAPI_KEY"),
    youtube:    Deno.env.get("YOUTUBE_API_KEY"),
    sbUrl:      Deno.env.get("SUPABASE_URL")!,
    sbKey:      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    sbAnon:     Deno.env.get("SUPABASE_ANON_KEY")!,
  };

  if(!ENV.sbUrl||!ENV.sbKey)
    return new Response(JSON.stringify({error:"Missing Supabase env"}),{status:500});

  try{
    // ── Auth + rate limit ──────────────────────────────────────────────────
    const ip=getIP(req);
    const authHeader=req.headers.get("Authorization");
    const isLoggedIn=!!authHeader?.match(/^Bearer .{33,}/);
    if(!isLoggedIn){
      if((anonHits.get(ip)??0)>=1)
        return new Response(JSON.stringify({error:"Login required",success:false,articles:[]}),{status:402});
      anonHits.set(ip,(anonHits.get(ip)??0)+1);
      setTimeout(()=>{ if((anonHits.get(ip)??0)<=1) anonHits.delete(ip); },36e5);
    }

    // ── Parse request ──────────────────────────────────────────────────────
    const{topic="latest news",region="global"}=await req.json();
    const rawTopic    =topic.toString().trim();
    const regionKey   =getRegionKey(normalizeRegion(region.toString()));
    const displayTopic=normalizeForDisplay(rawTopic);
    const searchQuery =normalizeForSearch(rawTopic);
    const core        =extractCoreEntity(rawTopic);
    const intent      =detectIntent(rawTopic);
    const entityType  =detectEntityType(rawTopic,rawTopic);
    const queries     =expandQueryForCoverage(rawTopic,regionKey,entityType);
    const cacheKey    =`digest_${displayTopic}_${regionKey}`;
    console.log(`🔍 "${rawTopic}" → "${core}" | region=${regionKey} | intent=${intent}`);

    // ── Load digital twin (non-blocking on failure) ────────────────────────
    let userTwin:any=null;
    if(isLoggedIn&&authHeader){
      try{
        const uc=createClient(ENV.sbUrl,ENV.sbAnon,{global:{headers:{Authorization:authHeader}}});
        const{data:{user}}=await uc.auth.getUser();
        if(user){
          const{data:twin}=await uc.from("digital_twins").select("*").eq("user_id",user.id).single();
          if(twin){ userTwin=twin; console.log(`🧠 Twin loaded`); }
        }
      }catch(e:any){ console.warn("Twin failed:",e.message); }
    }

    // ── PHASE 1: Sources + vector DB — all in parallel ─────────────────────
    const[freshResult,vectorArticles,similarDigests]=await Promise.all([
      fetchAllSources(searchQuery,regionKey,queries,{
        gnewsKey:ENV.gnews??undefined, newsapiKey:ENV.newsapi??undefined,
        currentsKey:ENV.currents??undefined, thenewsapiKey:ENV.thenewsapi??undefined,
        youtubeKey:ENV.youtube??undefined,
      }),
      vectorSearchNews(core,ENV.sbUrl,ENV.sbKey,20),
      vectorSearchDigests(core,ENV.sbUrl,ENV.sbKey,5),
    ]);

    const{wiki,wikidata,sourceCounts}=freshResult;

    // ── PHASE 2: Merge + synthesize ────────────────────────────────────────
    const mergedArticles=dedup([...freshResult.articles,...vectorArticles]);
    console.log(`📊 Fresh:${freshResult.articles.length} Vector:${vectorArticles.length} Merged:${mergedArticles.length}`);

    const{digest_source_urls,digest_reliability,articles:finalArticles,coverage_tier}=
      synthesizeWithGuaranteedCoverage(mergedArticles,wiki,displayTopic,entityType);

    // ── PHASE 3: RL rank ───────────────────────────────────────────────────
    const rlInput=finalArticles.map(a=>({
      ...a,
      source:a.source?.name??a.source??"Unknown",
      freshness_label:freshLbl(a.publishedAt),
      cluster_tag:a.tier??"general",
      relevance_score:a.relevance_score??0.5,
    }));
    const allRanked=await rankWithRL(rlInput,displayTopic,userTwin);

    // ── PHASE 4: Slice — top 20 for blockchain, rest unverified ───────────
    const top20  =allRanked.slice(0,BLOCKCHAIN_LIMIT).filter(a=>a.description?.trim());
    const theRest=allRanked.slice(BLOCKCHAIN_LIMIT);
    console.log(`🔗 Blockchain: ${top20.length} | Unverified: ${theRest.length}`);

    // ── PHASE 5: CONCURRENT — blockchain + GROQ + Gemini ──────────────────
    // All three start at exactly the same time. Response waits for all three.
    const[batchResults,verified_digest,unverified_digest]=await Promise.all([
      // Alchemy EVM — only top 20
      registerBatchOnChain(top20.map(a=>({content:a.description,url:a.url})),200),
      // GROQ llama-3.1-8b-instant — verified section
      generateVerifiedDigest(top20,displayTopic,ENV.groq??""),
      // Gemini 1.5 Flash — unverified section
      generateUnverifiedDigest(theRest,displayTopic,ENV.gemini??""),
    ]);

    const txMap=new Map(batchResults.map(r=>[r.url,r]));

    // Persist tx_hashes — fire and forget, never blocks response
    batchResults.filter(r=>r.txHash).forEach(r=>
      sbPatch(ENV.sbUrl,ENV.sbKey,
        `news?url=eq.${encodeURIComponent(r.url)}`,
        {tx_hash:r.txHash,is_verified:true,blockchain_registered_at:new Date().toISOString()}
      )
    );

    // Batch verify top-20
    const batchChecks=await checkBatchOnChain(top20.map(a=>({content:a.description,cachedHash:null})));
    const checkMap=new Map(top20.map((a,i)=>[a.url,batchChecks[i]]));

    // ── PHASE 6: Build article objects — top20 + rest in parallel ─────────
    const buildArticle=async(a:any,inTop20:boolean)=>{
      const reg=txMap.get(a.url);
      const chk=checkMap.get(a.url);
      let txHash=reg?.txHash??null;
      if(inTop20&&reg?.alreadyRegistered&&!txHash){
        try{
          const r=await fetch(
            `${ENV.sbUrl}/rest/v1/news?url=eq.${encodeURIComponent(a.url)}&select=tx_hash`,
            {headers:{apikey:ENV.sbKey,Authorization:`Bearer ${ENV.sbKey}`},signal:AbortSignal.timeout(2000)}
          );
          const rows=await r.json();
          if(rows?.[0]?.tx_hash) txHash=rows[0].tx_hash;
        }catch{}
      }
      const isRegistered=inTop20&&!!(txHash||reg?.alreadyRegistered);
      return{
        title:               a.title,
        description:         a.description??a.summary??"",
        url:                 a.url,
        image:               a.image??null,
        source:              a.source?.name??a.source??"Unknown",
        published_at:        a.publishedAt??a.published_at??new Date().toISOString(),
        freshness_label:     freshLbl(a.publishedAt??a.published_at),
        cluster_tag:         a.tier??"general",
        relevance_score:     a.relevance_score??0.85,
        personalization_score:a.personalization_score??null,
        why_recommended:     a.why_recommended??null,
        tier:                a.tier??"general",
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
    };

    // Both lists build in parallel
    const[verifiedArticleObjs,unverifiedArticleObjs]=await Promise.all([
      Promise.all(top20.map(a=>buildArticle(a,true))),
      Promise.all(theRest.map(a=>buildArticle(a,false))),
    ]);

    const confirmedVerified=verifiedArticleObjs.filter(a=>a.blockchain_verification.registered);
    const failedVerified   =verifiedArticleObjs.filter(a=>!a.blockchain_verification.registered);
    const allUnverified    =[...failedVerified,...unverifiedArticleObjs];
    const articles         =[...confirmedVerified,...allUnverified]; // verified first

    // ── PHASE 7: Persist — ALL fire-and-forget, never blocks response ──────
    upsertDigestToSupabase(
      ENV.sbUrl,ENV.sbKey,rawTopic,regionKey,
      verified_digest,unverified_digest,
      digest_reliability,digest_source_urls
    ).catch(()=>{});

    // Verified batch first (order matters for DB reads)
    insertArticlesToSupabase(
      ENV.sbUrl,ENV.sbKey,
      confirmedVerified.map(a=>({...a,publishedAt:a.published_at})),
      rawTopic,regionKey,CONTRACT_ADDRESS??null
    ).catch(()=>{});

    insertArticlesToSupabase(
      ENV.sbUrl,ENV.sbKey,
      allUnverified.map(a=>({...a,publishedAt:a.published_at})),
      rawTopic,regionKey,null
    ).catch(()=>{});

    setCache(cacheKey,{verified_digest,unverified_digest,digest_reliability,coverage_tier});

    // ── PHASE 8: Respond immediately ──────────────────────────────────────
    return new Response(JSON.stringify({
      success:true,
      search:{
        original:rawTopic,core_entity:core,normalized_for_display:displayTopic,
        normalized_for_search:searchQuery,query_expansions:queries,
        region:regionKey,intent,entityType,coverage_tier,
      },
      digest:{
        verified_digest,
        unverified_digest,
        summary:`✅ VERIFIED:\n${verified_digest}\n\n⚠️ UNVERIFIED:\n${unverified_digest}`,
        reliability:digest_reliability,
        source_count:digest_source_urls.length,
        source_urls:digest_source_urls,
        coverage_quality:coverage_tier,
        wikipedia_background:wiki??null,
        wikidata_context:wikidata??null,
        similar_past_digests:similarDigests,
      },
      articles,
      blockchain:{
        enabled:!!CONTRACT_ADDRESS,
        contract_address:CONTRACT_ADDRESS??null,
        network:getNetworkType(),
        verified_count:confirmedVerified.length,
        unverified_count:allUnverified.length,
        total_articles:articles.length,
        coverage:`top_${BLOCKCHAIN_LIMIT}_only`,
      },
      meta:{
        source_breakdown:sourceCounts,
        total_fresh:freshResult.articles.length,
        total_from_vector_db:vectorArticles.length,
        total_merged:mergedArticles.length,
        total_after_synthesis:finalArticles.length,
        blockchain_registered:batchResults.filter(r=>r.success).length,
        auth_status:isLoggedIn?"logged_in":"anonymous",
        searches_remaining:isLoggedIn?"unlimited":0,
        timestamp:new Date().toISOString(),
      },
    },null,2),{
      headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=300"},
    });

  }catch(err:any){
    console.error("🔥",err);
    return new Response(JSON.stringify({
      success:false,error:"Service error",
      message:"Failed to fetch news. Please try again shortly.",
      articles:[],
      digest:{summary:"Unable to fetch news.",reliability:0,source_count:0,source_urls:[],coverage_quality:"error"},
      blockchain:{enabled:!!CONTRACT_ADDRESS,contract_address:CONTRACT_ADDRESS??null,network:getNetworkType()},
      meta:{timestamp:new Date().toISOString()},
    }),{status:500,headers:{"Content-Type":"application/json"}});
  }
});