import React, { Children } from "react";
import {
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  StyleSheet,
  TouchableWithoutFeedback,
  Keyboard,
  View,
} from "react-native";
import { FlatList, SectionList, VirtualizedList } from "react-native";

/**
 * A universal wrapper that:
 * ✅ Handles keyboard avoiding
 * ✅ Dismisses keyboard on outside tap
 * ✅ Avoids nesting VirtualizedLists inside ScrollView automatically
 */
export default function ScreenWrapper({
  children,
  scrollViewStyle,
  contentContainerStyle,
  scrollEnabled = true,
}) {
  // Detect if children include a list-based component
  const containsVirtualizedList = Children.toArray(children).some(
    (child) =>
      child?.type === FlatList ||
      child?.type === SectionList ||
      child?.type === VirtualizedList
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={80}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        {containsVirtualizedList ? (
          // 🧠 If there’s a FlatList/SectionList, just render normally (no ScrollView)
          <View style={[styles.inner, contentContainerStyle]}>{children}</View>
        ) : (
          // ✅ Otherwise wrap content in a ScrollView
          <ScrollView
            style={[styles.scrollView, scrollViewStyle]}
            contentContainerStyle={[styles.scroll, contentContainerStyle]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            scrollEnabled={scrollEnabled}
            bounces={false}
          >
            <View style={styles.inner}>{children}</View>
          </ScrollView>
        )}
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scrollView: { flex: 1 },
  scroll: { flexGrow: 1 },
  inner: { flex: 1 },
});
