// LoginScreen/LoginScreen.js
import React, { useState, useRef, useEffect } from "react";
import { View, Text, TouchableOpacity, Alert, KeyboardAvoidingView, Platform, Animated, StatusBar, } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context"; 
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../supabaseClient";
import Input from "../ui/Input";
import Button from "../ui/Button";
import Logo from "../ui/Logo";

const PENDING_SEARCH_KEY = "pending_search_v1";

export default function LoginScreen({ navigation }) {
  const [mode, setMode] = useState("email"); // 'email' | 'phone'
  const [value, setValue] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);

  // 🔹 NEW: Shared restore function for both Skip and Login flows
  const restorePendingSearch = async () => {
    const pendingJson = await AsyncStorage.getItem(PENDING_SEARCH_KEY);
    let pendingSearch = null;
    if (pendingJson) {
      try {
        pendingSearch = JSON.parse(pendingJson);
        // 5-minute expiry check
        if (Date.now() - pendingSearch.timestamp > 5 * 60 * 1000) {
          pendingSearch = null;
        }
      } catch (e) { /* ignore */ }
    }

    if (pendingSearch) {
      await AsyncStorage.removeItem(PENDING_SEARCH_KEY);
      navigation.reset({
        index: 0,
        routes: [{
          name: "Welcome",
          params: {
            restoreSearch: {
              topic: pendingSearch.topic || "",
              attachedImages: pendingSearch.attachedImages || [],
            },
          },
        }],
      });
    } else {
      navigation.reset({
        index: 0,
        routes: [{ name: "Welcome" }],
      });
    }
  };

  const handleContinue = async () => {
    try {
      setLoading(true);

      // ✅ Proper phone sanitization (keep +)
      let cleanValue = value.trim().replace(/[^+\d]/g, "");
      if (mode === "phone") {
        if (cleanValue.length === 10 && /^[6-9]/.test(cleanValue)) {
          cleanValue = "+91" + cleanValue;
        } else if (cleanValue.length === 11 && cleanValue.startsWith("0") && /^[6-9]/.test(cleanValue.slice(1))) {
          cleanValue = "+91" + cleanValue.slice(1);
        } else if (cleanValue.length === 12 && cleanValue.startsWith("91") && /^[6-9]/.test(cleanValue.slice(2))) {
          cleanValue = "+91" + cleanValue.slice(2);
        } else if (value.trim().startsWith("+91") && cleanValue.length >= 10) {
          // Fallback: extract last 10 digits if +91 present
          const last10 = cleanValue.slice(-10);
          if (/^[6-9]/.test(last10)) {
            cleanValue = "+91" + last10;
          } else {
            throw new Error("Invalid Indian mobile number format.");
          }
        } else {
          throw new Error("Please enter a valid 10-digit Indian mobile number (e.g., 7099552365).");
        }
      }

      if (!otpSent) {
        if (mode === "email") {
          setMode("phone");
          setValue("");
          return;
        }

        // Step 2: Send OTP
        const { error } = await supabase.auth.signInWithOtp({ phone: cleanValue });
        if (error) throw error;

        setOtpSent(true);
        Alert.alert("OTP Sent", "Please check your phone for the code.");
      } else {
        // Step 3: Verify OTP
        const { error } = await supabase.auth.verifyOtp({
          phone: cleanValue,
          token: otp,
          type: "sms",
        });
        if (error) throw error;

        // ✅ Save login flag
        await AsyncStorage.setItem("hasLoggedIn", "true");

        // 🔍 Restore pending search ONLY after login
        await restorePendingSearch(); // ✅ Reuse shared restore function
      }
    } catch (err) {
      Alert.alert("Error", err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const isButtonDisabled = () => {
    if (loading) return true;
    if (!otpSent) return value.trim() === "";
    return otp.trim().length < 4;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
      {/* Status bar styling */}
      <StatusBar barStyle="light-content" backgroundColor="#2196F3" />

      {/* 🔷 Fixed Top Header */}
      <View
        style={{ height: "45%", backgroundColor: "#2196F3", justifyContent: "center", alignItems: "center", position: "relative", }}
      >
        <TouchableOpacity
          onPress={restorePendingSearch} // 🔑 Skip button now uses restore function
          style={{ position: "absolute", top: 20, right: 20 }}
        >
          <Text style={{ color: "#fff", fontSize: 16 }}>Skip</Text>
        </TouchableOpacity>
        <Logo />
      </View>

      {/* 🌐 Keyboard-safe, flicker-free content */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 60 : 0}
      >
        <Animated.View
          style={{ flex: 1, paddingHorizontal: 20, justifyContent: "center", opacity: fadeAnim, }}
        >
          <Text
            style={{ fontSize: 18, fontWeight: "600", marginBottom: 30, textAlign: "center", }}
          >
            {otpSent ? "Enter OTP to continue" : "Login to get started"}
          </Text>

          {!otpSent ? (
            <Input
              placeholder={mode === "phone" ? "Enter phone number" : "Enter email ID"}
              value={value}
              onChangeText={setValue}
              keyboardType={mode === "phone" ? "phone-pad" : "email-address"}
            />
          ) : (
            <Input
              placeholder="Enter OTP"
              value={otp}
              onChangeText={setOtp}
              keyboardType="number-pad"
              maxLength={6}
            />
          )}

          {!otpSent && (
            <TouchableOpacity
              onPress={() => setMode(mode === "phone" ? "email" : "phone")}
              style={{ alignSelf: "flex-end", marginTop: 8 }}
            >
              <Text style={{ color: "#2874F0" }}>
                {mode === "phone" ? "Use Email ID" : "Use Phone Number"}
              </Text>
            </TouchableOpacity>
          )}

          <View style={{ marginTop: 40 }}>
            <Button
              title={loading ? "Please wait..." : "Continue"}
              onPress={handleContinue}
              disabled={isButtonDisabled()}
            />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}