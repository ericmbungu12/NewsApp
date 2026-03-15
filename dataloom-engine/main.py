from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="DataLoom RL Engine", version="1.0.0")

logger.info("DataLoom RL Engine ready — using TF-IDF (lightweight)")

# ─── Models ───────────────────────────────────────────────

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
    why: str

class RankResponse(BaseModel):
    ranked_articles: List[RankedArticle]
    personalized: bool
    total: int

# ─── Health Check ──────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "service": "DataLoom RL Engine"}

@app.get("/health")
def health():
    return {"status": "healthy", "model": "tfidf-lightweight"}

# ─── Ranking ───────────────────────────────────────────────

@app.post("/rank", response_model=RankResponse)
def rank_articles(req: RankRequest):
    try:
        articles = req.articles
        twin = req.twin
        query = req.query or ""

        if not articles:
            raise HTTPException(status_code=400, detail="No articles provided")

        logger.info(f"Ranking {len(articles)} articles for query: {query}")

        # Build article texts
        article_texts = [
            f"{a.title} {a.description or ''}".strip()
            for a in articles
        ]

        # TF-IDF query relevance
        query_scores = [0.5] * len(articles)
        if query and len(articles) > 0:
            try:
                vectorizer = TfidfVectorizer(stop_words="english")
                all_texts = article_texts + [query]
                tfidf_matrix = vectorizer.fit_transform(all_texts)
                query_vec = tfidf_matrix[-1]
                article_vecs = tfidf_matrix[:-1]
                sims = cosine_similarity(article_vecs, query_vec).flatten()
                query_scores = sims.tolist()
            except Exception as e:
                logger.warning(f"TF-IDF failed: {e}")

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

            # Query relevance (40%)
            q_score = float(query_scores[i])
            score += q_score * 0.4
            breakdown["query_relevance"] = round(q_score, 3)
            if q_score > 0.3:
                why_parts.append(f"relevant to '{query}'")

            # Topic preference (30%)
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

            # Source preference (20%)
            source_score = 0.0
            if has_twin and twin.source_preferences:
                article_source = (article.source or "").strip()
                if article_source in twin.source_preferences:
                    source_score = twin.source_preferences[article_source]
            score += source_score * 0.2
            breakdown["source_preference"] = round(source_score, 3)
            if source_score > 0.6:
                why_parts.append(f"from {article.source}, a source you trust")

            # Freshness bonus (10%)
            freshness_bonus = {
                "breaking": 0.15,
                "today": 0.10,
                "this_week": 0.05,
                "older": 0.0,
            }.get(article.freshness_label or "", 0.05)
            score += freshness_bonus
            breakdown["freshness_bonus"] = freshness_bonus
            if freshness_bonus >= 0.10:
                why_parts.append("recent news")

            final_score = min(max(score, 0.0), 1.0)
            breakdown["final_score"] = round(final_score, 3)

            why = "Recommended because it's " + ", and ".join(why_parts) if why_parts else "Trending news in your region"

            scored_articles.append(RankedArticle(
                article=article,
                personalization_score=round(final_score, 3),
                score_breakdown=breakdown,
                why=why,
            ))

        scored_articles.sort(key=lambda x: x.personalization_score, reverse=True)

        return RankResponse(
            ranked_articles=scored_articles,
            personalized=bool(has_twin),
            total=len(scored_articles),
        )

    except Exception as e:
        logger.error(f"Ranking error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
