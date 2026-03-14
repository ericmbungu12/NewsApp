import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ✅ Get user from JWT token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ Create Supabase client with user's JWT
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    // ✅ Get authenticated user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ Parse interaction from request body
    const body = await req.json();
    const {
      article_url,
      article_title,
      article_source,
      article_topic,
      content_hash,
      interaction_type,  // 'view' | 'click' | 'skip' | 'thumbs_up' | 'thumbs_down'
      view_time_seconds = 0,
    } = body;

    // ✅ Validate required fields
    if (!article_url || !interaction_type) {
      return new Response(JSON.stringify({ error: "article_url and interaction_type are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ Rate limiting — max 10 updates per hour per user
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseClient
      .from("article_interactions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", oneHourAgo);

    if (count && count >= 100) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ Step 1: Save raw interaction
    const { error: insertError } = await supabaseClient
      .from("article_interactions")
      .insert({
        user_id: user.id,
        article_url,
        article_title,
        article_source,
        article_topic,
        content_hash,
        interaction_type,
        view_time_seconds,
      });

    if (insertError) throw insertError;

    // ✅ Step 2: Get current twin
    const { data: twin, error: twinError } = await supabaseClient
      .from("digital_twins")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (twinError) throw twinError;

    // ✅ Step 3: Update twin preferences
    const topicPrefs = twin.topic_preferences || {};
    const sourcePrefs = twin.source_preferences || {};

    // Scoring weights per interaction
    const weights: Record<string, number> = {
      thumbs_up:   +0.3,
      click:       +0.1,
      view:        +0.05,
      skip:        -0.05,
      thumbs_down: -0.2,
    };

    const weight = weights[interaction_type] ?? 0;

    // Update topic score (clamp between 0.0 and 1.0)
    if (article_topic) {
      const current = topicPrefs[article_topic] ?? 0.5;
      topicPrefs[article_topic] = Math.min(1.0, Math.max(0.0, current + weight));
    }

    // Update source score (clamp between 0.0 and 1.0)
    if (article_source) {
      const current = sourcePrefs[article_source] ?? 0.5;
      sourcePrefs[article_source] = Math.min(1.0, Math.max(0.0, current + weight));
    }

    // Update counters
    const updates: Record<string, any> = {
      topic_preferences: topicPrefs,
      source_preferences: sourcePrefs,
      updated_at: new Date().toISOString(),
    };

    if (interaction_type === "view")        updates.total_views       = (twin.total_views || 0) + 1;
    if (interaction_type === "click")       updates.total_clicks      = (twin.total_clicks || 0) + 1;
    if (interaction_type === "skip")        updates.total_skips       = (twin.total_skips || 0) + 1;
    if (interaction_type === "thumbs_up")   updates.total_thumbs_up   = (twin.total_thumbs_up || 0) + 1;
    if (interaction_type === "thumbs_down") updates.total_thumbs_down = (twin.total_thumbs_down || 0) + 1;

    // Update avg view time
    if (interaction_type === "view" && view_time_seconds > 0) {
      const totalViews = (twin.total_views || 0) + 1;
      const currentAvg = twin.avg_view_time || 0;
      updates.avg_view_time = ((currentAvg * (totalViews - 1)) + view_time_seconds) / totalViews;
    }

    // ✅ Step 4: Save updated twin
    const { error: updateError } = await supabaseClient
      .from("digital_twins")
      .update(updates)
      .eq("user_id", user.id);

    if (updateError) throw updateError;

    return new Response(JSON.stringify({ 
      success: true, 
      interaction_type,
      topic_score: article_topic ? topicPrefs[article_topic] : null,
      source_score: article_source ? sourcePrefs[article_source] : null,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("update-twin error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});