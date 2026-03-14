from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="DataLoom RL Engine", version="1.0.0")

# ✅ Load model once at startup (small + fast model)
logger.info("Loading sentence transformer model...")
model = SentenceTransformer("all-MiniLM-L6-v2")
logger.info("Model loaded successfully!")

# ─── Request/Response Models ───────────────────────────────────────────────

class Article(BaseModel):
    url: str
    title: str
    description: Optional[str] = ""
    source: Optional[str] = ""
    topic: Optional[str] = ""
    cluster_tag: Optional[str] = ""
    published_at: Optional[str] = ""
    freshness_label: Optional[str] = ""
    blockchain_verification: Optional[dict] = None

class TwinPreferences(BaseModel):
    topic_preferences: Optional[dict] = {}
    source_preferences: Optional[dict] = {}
    total_clicks: Optional[int] = 0
    total_views: Optional[int] = 0
    total_skips: Optional[int] = 0
    total_thumbs_up: Optional[int] = 0
    total_thumbs_down: Optional[int] = 0
    avg_view_time: Optional[float] = 0.0

class RankRequest(BaseModel):
    articles: List[Article]
    twin: Optional[TwinPreferences] = None
    query: Optional[str] = ""

class RankedArticle(BaseModel):
    article: Article
    personalization_score: float
    score_breakdown: dict
    why: str  # "Why this news?" explanation

class RankResponse(BaseModel):
    ranked_articles: List[RankedArticle]
    personalized: bool
    total: int

# ─── Health Check ──────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "service": "DataLoom RL Engine"}

@app.get("/health")
def health():
    return {"status": "healthy", "model": "all-MiniLM-L6-v2"}

# ─── Main Ranking Endpoint ─────────────────────────────────────────────────

@app.post("/rank", response_model=RankResponse)
def rank_articles(req: RankRequest):
    try:
        articles = req.articles
        twin = req.twin
        query = req.query or ""

        if not articles:
            raise HTTPException(status_code=400, detail="No articles provided")

        logger.info(f"Ranking {len(articles)} articles for query: {query}")

        # ✅ Step 1: Build article text for embedding
        article_texts = []
        for a in articles:
            text = f"{a.title}. {a.description or ''}".strip()
            article_texts.append(text)

        # ✅ Step 2: Generate embeddings
        article_embeddings = model.encode(article_texts, convert_to_numpy=True)

        # ✅ Step 3: Build twin preference vector
        has_twin = twin and (
            twin.topic_preferences or 
            twin.source_preferences or 
            twin.total_thumbs_up > 0
        )

        scored_articles = []

        for i, article in enumerate(articles):
            score = 0.0
            breakdown = {}
            why_parts = []

            # ── A) Query relevance score (always computed) ──
            if query:
                query_embedding = model.encode([query], convert_to_numpy=True)
                query_sim = float(cosine_similarity(
                    article_embeddings[i].reshape(1, -1),
                    query_embedding
                )[0][0])
                score += query_sim * 0.4
                breakdown["query_relevance"] = round(query_sim, 3)
                if query_sim > 0.5:
                    why_parts.append(f"highly relevant to '{query}'")

            # ── B) Topic preference score ──
            topic_score = 0.0
            if has_twin and twin.topic_preferences:
                article_topic = (article.topic or article.cluster_tag or "").lower()
                for pref_topic, pref_score in twin.topic_preferences.items():
                    if pref_topic.lower() in article_topic or article_topic in pref_topic.lower():
                        topic_score = max(topic_score, pref_score)
                score += topic_score * 0.3
                breakdown["topic_preference"] = round(topic_score, 3)
                if topic_score > 0.6:
                    why_parts.append(f"matches your interest in {article.topic or 'this topic'}")

            # ── C) Source preference score ──
            source_score = 0.0
            if has_twin and twin.source_preferences:
                article_source = (article.source or "").strip()
                if article_source in twin.source_preferences:
                    source_score = twin.source_preferences[article_source]
                score += source_score * 0.2
                breakdown["source_preference"] = round(source_score, 3)
                if source_score > 0.6:
                    why_parts.append(f"from {article_source}, a source you trust")

            # ── D) Freshness bonus ──
            freshness_bonus = {
                "breaking": 0.15,
                "today": 0.10,
                "this_week": 0.05,
                "older": 0.0,
            }.get(article.freshness_label or "", 0.05)
            score += freshness_bonus
            breakdown["freshness_bonus"] = freshness_bonus
            if freshness_bonus >= 0.10:
                why_parts.append("breaking or recent news")

            # ── E) Engagement history bonus ──
            if has_twin and twin.total_thumbs_up > 0:
                engagement_ratio = twin.total_thumbs_up / max(twin.total_views or 1, 1)
                engagement_bonus = min(engagement_ratio * 0.1, 0.1)
                score += engagement_bonus
                breakdown["engagement_bonus"] = round(engagement_bonus, 3)

            # ── Final score (clamp 0-1) ──
            final_score = min(max(score, 0.0), 1.0)
            breakdown["final_score"] = round(final_score, 3)

            # ── Why this news? ──
            if not why_parts:
                why = "Trending news in your region"
            else:
                why = "Recommended because it's " + ", and ".join(why_parts)

            scored_articles.append(RankedArticle(
                article=article,
                personalization_score=round(final_score, 3),
                score_breakdown=breakdown,
                why=why,
            ))

        # ✅ Step 4: Sort by score descending
        scored_articles.sort(key=lambda x: x.personalization_score, reverse=True)

        logger.info(f"Ranking complete. Top score: {scored_articles[0].personalization_score if scored_articles else 0}")

        return RankResponse(
            ranked_articles=scored_articles,
            personalized=bool(has_twin),
            total=len(scored_articles),
        )

    except Exception as e:
        logger.error(f"Ranking error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
