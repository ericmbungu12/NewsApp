import React from "react";
import { View, Image, StyleSheet, Text, Dimensions } from "react-native";

const { width } = Dimensions.get("window");

export default function Logo({
  scale = 0.35, title = "DataLoom", centered = true, showTitle = true,
}) {
  const logoSize = width * scale;

  // Dynamic container alignment
  const containerStyle = {
    justifyContent: centered ? "center" : "flex-start",
    alignItems: centered ? "center" : "flex-start",
  };

  return (
    <View style={[styles.container, containerStyle]}>
      <Image
        source={require("../../assets/logo.png")}
        style={[styles.logo, { width: logoSize, height: logoSize }]}
        resizeMode="contain"
      />
      {showTitle && title !== "" && (
        <Text style={[styles.title, { textAlign: centered ? "center" : "left" }]}>
          {title}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 20 }, // base spacing
  logo: { width: 100, height: 100 },
  title: { marginTop: 10, fontSize: 24, fontWeight: "bold", color: "#fff" },
});
