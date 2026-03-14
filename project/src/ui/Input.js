//components/Input.js
import React, { useState } from "react";
import { View, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import Icon from "react-native-vector-icons/Ionicons";

export default function Input({ placeholder, value, onChangeText, isPassword }) {
  const [show, setShow] = useState(false);

  return (
    <View style={styles.container}>
      <TextInput
        placeholder={placeholder} placeholderTextColor={"#666"} value={value} onChangeText={onChangeText} secureTextEntry={isPassword && !show} style={styles.input} />
      {isPassword && (
        <TouchableOpacity onPress={() => setShow(!show)}>
          <Icon name={show ? "eye" : "eye-off"} size={22} color="#000" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ 
  container: { flexDirection: "row", alignItems: "center", width: "90%", borderWidth: 1, borderColor: "#ccc", 
    borderRadius: 10, backgroundColor: "#fff", marginVertical: 8, paddingHorizontal: 10,
  },
  input: {
    flex: 1, padding: 10, color:"#000"
  },
});
