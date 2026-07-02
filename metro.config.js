// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow require()-ing TFLite model files as assets (react-native-fast-tflite).
config.resolver.assetExts.push('tflite');

module.exports = config;
