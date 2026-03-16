// supabase/functions/fetch-news/fuzzy_search.ts
// ─────────────────────────────────────────────────────────────────────────────
// Universal fuzzy matching + vector embedding for news search.
// Works for ANY language, ANY place on earth. Zero external dependencies.
// Designed for minimal latency in Deno edge runtime.
// Imported by rss_dynamic.ts and news_tier.ts — all search logic lives here.
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// NORMALISATION — universal, all languages/scripts
// ════════════════════════════════════════════════════════════════════════════
export const normalize=(s:string):string=>
  s.toLowerCase()
   .normalize("NFKD")                    // decompose ligatures + accents universally
   .replace(/[\u0300-\u036f]/g,"")       // strip combining diacritics (é→e, ñ→n, ü→u)
   .replace(/[\u0600-\u06ff]+/g,t=>t)   // preserve Arabic script as-is
   .replace(/[\u0900-\u097f]+/g,t=>t)   // preserve Devanagari as-is
   .replace(/[\u4e00-\u9fff]+/g,t=>t)   // preserve CJK as-is
   .replace(/[^\w\s\u0600-\u06ff\u0900-\u097f\u4e00-\u9fff]/g," ")
   .replace(/\s+/g," ").trim();

// ════════════════════════════════════════════════════════════════════════════
// STOPWORDS — universal, multi-language common words to ignore
// ════════════════════════════════════════════════════════════════════════════
const SW=new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","might","can","this","that","these","those","it","its","i","you","he","she","we","they","what","which","who","when","where","why","how","all","any","more","most","other","some","no","not","only","so","than","too","very","just","about","into","out","up","down","over","under","again","here","there","news","latest","breaking","today","now","update","updates","happening","going","current","recent","live","live","right","just","currently","get","got","said","says","new","old","big","small","good","bad","first","last","next","back","after","before","during","while","still","even","also","well","much","many","own","same","such","then","than","both","each","few","between","through","after","above","below","against","along","among","around","near","off","out","over","past","per","since","than","toward","under","until","up","upon","within","without"]);

// ════════════════════════════════════════════════════════════════════════════
// TOKENIZER — splits text into meaningful tokens, removes stopwords
// ════════════════════════════════════════════════════════════════════════════
export const tokenize=(text:string):string[]=>{
  const n=normalize(text);
  // Handle CJK — each character is a token
  const cjk=[...n.matchAll(/[\u4e00-\u9fff\u0600-\u06ff\u0900-\u097f]/g)].map(m=>m[0]);
  // Latin/other — split by space, filter stopwords
  const latin=n.split(/\s+/).filter(w=>w.length>1&&!SW.has(w));
  return[...new Set([...latin,...cjk])];
};

// ════════════════════════════════════════════════════════════════════════════
// LEVENSHTEIN — edit distance (handles typos, spelling variants)
// Optimized: single-row DP, O(min(m,n)) space
// ════════════════════════════════════════════════════════════════════════════
export function levenshtein(a:string,b:string):number{
  if(a===b)return 0;
  if(!a.length)return b.length;
  if(!b.length)return a.length;
  if(a.length>b.length)[a,b]=[b,a];      // a is always shorter
  let prev=[...Array(a.length+1).keys()];
  for(let j=1;j<=b.length;j++){
    const curr=[j];
    for(let i=1;i<=a.length;i++)
      curr[i]=a[i-1]===b[j-1]?prev[i-1]:1+Math.min(prev[i],curr[i-1],prev[i-1]);
    prev=curr;
  }
  return prev[a.length];
}

// ════════════════════════════════════════════════════════════════════════════
// JARO-WINKLER — better for short names/places, prefix-aware
// "Tezpur" vs "Tezpure" → 0.97 | "Lagos" vs "Lagoss" → 0.95
// ════════════════════════════════════════════════════════════════════════════
export function jaroWinkler(s1:string,s2:string):number{
  const a=normalize(s1),b=normalize(s2);
  if(a===b)return 1;
  if(!a.length||!b.length)return 0;
  const md=Math.max(0,Math.floor(Math.max(a.length,b.length)/2)-1);
  const am=new Uint8Array(a.length),bm=new Uint8Array(b.length);
  let matches=0,trans=0;
  for(let i=0;i<a.length;i++){
    for(let j=Math.max(0,i-md);j<Math.min(b.length,i+md+1);j++){
      if(bm[j]||a[i]!==b[j])continue;
      am[i]=1;bm[j]=1;matches++;break;
    }
  }
  if(!matches)return 0;
  let k=0;
  for(let i=0;i<a.length;i++){if(!am[i])continue;while(!bm[k])k++;if(a[i]!==b[k++])trans++;}
  const jaro=(matches/a.length+matches/b.length+(matches-trans/2)/matches)/3;
  let pfx=0;for(let i=0;i<Math.min(4,a.length,b.length);i++){if(a[i]===b[i])pfx++;else break;}
  return Math.min(1,jaro+pfx*0.1*(1-jaro));
}

// ════════════════════════════════════════════════════════════════════════════
// SOUNDEX — phonetic similarity (language-universal version)
// Words that sound similar get same code regardless of spelling
// ════════════════════════════════════════════════════════════════════════════
export function soundex(s:string):string{
  const w=normalize(s).split(" ")[0].toUpperCase();
  if(!w)return"";
  const M:Record<string,string>={B:"1",F:"1",P:"1",V:"1",C:"2",G:"2",J:"2",K:"2",Q:"2",S:"2",X:"2",Z:"2",D:"3",T:"3",L:"4",M:"5",N:"5",R:"6"};
  let code=w[0],prev=M[w[0]]??"";
  for(let i=1;i<w.length&&code.length<4;i++){const c=M[w[i]]??"";if(c&&c!==prev){code+=c;prev=c;}else if(!c)prev="";}
  return(code+"0000").slice(0,4);
}
export const phoneticMatch=(a:string,b:string):boolean=>soundex(a)===soundex(b)&&soundex(a)!=="0000";

// ════════════════════════════════════════════════════════════════════════════
// CHARACTER N-GRAMS — language-agnostic substring similarity
// Works for any writing system including Arabic, Hindi, Chinese
// "Tezpur" → ["tez","ezp","zpu","pur"] (trigrams)
// ════════════════════════════════════════════════════════════════════════════
function ngrams(s:string,n=3):Set<string>{
  const t=normalize(s).replace(/\s/g,"_");
  const g=new Set<string>();
  for(let i=0;i<=t.length-n;i++)g.add(t.slice(i,i+n));
  return g;
}
export function ngramSimilarity(a:string,b:string,n=3):number{
  const ga=ngrams(a,n),gb=ngrams(b,n);
  if(!ga.size||!gb.size)return 0;
  let inter=0;ga.forEach(g=>{if(gb.has(g))inter++;});
  return inter/(ga.size+gb.size-inter); // Jaccard coefficient
}

// ════════════════════════════════════════════════════════════════════════════
// TF-IDF VECTOR — lightweight semantic vector (no ML model needed)
// Maps text to a sparse float32 vector for cosine similarity
// ════════════════════════════════════════════════════════════════════════════
function tfIdf(tokens:string[],corpus:string[][]):Map<string,number>{
  const n=corpus.length;
  const tf=new Map<string,number>();
  tokens.forEach(t=>tf.set(t,(tf.get(t)??0)+1/tokens.length));
  const v=new Map<string,number>();
  tf.forEach((f,t)=>{
    const df=corpus.filter(d=>d.includes(t)).length;
    v.set(t,f*(Math.log((n+1)/(df+1))+1));
  });
  return v;
}
function cosine(a:Map<string,number>,b:Map<string,number>):number{
  let dot=0,na=0,nb=0;
  a.forEach((v,k)=>{dot+=v*(b.get(k)??0);na+=v*v;});
  b.forEach(v=>nb+=v*v);
  return na&&nb?dot/Math.sqrt(na*nb):0;
}
export function semanticSimilarity(q:string,t:string):number{
  const qt=tokenize(q),tt=tokenize(t);
  if(!qt.length||!tt.length)return 0;
  const corpus=[qt,tt];
  return cosine(tfIdf(qt,corpus),tfIdf(tt,corpus));
}

// ════════════════════════════════════════════════════════════════════════════
// VECTOR EMBEDDING — generates a dense float32 vector for any text
// Uses character n-gram hashing into a fixed-dimension space (512-dim)
// This vector is stored in Supabase pgvector column (vector(512))
// Deterministic — same text always produces same vector
// For production upgrade: replace with Supabase AI embeddings (1536-dim)
// ════════════════════════════════════════════════════════════════════════════
const VECTOR_DIM=512;
export function embedText(text:string):number[]{
  const tokens=tokenize(text);
  const vec=new Float32Array(VECTOR_DIM);
  // Hash each token into vector dimensions using FNV-1a
  for(const token of tokens){
    let h=2166136261;
    for(let i=0;i<token.length;i++){h=(h^token.charCodeAt(i))*16777619>>>0;}
    const idx=h%VECTOR_DIM;
    vec[idx]+=1;
    // Also add bigrams for richer representation
    for(let i=0;i<token.length-1;i++){
      let h2=2166136261;
      const bi=token.slice(i,i+2);
      for(let j=0;j<bi.length;j++){h2=(h2^bi.charCodeAt(j))*16777619>>>0;}
      vec[(h2%VECTOR_DIM+VECTOR_DIM/2)%VECTOR_DIM]+=0.5;
    }
  }
  // L2 normalize so cosine = dot product
  let norm=0;for(let i=0;i<VECTOR_DIM;i++)norm+=vec[i]*vec[i];
  norm=Math.sqrt(norm)||1;
  const result:number[]=[];
  for(let i=0;i<VECTOR_DIM;i++)result.push(vec[i]/norm);
  return result;
}

// Supabase pgvector format — returns the vector as a Postgres-compatible string
export const toVectorString=(v:number[]):string=>`[${v.join(",")}]`;

// ════════════════════════════════════════════════════════════════════════════
// MASTER SIMILARITY SCORE — combines all algorithms
// Returns 0→1. Used for both filtering and ranking articles.
// Optimized for speed: exits early when high confidence match found
// ════════════════════════════════════════════════════════════════════════════
export function similarity(query:string,text:string):number{
  const q=normalize(query),t=normalize(text);
  if(!q||!t)return 0;
  // Fast path: exact substring match
  if(t.includes(q)||q.includes(t))return 1;
  const qw=q.split(/\s+/).filter(w=>w.length>1);
  const tw=t.split(/\s+/).filter(w=>w.length>1);
  let wordScore=0;
  for(const qWord of qw){
    let best=0;
    for(const tWord of tw){
      if(qWord===tWord){best=1;break;}               // exact match → exit inner loop
      const jw=jaroWinkler(qWord,tWord);
      const ng=ngramSimilarity(qWord,tWord);
      const ph=phoneticMatch(qWord,tWord)?0.15:0;
      best=Math.max(best,jw*0.6+ng*0.3+ph);
      if(best>0.95)break;                             // good enough → stop early
    }
    wordScore=Math.max(wordScore,best);
  }
  if(wordScore>0.9)return wordScore;                  // fast exit for high confidence
  const sem=semanticSimilarity(query,text);
  return Math.min(1,wordScore*0.65+sem*0.35);
}

// ════════════════════════════════════════════════════════════════════════════
// ARTICLE SCORER — scores a single article against a query
// Weights: title > description (title is more authoritative)
// ════════════════════════════════════════════════════════════════════════════
export function scoreArticle(query:string,article:{title:string;description?:string}):number{
  const titleScore =similarity(query,article.title);
  const descScore  =article.description?similarity(query,article.description)*0.6:0;
  return Math.min(1,Math.max(titleScore,descScore));
}

// ════════════════════════════════════════════════════════════════════════════
// FILTER AND RANK — main function used by rss_dynamic.ts + news_tier.ts
// Filters articles by similarity threshold then ranks by score descending
// threshold 0.12 = permissive (catches typos, translations, paraphrases)
// threshold 0.30 = strict (near-exact matches only)
// ════════════════════════════════════════════════════════════════════════════
export function filterAndRank(query:string,articles:any[],threshold=0.12):any[]{
  if(!query.trim()||!articles.length)return articles;
  return articles
    .map(a=>({...a,_s:scoreArticle(query,{title:a.title??"",description:a.description??""})}))
    .filter(a=>a._s>=threshold)
    .sort((a,b)=>b._s-a._s)
    .map(({_s,...a})=>({...a,relevance_score:parseFloat(_s.toFixed(3))}));
}

// ════════════════════════════════════════════════════════════════════════════
// QUERY EXPANDER — generates search variants for maximum recall
// Universal: no language-specific rules, purely structural
// ════════════════════════════════════════════════════════════════════════════
export function expandQueryVariants(query:string):string[]{
  const n=normalize(query);
  const words=n.split(/\s+/).filter(w=>w.length>1);
  const title=words.map(w=>w[0].toUpperCase()+w.slice(1)).join(" ");
  return[...new Set([
    n,                  // normalized lowercase:  "tezpur"
    title,              // title case:             "Tezpur"
    query.trim(),       // original:               "tezpur" / "Tezpur" / "TEZPUR"
    `${title} news`,    // with news:              "Tezpur news"
    `latest ${title}`,  // with latest:            "latest Tezpur"
    `${title} today`,   // with today:             "Tezpur today"
  ])].slice(0,6);
}

// ════════════════════════════════════════════════════════════════════════════
// CORE ENTITY EXTRACTOR — strips noise words from any query
// Universal: removes common query noise regardless of language context
// "what is happening in Tezpur" → "Tezpur"
// "latest news about football"  → "football"
// "teZPur right now"            → "Tezpur"
// ════════════════════════════════════════════════════════════════════════════
const NOISE=/\b(right\s+now|just\s+now|currently|live\s+update|real.?time|latest|breaking|recent|today|tonight|this\s+(week|month)|updates?|news|what'?s?|who|where|when|why|how|tell\s+me|about|is\s+there|any|define|meaning\s+of|what\s+does|steps\s+to|guide\s+to|way\s+to|apply\s+for|process\s+of|happening|going\s+on|occurring|taking\s+place|in|at|on|for|of|the|a|an|and|or|to|with|by|from|near|around|is|are|was|were|be|been|being|do|does|did|can|could|will|would|should|may|might|must|show|me|find|get|search|look|tell)\b\s*/gi;
export const extractCoreEntity=(q:string):string=>{
  const c=q.trim().replace(NOISE,"").replace(/[^\w\s\u0600-\u06ff\u0900-\u097f\u4e00-\u9fff]/g," ").replace(/\s+/g," ").trim();
  if(c.length<2)return q.trim(); // fallback to original if too much stripped
  // Title case the result
  return c.replace(/\b([a-z])/g,x=>x.toUpperCase());
};

// ════════════════════════════════════════════════════════════════════════════
// EMBED ARTICLE — attaches vector to article object for Supabase pgvector
// Call this before inserting to Supabase — adds embedding field
// Supabase table needs: embedding vector(512)
// ════════════════════════════════════════════════════════════════════════════
export function attachVector(article:any):any{
  const text=`${article.title??""} ${article.description??""}`.trim();
  if(!text)return article;
  return{...article,embedding:toVectorString(embedText(text))};
}

// Batch version — attaches vectors to all articles efficiently
export function attachVectors(articles:any[]):any[]{
  return articles.map(attachVector);
}