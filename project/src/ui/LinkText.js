import React from "react";
import { Text, TouchableOpacity, StyleSheet } from "react-native";

export default function LinkText({ title, onPress }) {
  return (
    <TouchableOpacity onPress={onPress}>
      <Text style={styles.link}>{title}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  link: { color: "#007BFF", marginTop: 10, textAlign: "center" },
});
