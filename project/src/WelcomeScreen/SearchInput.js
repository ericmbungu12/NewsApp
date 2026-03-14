// WelcomeScreen/SearchInput.js
import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, Animated, Modal, Alert, Keyboard, Platform, PermissionsAndroid, ToastAndroid, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
//import Voice from "@react-native-voice";
import { launchImageLibrary } from "react-native-image-picker";
import RNFS from "react-native-fs";
import { supabase } from "../supabaseClient";

const RECENTS_KEY = "recent_searches_v1";
const RECENTS_LIMIT = 5;
const PENDING_SEARCH_KEY = "pending_search_v1";

export default function SearchInput({ 
  topic, setTopic, attachedImages, setAttachedImages, isListening, setIsListening,
  hasLoggedIn, navigation, setNews, setInfo, triggerSearch = false, initialSearch = null,
  // ✅ NEW: Callback for search state changes
  onSearchStart, onSearchComplete,
}) {
  const inputRef = useRef(null);
  const fadeFileAnim = useRef(new Animated.Value(0)).current;
  const [recentSearches, setRecentSearches] = useState([]);
  const [recentDropdownVisible, setRecentDropdownVisible] = useState(false);
  const [fileDropdownVisible, setFileDropdownVisible] = useState(false);
  const [expandedImage, setExpandedImage] = useState(null);
  const [usedOnce, setUsedOnce] = useState(false);
  const navigationLock = useRef(false);
  const hasRestoredInitial = useRef(false);
  // ✅ NEW: Local loading state for search operations
  const [isSearching, setIsSearching] = useState(false);

  // 🔹 Restore initial search ONCE on mount
  useEffect(() => {
    if (hasRestoredInitial.current || !initialSearch) return;
    if ((topic.trim() === "" && attachedImages.length === 0) && (initialSearch.topic || initialSearch.attachedImages?.length)) {
      if (initialSearch.topic) setTopic(initialSearch.topic);
      if (initialSearch.attachedImages?.length) setAttachedImages(initialSearch.attachedImages);
      if (initialSearch.topic || initialSearch.attachedImages?.length) {
        ToastAndroid.show(
          initialSearch.topic ? `Restored: "${initialSearch.topic.slice(0, 30)}${initialSearch.topic.length > 30 ? '...' : ''}"` : "Restored image search",
          ToastAndroid.SHORT
        );
      }
      hasRestoredInitial.current = true;
    }
  }, [initialSearch, topic, attachedImages, setTopic, setAttachedImages]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const recentsJson = await AsyncStorage.getItem(RECENTS_KEY);
        if (!mounted) return;
        if (recentsJson) { const arr = JSON.parse(recentsJson); if (Array.isArray(arr)) setRecentSearches(arr.slice(0, RECENTS_LIMIT)); }
      } catch (err) { console.error("Load recents error:", err); }
    })();
    return () => { mounted = false; };
  }, []);

  // 🎙️ Voice setup
  /*useEffect(() => {
    Voice.onSpeechResults = (event) => { if (event?.value?.length > 0) setTopic(prev => prev ? prev + " " + event.value[0] : event.value[0]); };
    Voice.onSpeechError = (e) => { console.log("voice error:", e); setIsListening(false); ToastAndroid.show("Voice error. Try again.", ToastAndroid.SHORT); };
    Voice.onSpeechEnd = () => { setIsListening(false); };
    return () => { Voice.destroy().then(() => { Voice.removeAllListeners && Voice.removeAllListeners(); }); };
  }, []);*/

  // 🔊 Mic permission
  const requestMicPermission = async () => {
    if (Platform.OS !== "android") return true;
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, { title: "Microphone Permission", message: "DataLoom needs microphone access.", buttonPositive: "OK" });
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  };

  const startListening = async () => {
    const ok = await requestMicPermission();
    if (!ok) { Alert.alert("Permission denied", "Please enable microphone."); return; }
    try { setIsListening(true); await Voice.start("en-US"); }
    catch (e) { console.log("start error:", e); setIsListening(false); ToastAndroid.show("Voice error • Try again", ToastAndroid.SHORT); }
  };

  const stopListening = async () => { try { await Voice.stop(); setIsListening(false); } catch (e) { console.log("stop error:", e); } };

  const toggleFileDropdown = () => {
    const show = !fileDropdownVisible;
    setFileDropdownVisible(show);
    Animated.timing(fadeFileAnim, { toValue: show ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  };

  // 🖼️ Image utils
  const assetUriToBase64 = async (asset) => {
    try {
      if (asset.base64) return asset.base64;
      const uri = asset.uri || asset.uriString || asset.fileCopyUri;
      if (!uri) throw new Error("No URI on asset");
      const path = uri.startsWith("file://") ? uri.replace("file://", "") : uri;
      return await RNFS.readFile(path, "base64");
    } catch (err) { console.error("assetUriToBase64 error:", err); throw err; }
  };

  const uploadBase64ToSupabase = async (base64, contentType = "image/jpeg") => {
    try {
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2)}.jpg`;
      const { error: uploadError } = await supabase.storage.from("uploads").upload(fileName, base64, { contentType, encoding: "base64" });
      if (uploadError) throw uploadError;
      const { publicUrlData } = supabase.storage.from("uploads").getPublicUrl(fileName);
      return publicUrlData.publicUrl;
    } catch (err) { console.error("uploadBase64ToSupabase error:", err); throw err; }
  };

  const pickImageToInput = async () => {
    try {
      const res = await new Promise(resolve => launchImageLibrary({ mediaType: "photo", selectionLimit: 0, quality: 0.6 }, resolve));
      if (!res?.assets?.length || res.didCancel) return;
      const uploadedUrls = [];
      for (const asset of res.assets) {
        try { const base64 = await assetUriToBase64(asset); const publicUrl = await uploadBase64ToSupabase(base64, asset.type || "image/jpeg"); uploadedUrls.push(publicUrl); }
        catch (err) { console.error("Image upload failed:", err); }
      }
      if (uploadedUrls.length) setAttachedImages(prev => [...prev, ...uploadedUrls]);
    } catch (err) { console.error("pickImageToInput error:", err); }
    finally { setFileDropdownVisible(false); setTimeout(() => inputRef.current?.focus(), 100); }
  };

  const removeImage = (uri) => setAttachedImages(prev => prev.filter(u => u !== uri));

  const clearRecentSearches = async () => {
    try { setRecentSearches([]); setRecentDropdownVisible(false); await AsyncStorage.removeItem(RECENTS_KEY); }
    catch (err) { console.error("Failed to clear recents:", err); }
  };

  const isSearchDisabled = () => (topic.trim() === "" && attachedImages.length === 0);

  // 🔍 MAIN SEARCH FUNCTION — fetchnews with loading state + blockchain passthrough
  const fetchRecentNews = useCallback(async (overrideTopic = null) => {
    if (navigationLock.current) return;
    navigationLock.current = true;
    // ✅ Notify parent that search started
    if (onSearchStart) onSearchStart();
    setIsSearching(true);

    try {
      const queryTerm = (overrideTopic ?? topic).trim();
      if (!queryTerm && attachedImages.length === 0) {
        navigationLock.current = false; setIsSearching(false);
        if (onSearchComplete) onSearchComplete();
        return;
      }

      // 🔐 Auth gating: 1 free search
      if (!hasLoggedIn) {
        if (!usedOnce) {
          setUsedOnce(true);
        } else {
          const pending = { topic: topic.trim(), attachedImages: [...attachedImages], timestamp: Date.now() };
          await AsyncStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify(pending));
          Alert.alert(
            "Login Required", "Please login to continue using DataLoom.",
            [
              { text: "OK", onPress: () => { requestAnimationFrame(() => { navigation.navigate("Login", { from: "SearchInput" }); setTimeout(() => { navigationLock.current = false; setIsSearching(false); if (onSearchComplete) onSearchComplete(); }, 600); }); } },
              { text: "Cancel", onPress: () => { navigationLock.current = false; setIsSearching(false); if (onSearchComplete) onSearchComplete(); }, style: "cancel" },
            ]
          );
          return;
        }
      }

      // ✅ Save to recents
      if (queryTerm) {
        const normalized = queryTerm;
        const existing = recentSearches.filter(t => t !== normalized);
        const newArr = [normalized, ...existing].slice(0, RECENTS_LIMIT);
        setRecentSearches(newArr);
        await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(newArr));
      }

      if (hasLoggedIn || usedOnce === false) {
        setInfo("Fetching news…");
        setNews({ digest: null, articles: [] });
        if (!overrideTopic) setTopic("");
        Keyboard.dismiss();
      }

      try {
        const payload = { 
          topic: queryTerm, 
          region: "india", // ✅ Ensure region is sent for proper news filtering
          maxAgeHours: 24 
        };
        const { data, error } = await supabase.functions.invoke("fetch-news", { body: payload });
        if (error) throw error;

        const raw = data || {};
        const candidate = raw?.news || raw?.data || raw;
        const digest = candidate?.digest || candidate?.summary || null;
        const articles = Array.isArray(candidate?.articles) ? candidate.articles : [];

        // ✅ Ensure articles have blockchain_verification structure (fallback if missing)
        const articlesWithVerification = articles.map(article => ({
          ...article,
          // ✅ Normalize source to always be a string
          source: typeof article.source === "object" 
            ? article.source?.name ?? "Unknown" 
            : article.source || "Unknown",
          blockchain_verification: article.blockchain_verification || {
            status: "not_registered", registered: false, verified: false,
            publisher: null, registered_at: null, contract_address: null, tx_hash: null,
            badge: "❌ Not on blockchain",
            content_hash: article.content_hash || null, // ✅ Include content_hash for frontend verification
          }
        }));

        // ✅ ADDITIONAL DEBUG LOGS FOR BLOCKCHAIN VERIFICATION
        console.log("=== BLOCKCHAIN DEBUG ===");
        articlesWithVerification.slice(0, 3).forEach((a, i) => {
          console.log(`Article ${i+1}: ${a.title?.substring(0, 40)}`);
          console.log(`  registered: ${a.blockchain_verification?.registered}`);
          console.log(`  status: ${a.blockchain_verification?.status}`);
          console.log(`  tx_hash: ${a.blockchain_verification?.tx_hash}`);
          console.log(`  content_hash: ${a.blockchain_verification?.content_hash}`);
        });
        console.log("========================");

        if (digest && (typeof digest === "object" || typeof digest === "string")) {
          setNews({ digest, articles: articlesWithVerification }); setInfo("");
        } else if (articlesWithVerification.length > 0) {
          setNews({ digest: { summary: "Briefing not provided by server.", source_count: 0, reliability: null }, articles: articlesWithVerification });
          setInfo("Briefing data was not returned, showing articles only.");
        } else {
          setNews({ digest: null, articles: [] }); setInfo("No news found.");
        }
      } catch (err) {
        console.error("fetch-news error:", err); setNews({ digest: null, articles: [] }); setInfo("Error fetching news (check backend response).");
      } finally { setAttachedImages([]); }
    } finally {
      navigationLock.current = false; setIsSearching(false);
      // ✅ Notify parent that search completed
      if (onSearchComplete) onSearchComplete();
    }
  }, [topic, attachedImages, hasLoggedIn, usedOnce, navigation, setTopic, setNews, setInfo, setAttachedImages, recentSearches, onSearchStart, onSearchComplete]);

  // 🔁 Auto-search after login (external trigger)
  const triggeredRef = useRef(false);
  useEffect(() => {
    if (triggerSearch && !triggeredRef.current) { triggeredRef.current = true; fetchRecentNews(); }
  }, [triggerSearch, fetchRecentNews]);

  // 🎨 UI
  return (
    <View style={{ position: "relative" }}>
      <View style={{ borderWidth: 1, borderRadius: 16, padding: 10, marginHorizontal: 10, borderColor: "#ddd", backgroundColor: "#fff" }}>
        {attachedImages.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8, maxHeight: 45 }}>
            {attachedImages.map((uri, i) => (
              <View key={i} style={{ marginRight: 6, position: "relative" }}>
                <TouchableOpacity onPress={() => setExpandedImage(uri)}>
                  <Image source={{ uri }} style={{ width: 45, height: 45, borderRadius: 8, borderWidth: 1, borderColor: "#ddd" }} />
                </TouchableOpacity>
                <TouchableOpacity style={{ position: "absolute", top: -5, right: -5, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 10, paddingHorizontal: 3 }} onPress={() => removeImage(uri)}>
                  <Text style={{ fontSize: 12, color: "#fff" }}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TouchableOpacity onPress={toggleFileDropdown}>
            <Text style={{ fontSize: 20, marginRight: 6 }}>📎</Text>
          </TouchableOpacity>
          <TextInput
            ref={inputRef} placeholder="Ask or speak..." placeholderTextColor="#888"
            value={topic} onChangeText={setTopic} style={{ flex: 1, color: "#000" }}
            onFocus={() => setRecentDropdownVisible(recentSearches.length > 0)}
            onBlur={() => { setTimeout(() => setRecentDropdownVisible(false), 150); }}
            multiline textAlignVertical="center"
            editable={!isSearching} // ✅ Disable input while searching
          />
          {topic && !isSearching ? <TouchableOpacity onPress={() => setTopic("")}><Text style={{ fontSize: 18, marginLeft: 6 }}>✕</Text></TouchableOpacity> : null}
          <TouchableOpacity onPress={isListening ? stopListening : startListening}>
            <Text style={{ fontSize: 20, marginLeft: 6, color: isListening ? "#FF4B4B" : "#555", opacity: isSearching ? 0.5 : 1 /* ✅ Disable mic while searching */ }}>🎙️</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => fetchRecentNews()} disabled={isSearchDisabled() || isSearching} style={{ opacity: (isSearchDisabled() || isSearching) ? 0.5 : 1, marginLeft: 6 }}>
            <View style={{ backgroundColor: "#000", borderRadius: 50, padding: 6, justifyContent: "center", alignItems: "center" }}>
              {/* ✅ Show spinner or arrow based on loading state */}
              {isSearching ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: "#fff", fontSize: 20 }}>➤</Text>}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* 🔹 Overlay to dismiss dropdown on outside tap */}
      {recentDropdownVisible && recentSearches.length > 0 && (
        <TouchableOpacity style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 899 }}
          onPress={() => setRecentDropdownVisible(false)} activeOpacity={1}
          disabled={isSearching} // ✅ Disable overlay interactions while searching
        />
      )}

      {/* 🔹 Flexible-height dropdown */}
      {recentDropdownVisible && recentSearches.length > 0 && (
        <View style={{
          position: "absolute", top: "100%", left: "70%", transform: [{ translateX: -100 }],
          backgroundColor: "rgba(255,255,255,0.95)", borderRadius: 12, paddingVertical: 6, paddingHorizontal: 10,
          borderWidth: 1, borderColor: "#e0e0e0", elevation: 8, zIndex: 900,
          minWidth: 220, maxWidth: 320, minHeight: 40, maxHeight: 300,
          pointerEvents: isSearching ? "none" : "auto" // ✅ Disable dropdown while searching
        }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 6, borderBottomWidth: 1, borderColor: "#f0f0f0", marginBottom: 4 }}>
            <Text style={{ fontWeight: "600", fontSize: 15 }}>Recent searches</Text>
            <TouchableOpacity onPress={() => { clearRecentSearches(); }} disabled={isSearching}>
              <Text style={{ color: isSearching ? "#ccc" : "#2874F0", fontSize: 14 }}>Clear all</Text>
            </TouchableOpacity>
          </View>
          <View style={{ maxHeight: 240 }}>
            {recentSearches.map((term, idx) => (
              <TouchableOpacity key={`recent-${idx}`}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7, paddingHorizontal: 4, borderRadius: 6 }}
                onPress={() => { if (!isSearching) { fetchRecentNews(term); setRecentDropdownVisible(false); } }}
                activeOpacity={0.85} disabled={isSearching}
              >
                <Text style={{ flex: 1, fontSize: 14, lineHeight: 18, color: isSearching ? '#999' : '#1a1a1a' }} numberOfLines={2}>{term}</Text>
                <TouchableOpacity
                  onPress={async (e) => { if (isSearching) return; e.stopPropagation?.(); const newArr = recentSearches.filter(t => t !== term); setRecentSearches(newArr); await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(newArr)); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} disabled={isSearching}
                >
                  <Text style={{ color: isSearching ? "#ccc" : "#888", fontSize: 16, marginLeft: 6 }}>✕</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* File Dropdown */}
      {fileDropdownVisible && (
        <Animated.View style={{ position: "absolute", left: 10, top: 60, backgroundColor: "#fff", borderRadius: 8, elevation: 10, zIndex: 1000, padding: 10, opacity: fadeFileAnim, pointerEvents: isSearching ? "none" : "auto" /* ✅ Disable while searching */ }}>
          <TouchableOpacity onPress={pickImageToInput} disabled={isSearching}>
            <Text style={{ paddingVertical: 2, paddingHorizontal: 2, fontSize: 14, color: isSearching ? "#ccc" : "#2874F0" }}>🖼️ Pick Image</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Image Preview Modal */}
      {expandedImage && (
        <Modal transparent animationType="fade">
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", alignItems: "center" }}>
            <View style={{ position: "relative", justifyContent: "center", alignItems: "center" }}>
              <Image source={{ uri: expandedImage }} style={{ width: 300, height: 300, borderRadius: 12 }} resizeMode="contain" />
              <TouchableOpacity onPress={() => setExpandedImage(null)} style={{ position: "absolute", top: -20, right: -20, backgroundColor: "rgba(0,0,0,0.7)", padding: 8, borderRadius: 20 }}>
                <Text style={{ color: "#fff", fontSize: 16 }}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}