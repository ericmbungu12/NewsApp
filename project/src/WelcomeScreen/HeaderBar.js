// WelcomeScreen/HeaderBar.js
import React, { useRef, useState, useEffect } from "react";
import { View, Text, TouchableOpacity, Image, Animated, ToastAndroid, Alert, Platform, PermissionsAndroid } from "react-native";
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import Logo from "../ui/Logo";

export default function HeaderBar({
  profileImage,
  setProfileImage,
  setProfileDropdownVisible,
  profileDropdownVisible,
  handleLogin,
  handleLogout,
}) {
  const fadeProfileAnim = useRef(new Animated.Value(0)).current;

  // Animate dropdown
  useEffect(() => {
    Animated.timing(fadeProfileAnim, {
      toValue: profileDropdownVisible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [profileDropdownVisible]);

  const handleImagePicker = () => {
    const options = {
      mediaType: 'photo',
      includeBase64: false,
      maxHeight: 2000,
      maxWidth: 2000,
    };

    launchImageLibrary(options, (response) => {
      if (response.didCancel) {
        console.log('User cancelled image picker');
      } else if (response.errorCode) {
        console.log('ImagePicker Error: ', response.errorMessage);
        ToastAndroid.show('Failed to pick image', ToastAndroid.SHORT);
      } else if (response.assets && response.assets.length > 0) {
        const selectedImage = response.assets[0].uri;
        setProfileImage(selectedImage);
        setProfileDropdownVisible(false);
        ToastAndroid.show('Profile image updated!', ToastAndroid.SHORT);
      }
    });
  };

  const handleCameraCapture = async () => {

    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA
      );

      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert("Permission required", "Please allow camera access.");
        return;
      }
    }

    const options = {
      mediaType: 'photo',
      includeBase64: false,
      maxHeight: 2000,
      maxWidth: 2000,
      saveToPhotos: true,
    };

    launchCamera(options, (response) => {
      if (response.didCancel) {
        console.log('User cancelled camera');
      } else if (response.errorCode) {
        console.log('Camera Error: ', response.errorMessage);
        ToastAndroid.show('Failed to capture image', ToastAndroid.SHORT);
      } else if (response.assets && response.assets.length > 0) {
        const capturedImage = response.assets[0].uri;
        setProfileImage(capturedImage);
        setProfileDropdownVisible(false);
        ToastAndroid.show('Profile image updated!', ToastAndroid.SHORT);
      }
    });
  };

return (
    <View style={{ paddingVertical: 10, paddingHorizontal: 10, backgroundColor: "#fff" }}>
      {/* Header row */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {/* Logo on left */}
        <Logo scale={0.15} centered={false} showTitle={false} />

        {/* Profile image on right */}
        <TouchableOpacity onPress={() => setProfileDropdownVisible(!profileDropdownVisible)}>
          <Image
            source={profileImage ? { uri: profileImage } : require("../../assets/default-profile.png")}
            style={{ width: 50, height: 50, borderRadius: 999, borderWidth: 1, borderColor: "#ccc" }}
          />
        </TouchableOpacity>
      </View>

      {/* Second row: Centered text */}
      <View style={{ alignItems: "center", marginTop: 10, marginBottom: 1 }}>
        <Text style={{ fontSize: 18, fontWeight: "bold", color: "#000" }}>
          Ask DataLoom, Know Better.
        </Text>
      </View>

      {/* Profile dropdown */}
      {profileDropdownVisible && (
        <Animated.View
          style={{
            position: "absolute", right: 60, top: 5, backgroundColor: "#fff", borderRadius: 8, elevation: 4, padding: 4,
            opacity: fadeProfileAnim,
          }}
        >
          <TouchableOpacity onPress={handleImagePicker} style={{ flexDirection: "row", alignItems: "center", padding: 4 }}>
            <Text style={{ fontSize: 12 }}>🖼️</Text>
            <Text style={{ color: "#2874F0", fontSize: 14, textDecorationLine: "underline", marginLeft: 4 }}>from Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleCameraCapture} style={{ flexDirection: "row", alignItems: "center", padding: 4 }}>
            <Text style={{ fontSize: 12 }}>📷</Text>
            <Text style={{ color: "#2874F0", fontSize: 14, textDecorationLine: "underline", marginLeft: 4 }}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleLogin} style={{ flexDirection: "row", alignItems: "center", padding: 4 }}>
            <Text style={{ fontSize: 12 }}>🔐</Text>
            <Text style={{ color: "#2874F0", fontSize: 14, textDecorationLine: "underline", marginLeft: 4 }}>Login</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleLogout} style={{ flexDirection: "row", alignItems: "center", padding: 4 }}>
            <Text style={{ fontSize: 12 }}>🚪</Text>
            <Text style={{ color: "#2874F0", fontSize: 14, textDecorationLine: "underline", marginLeft: 4 }}>Logout</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}


