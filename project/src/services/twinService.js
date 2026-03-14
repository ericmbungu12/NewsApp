import { supabase } from "../supabaseClient";

// ✅ Central function to track any interaction
export const trackInteraction = async ({
  article,
  interaction_type,
  view_time_seconds = 0,
}) => {
  try {
    // Get current session
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return; // Not logged in — skip silently

    const { error } = await supabase.functions.invoke("update-twin", {
      body: {
        article_url:       article.url,
        article_title:     article.title,
        article_source:    typeof article.source === "object" 
                             ? article.source?.name ?? "Unknown" 
                             : article.source || "Unknown",
        article_topic:     article.topic || article.cluster_tag || "general",
        content_hash:      article.blockchain_verification?.content_hash || null,
        interaction_type,
        view_time_seconds,
      },
    });

    if (error) console.warn("Twin update failed:", error.message);
  } catch (e) {
    console.warn("trackInteraction error:", e.message);
  }
};