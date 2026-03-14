// components/Button.js
import React from "react";
import { TouchableOpacity, Text, StyleSheet } from "react-native";

export default function Button({ title, onPress }) {
  return (
    <TouchableOpacity style={styles.btn} onPress={onPress}>
      <Text style={styles.text}>{title}</Text>
    </TouchableOpacity>
  );
}


const styles = StyleSheet.create({
  btn: { width: "100%", padding: 15, backgroundColor: "#2196F3", borderRadius: 10, alignItems: "center", marginVertical: 10,
  },
  text: { color: "#fff", fontWeight: "bold" },
});



