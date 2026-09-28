// The app talks to the PC over plain ws:// on the local network (the PC app
// has no TLS certificate). Android blocks cleartext traffic in release
// builds by default — debug builds only get away with it because Expo's
// debug manifest re-enables it — so without this the release APK fails to
// reach the PC with "Could not reach the PC app".
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
