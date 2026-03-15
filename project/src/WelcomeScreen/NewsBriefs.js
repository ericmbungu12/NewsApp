// WelcomeScreen/NewsBriefs.js
import React, { useState, useEffect } from "react";
import { 
  View, FlatList, Text, TouchableOpacity, Linking, 
  ActivityIndicator, Alert, ScrollView, StyleSheet, Modal
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import CryptoJS from "crypto-js";
import HeaderBar from "./HeaderBar";
import SearchInput from "./SearchInput";
import { supabase } from "../supabaseClient";
import { trackInteraction } from "../services/twinService";

const stripHtml = (str) => {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
            .replace(/\s+/g, " ").trim();
};

// ✅ ArticleCard OUTSIDE WelcomeScreen — hooks allowed here
const ArticleCard = ({ item, hasLoggedIn, thumbsState, setThumbsState, 
                       viewedArticles, verificationResults, setWhyModal }) => {
  const viewStartRef = React.useRef(null);

  const normalizeUrl = (u) => {
    if (!u || typeof u !== "string") return null;
    const trimmed = u.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return trimmed;
    return `https://${trimmed}`;
  };

  const handleViewStart = () => { viewStartRef.current = Date.now(); };
  const handleViewEnd = () => {
    if (!viewStartRef.current) return;
    const seconds = (Date.now() - viewStartRef.current) / 1000;
    if (seconds > 1) {
      trackInteraction({ article: item, interaction_type: "view", view_time_seconds: seconds });
    }
    viewStartRef.current = null;
  };

  const articleKey = item.url || item.title;
  const currentThumb = thumbsState[articleKey];

  const handleThumb = (type) => {
    if (!hasLoggedIn) {
      Alert.alert("Login Required", "Please login to rate articles.");
      return;
    }
    if (currentThumb === type) {
      setThumbsState(prev => ({ ...prev, [articleKey]: null }));
      return;
    }
    setThumbsState(prev => ({ ...prev, [articleKey]: type }));
    viewedArticles.current.add(articleKey);
    trackInteraction({ article: item, interaction_type: type });
  };

  const verification = verificationResults[articleKey];
  const isVerified = verification?.status === 'verified';
  const isTampered = verification?.status === 'tampered';

  return (
    <TouchableOpacity
      onPress={() => {
        const openUrl = normalizeUrl(item.url);
        if (!openUrl) { Alert.alert("No URL", "This article has no source link"); return; }
        viewedArticles.current.add(articleKey);
        trackInteraction({ article: item, interaction_type: "click" });
        Linking.openURL(openUrl).catch(() => Alert.alert("Error", `Cannot open this link:\n${openUrl}`));
      }}
      onLongPress={() => {
        if (item.personalization_score !== undefined) {
          setWhyModal({
            title: item.title,
            score: item.personalization_score,
            why: item.why_recommended || "Trending news in your region",
            breakdown: item.score_breakdown || null,
          });
        } else {
          Alert.alert("ℹ️ Not personalized yet", "Search more and rate articles to get personalized recommendations.");
        }
      }}
      delayLongPress={400}
      onPressIn={handleViewStart}
      onPressOut={handleViewEnd}
      style={styles.articleCard}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <Text style={[styles.articleTitle, { flex: 1 }]} numberOfLines={2}>{item.title}</Text>
        <View style={{ marginLeft: 8, marginTop: 2, alignItems: 'flex-end' }}>
          {verification && (
            <Text style={{ fontSize: 12, color: isVerified ? '#16a34a' : isTampered ? '#F97316' : '#EF4444', fontWeight: '600' }}>
              {isVerified ? '✔ Verified' : isTampered ? '⚠ Altered' : '✕ Unverified'}
            </Text>
          )}
          {item.freshness_label === 'fresh' && (
            <View style={[styles.freshBadge, { marginTop: 4 }]}>
              <Text style={styles.freshText}>NOW</Text>
            </View>
          )}
        </View>
      </View>

      {!!item.description && (
        <Text style={styles.articleDescription} numberOfLines={3}>
          {stripHtml(item.description)}
        </Text>
      )}

      {item.blockchain_verification?.tx_hash && (
        <TouchableOpacity
          style={styles.txHashButton}
          onPress={() => {
            const txHash = item.blockchain_verification.tx_hash;
            const txUrl = `https://sepolia.etherscan.io/tx/${txHash}`;
            Alert.alert('🔗 Blockchain Transaction',
              `This article was registered on Sepolia testnet.\n\nTX: ${txHash.substring(0, 20)}...${txHash.slice(-6)}\n\nOpen on Etherscan to verify?`,
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'View on Etherscan', onPress: () => Linking.openURL(txUrl).catch(() => Alert.alert("Error", "Cannot open Etherscan link")) },
              ]
            );
          }}
        >
          <Text style={styles.txHashText}>🔗 TX: {item.blockchain_verification.tx_hash.substring(0, 10)}...</Text>
        </TouchableOpacity>
      )}

      <View style={styles.articleMeta}>
        <Text style={styles.metaText}>
          {item.source || "Unknown"} •{" "}
          {item.published_at
            ? new Date(item.published_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : "Just now"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {item.cluster_tag?.startsWith('sem-') && (
            <View style={styles.clusterBadge}>
              <Text style={styles.clusterText}>Cluster {item.cluster_tag.slice(4)}</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => handleThumb("thumbs_up")}
            style={[styles.thumbButton, currentThumb === "thumbs_up" && styles.thumbButtonActive]}
          >
            <Text style={{ fontSize: 14 }}>👍</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleThumb("thumbs_down")}
            style={[styles.thumbButton, currentThumb === "thumbs_down" && styles.thumbButtonActive]}
          >
            <Text style={{ fontSize: 14 }}>👎</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// ✅ Main component
export default function WelcomeScreen({ navigation, route }) {
  const [news, setNews] = useState({ digest: null, articles: [] });
  const [info, setInfo] = useState("");
  const [topic, setTopic] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [hasLoggedIn, setHasLoggedIn] = useState(false);
  const [profileImage, setProfileImage] = useState(null);
  const [attachedImages, setAttachedImages] = useState([]);
  const [profileDropdownVisible, setProfileDropdownVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verificationResults, setVerificationResults] = useState({});
  const [thumbsState, setThumbsState] = useState({});
  const [hasSearched, setHasSearched] = useState(false);
  const [whyModal, setWhyModal] = useState(null);

  const viewabilityConfig = React.useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 1000,
  }).current;

  const viewedArticles = React.useRef(new Set());
  const visibleArticles = React.useRef(new Set());

  const onViewableItemsChanged = React.useRef(({ changed }) => {
    changed.forEach(({ item, isViewable }) => {
      const key = item.url || item.title;
      if (isViewable) {
        visibleArticles.current.add(key);
      } else {
        if (visibleArticles.current.has(key)) {
          visibleArticles.current.delete(key);
          if (!viewedArticles.current.has(key)) {
            viewedArticles.current.add(key);
            trackInteraction({ article: item, interaction_type: "skip" });
          }
        }
      }
    });
  }).current;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const loggedIn = await AsyncStorage.getItem("hasLoggedIn");
        const image = await AsyncStorage.getItem("profileImage");
        if (!mounted) return;
        setHasLoggedIn(loggedIn === "true");
        if (image) setProfileImage(image);
      } catch (e) { console.error("Auth load error:", e); }
    })();
    return () => { mounted = false; };
  }, []);

  const computeSHA256 = (content) => {
    if (!content) return null;
    try {
      const hash = CryptoJS.SHA256(content).toString(CryptoJS.enc.Hex);
      return '0x' + hash;
    } catch (e) { console.error('Hash error:', e); return null; }
  };

  const verifyArticleIntegrity = (article) => {
    const { blockchain_verification: bv } = article;
    if (!bv?.registered || !bv?.tx_hash) return { status: 'not_registered', message: '✕ Unverified' };
    if (bv?.content_hash) {
      const currentHash = computeSHA256(article.description);
      if (!currentHash) return { status: 'error', message: '✕ Unverified' };
      if (currentHash.toLowerCase() === bv.content_hash.toLowerCase()) return { status: 'verified', message: '✔ Verified' };
      return { status: 'tampered', message: '⚠ Altered' };
    }
    return { status: 'verified', message: '✔ Verified' };
  };

  const verifyAllArticles = (articlesList) => {
    const results = {};
    for (const article of articlesList) {
      const key = article.url || article.title;
      results[key] = verifyArticleIntegrity(article);
    }
    setVerificationResults(results);
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      await AsyncStorage.multiRemove(["hasLoggedIn", "userName", "profileImage"]);
      setHasLoggedIn(false);
      setNews({ digest: null, articles: [] });
      setInfo("");
      setTopic("");
      setAttachedImages([]);
      setVerificationResults({});
      setHasSearched(false);
      setThumbsState({});
      setWhyModal(null);
      Alert.alert("Logged out", "You've been signed out successfully.");
      navigation.navigate("Welcome");
    } catch (e) {
      console.error("Logout error:", e);
      Alert.alert("Error", "Failed to log out. Please try again.");
    }
  };

  const handleLogin = () => {
    setProfileDropdownVisible(false);
    navigation.navigate("Login");
  };

  const restoreSearch = route.params?.restoreSearch || null;

  const renderDigestText = (text) => {
    if (!text) return null;
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return (
      <Text style={styles.digestText}>
        {parts.map((part, i) =>
          i % 2 === 1 ? <Text key={i} style={{ fontWeight: "bold" }}>{part}</Text> : part
        )}
      </Text>
    );
  };

  const renderArticle = ({ item }) => (
    <ArticleCard
      item={item}
      hasLoggedIn={hasLoggedIn}
      thumbsState={thumbsState}
      setThumbsState={setThumbsState}
      viewedArticles={viewedArticles}
      verificationResults={verificationResults}
      setWhyModal={setWhyModal}
    />
  );

  return (
    <View style={styles.container}>
      <HeaderBar
        navigation={navigation}
        profileImage={profileImage}
        setProfileImage={setProfileImage}
        profileDropdownVisible={profileDropdownVisible}
        setProfileDropdownVisible={setProfileDropdownVisible}
        handleLogin={handleLogin}
        handleLogout={handleLogout}
      />

      <SearchInput
        topic={topic}
        setTopic={setTopic}
        attachedImages={attachedImages}
        setAttachedImages={setAttachedImages}
        isListening={isListening}
        setIsListening={setIsListening}
        onSearchStart={() => {
          setLoading(true);
          setHasSearched(true);
        }}
        onSearchComplete={() => setLoading(false)}
        setNews={(data) => {
          setNews(data);
          setLoading(false);
          setThumbsState({});
          viewedArticles.current.clear();
          visibleArticles.current.clear();
          if (data.articles?.length > 0) {
            const uniqueArticles = data.articles.filter((article, index, self) =>
              index === self.findIndex(a => a.url === article.url)
            );
            verifyAllArticles(uniqueArticles);
          }
        }}
        setInfo={(msg) => {
          setInfo(msg);
          setLoading(false);
        }}
        hasLoggedIn={hasLoggedIn}
        navigation={navigation}
        initialSearch={restoreSearch}
      />

      <View style={styles.contentArea}>
        {/* DIGEST CARD */}
        {news.digest && (
          <View style={styles.digestCard}>
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
              <Text style={styles.digestTitle}>🗞️ Briefing</Text>
              {news.digest.reliability !== null && (
                <View style={{ flexDirection: "row", marginLeft: 8 }}>
                  {[...Array(5)].map((_, i) => (
                    <Text key={i} style={{ fontSize: 12, color: i < Math.round(news.digest.reliability) ? "#f59e0b" : "#cbd5e1" }}>★</Text>
                  ))}
                  <Text style={{ marginLeft: 4, fontSize: 12 }}>({news.digest.reliability}/5)</Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1, marginBottom: 8 }}>
              <ScrollView nestedScrollEnabled keyboardDismissMode="on-drag" showsVerticalScrollIndicator>
                {renderDigestText(news.digest.summary)}
              </ScrollView>
            </View>
            <Text style={styles.digestFooter}>• Synthesized from {news.digest.source_count} credible sources</Text>
          </View>
        )}

        {/* ARTICLES LIST */}
        {news.articles.length > 0 ? (
          <FlatList
            data={news.articles}
            keyExtractor={(item, index) => {
              const urlKey = item.url
                ? item.url.replace(/[^a-zA-Z0-9]/g, '').substring(0, 50)
                : 'article';
              return `${urlKey}-${index}-${Date.now()}`;
            }}
            renderItem={renderArticle}
            contentContainerStyle={{ paddingBottom: 80 }}
            keyboardShouldPersistTaps="handled"
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
          />
        ) : news.digest ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No individual articles available for this briefing.</Text>
          </View>
        ) : null}

        {/* LOADING STATE */}
        {loading && (
          <View style={styles.loadingState}>
            <ActivityIndicator size="large" color="#2874F0" />
            <Text style={styles.loadingText}>Fetching news...</Text>
          </View>
        )}

        {/* NO ARTICLES AFTER SEARCH */}
        {!loading && !news.digest && !info && news.articles.length === 0 && hasSearched && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>No articles found</Text>
            <Text style={styles.emptySubtext}>Try a different search term</Text>
          </View>
        )}

        {/* READY TO SEARCH */}
        {!loading && !news.digest && !info && news.articles.length === 0 && !hasSearched && (
          <View style={styles.emptyState}>
            <Text style={styles.infoText}>Ready to search</Text>
          </View>
        )}

        {/* INFO MESSAGE */}
        {!loading && info && !news.digest && news.articles.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.infoText}>{info}</Text>
          </View>
        )}
      </View>

      {/* WHY THIS NEWS MODAL */}
      <Modal
        visible={!!whyModal}
        transparent
        animationType="fade"
        onRequestClose={() => setWhyModal(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setWhyModal(null)}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🤖 Why this news?</Text>
            <Text style={styles.modalArticleTitle} numberOfLines={2}>
              {whyModal?.title}
            </Text>

            {/* Score bar */}
            <View style={styles.scoreRow}>
              <Text style={styles.scoreLabel}>Personalization match</Text>
              <Text style={styles.scoreValue}>
                {Math.round((whyModal?.score ?? 0) * 100)}%
              </Text>
            </View>
            <View style={styles.scoreBarBg}>
              <View style={[styles.scoreBarFill, { width: `${Math.round((whyModal?.score ?? 0) * 100)}%` }]} />
            </View>

            {/* Explanation */}
            <Text style={styles.whyText}>{whyModal?.why}</Text>

            {/* Breakdown */}
            {whyModal?.breakdown && (
              <View style={styles.breakdownBox}>
                {whyModal.breakdown.query_relevance !== undefined && (
                  <Text style={styles.breakdownItem}>
                    🔍 Query relevance: {Math.round(whyModal.breakdown.query_relevance * 100)}%
                  </Text>
                )}
                {whyModal.breakdown.topic_preference !== undefined && (
                  <Text style={styles.breakdownItem}>
                    📌 Topic match: {Math.round(whyModal.breakdown.topic_preference * 100)}%
                  </Text>
                )}
                {whyModal.breakdown.source_preference !== undefined && (
                  <Text style={styles.breakdownItem}>
                    📰 Source trust: {Math.round(whyModal.breakdown.source_preference * 100)}%
                  </Text>
                )}
                {whyModal.breakdown.freshness_bonus !== undefined && (
                  <Text style={styles.breakdownItem}>
                    ⚡ Freshness bonus: +{Math.round(whyModal.breakdown.freshness_bonus * 100)}%
                  </Text>
                )}
              </View>
            )}

            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setWhyModal(null)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  contentArea: { flex: 1 },
  digestCard: {
    margin: 16, padding: 16, backgroundColor: "#f8fafc",
    borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0",
    elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, height: 160
  },
  digestTitle: { fontSize: 16, fontWeight: "bold" },
  digestText: { fontSize: 15, lineHeight: 22, color: "#334155" },
  digestFooter: { fontSize: 11, fontStyle: "italic", color: "#64748b" },
  articleCard: {
    padding: 16, borderBottomWidth: 1, borderColor: "#f1f1f1",
    backgroundColor: "#fff"
  },
  articleTitle: { fontSize: 16, fontWeight: "700", flex: 1 },
  articleDescription: { fontSize: 14, color: "#475569", marginVertical: 6, lineHeight: 20 },
  articleMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  metaText: { fontSize: 12, color: "#64748b" },
  freshBadge: { backgroundColor: "#dcfce7", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  freshText: { fontSize: 10, color: "#16a34a", fontWeight: "600" },
  clusterBadge: { backgroundColor: "#e0f2fe", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 8 },
  clusterText: { fontSize: 10, color: "#0ea5e9" },
  txHashButton: { backgroundColor: "#F0F8FF", padding: 8, borderRadius: 6, marginTop: 8 },
  txHashText: { color: "#0066CC", fontSize: 12, textAlign: "center" },
  loadingState: { flex: 1, justifyContent: "center", alignItems: "center", marginTop: 40 },
  loadingText: { marginTop: 16, fontSize: 16, color: "#666" },
  emptyState: { flex: 1, justifyContent: "center", alignItems: "center", marginTop: 40, padding: 20 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyText: { fontSize: 20, fontWeight: "bold", color: "#333", marginBottom: 8, textAlign: "center" },
  emptySubtext: { fontSize: 14, color: "#666", marginBottom: 24, textAlign: "center" },
  infoText: { fontSize: 16, color: "#64748b", textAlign: "center" },
  retryButton: { backgroundColor: "#0066CC", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  thumbButton: { padding: 4, borderRadius: 6, backgroundColor: "#f1f5f9" },
  thumbButtonActive: { backgroundColor: "#dbeafe" },

  // Modal styles
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center", alignItems: "center",
  },
  modalCard: {
    backgroundColor: "#fff", borderRadius: 16,
    padding: 20, marginHorizontal: 24, width: "90%",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 8, color: "#1a1a1a" },
  modalArticleTitle: { fontSize: 14, color: "#475569", marginBottom: 16, lineHeight: 20 },
  scoreRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  scoreLabel: { fontSize: 13, color: "#64748b" },
  scoreValue: { fontSize: 13, fontWeight: "700", color: "#2874F0" },
  scoreBarBg: {
    height: 8, backgroundColor: "#e2e8f0",
    borderRadius: 4, marginBottom: 16, overflow: "hidden",
  },
  scoreBarFill: { height: 8, backgroundColor: "#2874F0", borderRadius: 4 },
  whyText: { fontSize: 14, color: "#334155", lineHeight: 20, marginBottom: 12 },
  breakdownBox: { backgroundColor: "#f8fafc", borderRadius: 8, padding: 12, marginBottom: 16 },
  breakdownItem: { fontSize: 12, color: "#64748b", marginBottom: 4 },
  modalClose: { backgroundColor: "#2874F0", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  modalCloseText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});