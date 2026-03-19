# NewsApp/dataloom-engine/main.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
import math
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="DataLoom RL Engine", version="2.1.0")
logger.info("DataLoom RL Engine v2.1 ready — TF-IDF + blockchain trust + accurate why-reasons")

# ── Weight table — must sum to 1.0 ────────────────────────────────────────────
W_QUERY      = 0.30
W_BLOCKCHAIN = 0.20
W_TOPIC      = 0.20
W_SOURCE     = 0.15
W_ENGAGEMENT = 0.10
W_FRESHNESS  = 0.05

# Weighted contribution per factor key — used for dominant-factor detection
FACTOR_WEIGHTS: Dict[str, float] = {
    "query_relevance":   W_QUERY,
    "blockchain_trust":  W_BLOCKCHAIN,
    "topic_preference":  W_TOPIC,
    "source_preference": W_SOURCE,
    "engagement":        W_ENGAGEMENT,
    "freshness":         W_FRESHNESS,
}

FRESHNESS_SCORES: Dict[str, float] = {
    "breaking":  1.0,
    "today":     0.75,
    "this_week": 0.40,
    "older":     0.10,
}

# Render free tier: 512MB RAM cap
MAX_TFIDF_ARTICLES = 150

# ── Models ────────────────────────────────────────────────────────────────────

class BlockchainVerification(BaseModel):
    registered:  Optional[bool]  = False
    verified:    Optional[bool]  = False
    tx_hash:     Optional[str]   = None
    badge:       Optional[str]   = None

class Article(BaseModel):
    url:                     str
    title:                   str
    description:             Optional[str]   = ""
    source:                  Optional[str]   = ""
    topic:                   Optional[str]   = ""
    cluster_tag:             Optional[str]   = ""
    published_at:            Optional[str]   = ""
    freshness_label:         Optional[str]   = ""
    relevance_score:         Optional[float] = 0.5
    blockchain_verification: Optional[BlockchainVerification] = None

class TwinPreferences(BaseModel):
    topic_preferences:  Optional[Dict[str, float]] = {}
    source_preferences: Optional[Dict[str, float]] = {}
    total_clicks:       Optional[int]   = 0
    total_views:        Optional[int]   = 0
    total_skips:        Optional[int]   = 0
    total_thumbs_up:    Optional[int]   = 0
    total_thumbs_down:  Optional[int]   = 0
    avg_view_time:      Optional[float] = 0.0

class RankRequest(BaseModel):
    articles: List[Article]
    twin:     Optional[TwinPreferences] = None
    query:    Optional[str] = ""

class RankedArticle(BaseModel):
    article:               Article
    personalization_score: float
    score_breakdown:       dict
    why:                   str

class RankResponse(BaseModel):
    ranked_articles: List[RankedArticle]
    personalized:    bool
    total:           int
    verified_in_top: int

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "service": "DataLoom RL Engine", "version": "2.1.0"}

@app.get("/health")
def health():
    return {"status": "healthy", "model": "tfidf-blockchain-v2.1"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def _engagement_score(twin: TwinPreferences) -> float:
    """Derive 0–1 engagement quality from twin counters. 0.5 = cold start."""
    views  = twin.total_views  or 0
    clicks = twin.total_clicks or 0
    thumbs_up   = twin.total_thumbs_up   or 0
    thumbs_down = twin.total_thumbs_down or 0

    ctr       = (clicks / views) if views > 0 else 0.0
    ctr_score = 1 / (1 + math.exp(-10 * (ctr - 0.1)))  # sigmoid, midpoint at 10% CTR

    total_thumbs = thumbs_up + thumbs_down
    thumb_score  = (thumbs_up / total_thumbs) if total_thumbs > 0 else 0.5

    time_score = min(twin.avg_view_time / 45.0, 1.0) if twin.avg_view_time else 0.5

    return round(ctr_score * 0.4 + thumb_score * 0.4 + time_score * 0.2, 4)


def _blockchain_score(bv: Optional[BlockchainVerification]) -> float:
    """
    Trust score from prior on-chain status.
    registered + verified → 1.0 | registered only → 0.6 | nothing → 0.0
    """
    if not bv:
        return 0.0
    if bv.registered and bv.verified:
        return 1.0
    if bv.registered:
        return 0.6
    return 0.0


def _topic_score(article: Article, prefs: Dict[str, float]) -> float:
    if not prefs:
        return 0.0
    candidate = f"{article.topic or ''} {article.cluster_tag or ''}".lower().strip()
    best = 0.0
    for pref_topic, weight in prefs.items():
        if pref_topic.lower() in candidate or candidate in pref_topic.lower():
            best = max(best, float(weight))
    return best


def _source_score(article: Article, prefs: Dict[str, float]) -> float:
    if not prefs:
        return 0.0
    return float(prefs.get((article.source or "").strip(), 0.0))


def _tfidf_scores(articles: List[Article], query: str) -> List[float]:
    """
    TF-IDF cosine similarity, capped at MAX_TFIDF_ARTICLES to protect RAM.
    Articles beyond cap fall back to pre-computed relevance_score.
    """
    default = [float(a.relevance_score or 0.5) for a in articles]
    if not query or not articles:
        return default

    active   = articles[:MAX_TFIDF_ARTICLES]
    texts    = [f"{a.title} {a.description or ''}".strip() for a in active]
    fallback = default[MAX_TFIDF_ARTICLES:]

    try:
        vectorizer = TfidfVectorizer(
            stop_words="english",
            max_features=3000,   # vocabulary cap ~12MB for 150 docs
            sublinear_tf=True,
        )
        corpus       = texts + [query]
        matrix       = vectorizer.fit_transform(corpus)
        query_vec    = matrix[-1]
        article_vecs = matrix[:-1]
        sims         = cosine_similarity(article_vecs, query_vec).flatten().tolist()
        return sims + fallback
    except Exception as e:
        logger.warning(f"TF-IDF error: {e}")
        return default


def _build_why(
    why_parts: List[str],
    breakdown: Dict[str, float],
    query: str,
    article: Article,
    q: float,
    bc: float,
    fr: float,
    tp: float,
    sp: float,
) -> str:
    """
    Build a human-readable 'why recommended' string.

    If why_parts already has content (thresholds crossed), join them.
    Otherwise fall back to the DOMINANT scoring factor so the reason
    is always accurate — never a generic 'trending' when something
    specific drove the score.
    """
    if why_parts:
        return "Recommended because it's " + ", and ".join(why_parts)

    # Weighted contribution of each raw score
    weighted = {
        "query_relevance":   q   * W_QUERY,
        "blockchain_trust":  bc  * W_BLOCKCHAIN,
        "topic_preference":  tp  * W_TOPIC,
        "source_preference": sp  * W_SOURCE,
        "freshness":         fr  * W_FRESHNESS,
    }

    dominant = max(weighted, key=lambda k: weighted[k])
    dominant_value = weighted[dominant]

    # Only use dominant label if it meaningfully contributed
    if dominant_value < 0.02:
        return "Trending news in your region"

    if dominant == "query_relevance":
        return f"Recommended because it's relevant to '{query}'"
    if dominant == "blockchain_trust":
        if bc == 1.0:
            return "Recommended because it was previously verified on-chain"
        return "Recommended because it is registered on the blockchain"
    if dominant == "topic_preference":
        label = article.topic or article.cluster_tag or "your interests"
        return f"Recommended because it matches your interest in {label}"
    if dominant == "source_preference":
        return f"Recommended because it's from {article.source}, a source you trust"
    if dominant == "freshness":
        label_map = {1.0: "breaking news", 0.75: "today's news", 0.40: "this week's news"}
        label = label_map.get(fr, "recent news")
        return f"Recommended because it's {label}"

    return "Trending news in your region"

# ── Ranking endpoint ──────────────────────────────────────────────────────────

@app.post("/rank", response_model=RankResponse)
def rank_articles(req: RankRequest):
    try:
        articles = req.articles
        twin     = req.twin
        query    = (req.query or "").strip()

        if not articles:
            raise HTTPException(status_code=400, detail="No articles provided")

        logger.info(f"Ranking {len(articles)} articles | query='{query}'")

        has_twin = bool(
            twin and (
                twin.topic_preferences or
                twin.source_preferences or
                twin.total_thumbs_up > 0 or
                twin.total_clicks > 0
            )
        )

        query_scores    = _tfidf_scores(articles, query)
        engagement_base = _engagement_score(twin) if twin else 0.5

        scored: List[RankedArticle] = []

        for i, article in enumerate(articles):
            why_parts: List[str] = []
            breakdown: Dict[str, float] = {}

            # ── Query relevance ──────────────────────────────────────────────
            q = float(query_scores[i])
            breakdown["query_relevance"] = round(q, 3)
            if q > 0.25:
                why_parts.append(f"relevant to '{query}'")

            # ── Blockchain trust ─────────────────────────────────────────────
            bc = _blockchain_score(article.blockchain_verification)
            breakdown["blockchain_trust"] = round(bc, 3)
            if bc == 1.0:
                why_parts.append("previously verified on-chain")
            elif bc > 0:
                why_parts.append("registered on blockchain")

            # ── Topic preference ─────────────────────────────────────────────
            tp = _topic_score(article, twin.topic_preferences if twin else {})
            breakdown["topic_preference"] = round(tp, 3)
            if tp > 0.5:
                label = article.topic or article.cluster_tag
                why_parts.append(f"matches your interest in {label}")

            # ── Source preference ────────────────────────────────────────────
            sp = _source_score(article, twin.source_preferences if twin else {})
            breakdown["source_preference"] = round(sp, 3)
            if sp > 0.5:
                why_parts.append(f"from {article.source}, a source you trust")

            # ── Engagement (source-modulated) ────────────────────────────────
            eng = engagement_base * (0.5 + sp * 0.5)
            breakdown["engagement"] = round(eng, 3)

            # ── Freshness ────────────────────────────────────────────────────
            fr = FRESHNESS_SCORES.get(article.freshness_label or "", 0.25)
            breakdown["freshness"] = round(fr, 3)
            if fr >= 0.75:
                why_parts.append("breaking or today's news")

            # ── Weighted total ───────────────────────────────────────────────
            final = (
                q   * W_QUERY      +
                bc  * W_BLOCKCHAIN +
                tp  * W_TOPIC      +
                sp  * W_SOURCE     +
                eng * W_ENGAGEMENT +
                fr  * W_FRESHNESS
            )
            final = round(min(max(final, 0.0), 1.0), 4)
            breakdown["final_score"] = final

            # ── Accurate why string ──────────────────────────────────────────
            why = _build_why(
                why_parts=why_parts,
                breakdown=breakdown,
                query=query,
                article=article,
                q=q, bc=bc, fr=fr, tp=tp, sp=sp,
            )

            scored.append(RankedArticle(
                article=article,
                personalization_score=final,
                score_breakdown=breakdown,
                why=why,
            ))

        scored.sort(key=lambda x: x.personalization_score, reverse=True)

        top20_verified = sum(
            1 for r in scored[:20]
            if r.article.blockchain_verification
            and r.article.blockchain_verification.registered
        )

        logger.info(
            f"Done | top={scored[0].personalization_score if scored else 0:.3f} "
            f"| personalized={has_twin} | verified_in_top20={top20_verified}"
        )

        return RankResponse(
            ranked_articles=scored,
            personalized=bool(has_twin),
            total=len(scored),
            verified_in_top=top20_verified,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ranking error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
