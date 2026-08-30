import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useKeepAwake } from 'expo-keep-awake';
import * as Battery from 'expo-battery';
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';

import appConfig from './app.json';
import { useCameraStream, type Status } from './src/useCameraStream';

const STORAGE_KEY_SERVER = 'phonewebcam.serverUrl';

const colors = {
  bgDeep: '#05070d',
  bgPanel: '#0b1020',
  bgPanelAlt: '#0e1526',
  line: '#182036',
  text: '#eef1f8',
  textMuted: '#9aa3b8',
  textFaint: '#5c6478',
  blue: '#2f6fed',
  cyan: '#22d3ee',
  green: '#34d399',
  amber: '#f5a524',
  danger: '#ef4444',
  dangerDark: '#b91c1c',
};

type QrPayload = { s: string; c: string };

function parseQrPayload(data: string): QrPayload | null {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed.s === 'string' && typeof parsed.c === 'string') {
      return { s: parsed.s, c: parsed.c };
    }
  } catch {
    // not our QR format
  }
  return null;
}

function statusText(status: Status, errorMessage: string | null) {
  switch (status) {
    case 'idle':
      return 'Not connected';
    case 'connecting':
      return 'Connecting…';
    case 'waiting-for-answer':
      return 'Waiting for PC to accept…';
    case 'connected':
      return 'Streaming to PC';
    case 'ended':
      return 'Disconnected';
    case 'error':
      return errorMessage ?? 'Unknown error';
    default:
      return '';
  }
}

function statusColor(status: Status) {
  switch (status) {
    case 'connected':
      return colors.green;
    case 'connecting':
    case 'waiting-for-answer':
      return colors.amber;
    case 'error':
      return colors.danger;
    default:
      return colors.textFaint;
  }
}

function formatElapsed(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  useKeepAwake();
  const [stage, setStage] = useState<'home' | 'connect'>('home');
  const [serverUrl, setServerUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [addressFocused, setAddressFocused] = useState(false);
  const [codeFocused, setCodeFocused] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [videoInfo, setVideoInfo] = useState<{ width?: number; height?: number; frameRate?: number } | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const {
    status,
    errorMessage,
    localStream,
    isMuted,
    uploadKbps,
    latencyMs,
    connect,
    disconnect,
    switchCamera,
    toggleMute,
  } = useCameraStream();

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY_SERVER).then((saved) => {
      if (saved) setServerUrl(saved);
    });
  }, []);

  useEffect(() => {
    let subscription: { remove: () => void } | undefined;
    Battery.getBatteryLevelAsync()
      .then(setBatteryLevel)
      .catch(() => {});
    subscription = Battery.addBatteryLevelListener(({ batteryLevel: level }) => setBatteryLevel(level));
    return () => subscription?.remove();
  }, []);

  useEffect(() => {
    if (status !== 'connected') {
      setElapsedSeconds(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (!localStream) {
      setVideoInfo(null);
      return;
    }
    const track = localStream.getVideoTracks()[0] as any;
    const settings = track?.getSettings?.();
    if (settings) {
      setVideoInfo({ width: settings.width, height: settings.height, frameRate: settings.frameRate });
    }
  }, [localStream]);

  const isActive = status === 'connecting' || status === 'waiting-for-answer' || status === 'connected';

  const startConnection = async (address: string, code: string) => {
    setServerUrl(address);
    setRoomCode(code);
    await AsyncStorage.setItem(STORAGE_KEY_SERVER, address);
    connect(address, code.trim());
  };

  const handleConnectPress = async () => {
    if (isActive) {
      disconnect();
      return;
    }
    await startConnection(serverUrl, roomCode);
  };

  const handleScanPress = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    setScanning(true);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (!scanning) return;
    const payload = parseQrPayload(data);
    if (!payload) return;
    setScanning(false);
    startConnection(payload.s, payload.c);
  };

  const handleHelpPress = () => {
    Alert.alert(
      'Establish Link',
      'Both devices must be on the same Wi-Fi network. Get the address and code from the PC app window, or tap "Scan PC\'s QR Code" and point this camera at it.'
    );
  };

  if (scanning) {
    return (
      <View style={styles.safeDark}>
        <StatusBar barStyle="light-content" />
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <SafeAreaView style={styles.scanOverlayTop}>
          <Pressable onPress={() => setScanning(false)} style={styles.iconBtnFloating}>
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </Pressable>
        </SafeAreaView>
        <View style={styles.reticleWrap} pointerEvents="none">
          <View style={styles.reticle}>
            <View style={[styles.reticleCorner, styles.reticleTL]} />
            <View style={[styles.reticleCorner, styles.reticleTR]} />
            <View style={[styles.reticleCorner, styles.reticleBL]} />
            <View style={[styles.reticleCorner, styles.reticleBR]} />
          </View>
        </View>
        <SafeAreaView style={styles.scanOverlayBottom}>
          <Text style={styles.scanHint}>Point the camera at the QR code shown on the PC app</Text>
        </SafeAreaView>
      </View>
    );
  }

  if (status === 'connected') {
    return (
      <SafeAreaView style={styles.safeDark}>
        <StatusBar barStyle="light-content" />
        <View style={styles.liveTopBar}>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
          <View style={styles.liveIpRow}>
            <Ionicons name="link-outline" size={12} color={colors.textFaint} />
            <Text style={styles.liveIpText}>{serverUrl.replace('ws://', '')}</Text>
          </View>
        </View>

        <View style={styles.liveVideoWrap}>
          {localStream && (
            <RTCView streamURL={localStream.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
          )}
          {videoInfo?.width && (
            <View style={[styles.videoHudChip, styles.videoHudTopLeft]}>
              <Text style={styles.videoHudTextCyan}>
                {videoInfo.width}×{videoInfo.height} · {Math.round(videoInfo.frameRate ?? 0)}fps
              </Text>
            </View>
          )}
          <View style={[styles.videoHudChip, styles.videoHudTopRight]}>
            <Text style={styles.videoHudText}>{uploadKbps != null ? (uploadKbps / 1000).toFixed(1) : '—'} Mbps</Text>
          </View>
          <View style={styles.videoRecRow}>
            <View style={styles.recDot} />
            <Text style={styles.videoHudText}>{formatElapsed(elapsedSeconds)}</Text>
          </View>
        </View>

        <View style={styles.liveStatsRow}>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>LATENCY</Text>
            <Text style={[styles.statValue, { color: colors.cyan }]}>
              {latencyMs != null ? `${latencyMs}ms` : '—'}
            </Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>BATTERY</Text>
            <Text style={[styles.statValue, { color: colors.green }]}>
              {batteryLevel != null ? `${Math.round(batteryLevel * 100)}%` : '—'}
            </Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>PROTOCOL</Text>
            <Text style={styles.statValue}>WebRTC</Text>
          </View>
        </View>

        <View style={styles.liveControls}>
          <View style={styles.controlItem}>
            <Pressable style={styles.controlCircle} onPress={switchCamera}>
              <Ionicons name="camera-reverse-outline" size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.controlLabel}>Flip</Text>
          </View>
          <View style={styles.controlItem}>
            <Pressable
              style={[styles.controlCircle, isMuted && styles.controlCircleActive]}
              onPress={toggleMute}
            >
              <Ionicons name={isMuted ? 'mic-off-outline' : 'mic-outline'} size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.controlLabel}>{isMuted ? 'Muted' : 'Mute Mic'}</Text>
          </View>
          <View style={styles.controlItem}>
            <Pressable style={[styles.controlCircle, styles.controlCircleStop]} onPress={disconnect}>
              <Ionicons name="stop-circle-outline" size={20} color={colors.danger} />
            </Pressable>
            <Text style={[styles.controlLabel, { color: colors.danger }]}>Stop</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (stage === 'connect') {
    return (
      <SafeAreaView style={styles.safeDark}>
        <StatusBar barStyle="light-content" />
        <View style={styles.connectHeader}>
          <Pressable
            onPress={() => {
              if (isActive) disconnect();
              setStage('home');
            }}
            style={styles.iconBtn}
          >
            <Ionicons name="arrow-back" size={20} color={colors.text} />
          </Pressable>
          <Text style={styles.connectTitle}>Establish Link</Text>
          <Pressable onPress={handleHelpPress} style={styles.iconBtn}>
            <Ionicons name="help-circle-outline" size={20} color={colors.textMuted} />
          </Pressable>
        </View>

        <View style={styles.connectBody}>
          <View style={styles.fieldHeaderRow}>
            <Text style={styles.fieldLabel}>PC ADDRESS</Text>
            <Text style={styles.fieldRequired}>REQUIRED</Text>
          </View>
          <View style={[styles.inputWrap, addressFocused && styles.inputWrapFocused]}>
            <Ionicons name="server-outline" size={16} color={colors.cyan} />
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              editable={!isActive}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://192.168.1.42:8765"
              placeholderTextColor={colors.textFaint}
            />
          </View>

          <View style={[styles.fieldHeaderRow, { marginTop: 20 }]}>
            <Text style={styles.fieldLabel}>CONNECTION CODE</Text>
            <Text style={styles.fieldHint}>6 DIGITS</Text>
          </View>
          <View style={[styles.inputWrap, codeFocused && styles.inputWrapFocused]}>
            <Ionicons name="lock-closed-outline" size={16} color={colors.cyan} />
            <TextInput
              style={styles.input}
              value={roomCode}
              onChangeText={setRoomCode}
              editable={!isActive}
              onFocus={() => setCodeFocused(true)}
              onBlur={() => setCodeFocused(false)}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="Code (e.g. 582490)"
              placeholderTextColor={colors.textFaint}
            />
          </View>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable style={styles.qrCard} onPress={handleScanPress} disabled={isActive}>
            <View style={styles.qrIconRing}>
              <Ionicons name="qr-code-outline" size={22} color={colors.cyan} />
            </View>
            <Text style={styles.qrCardTitle}>Scan PC's QR Code</Text>
            <Text style={styles.qrCardSubtitle}>Point your camera at the QR code shown on the PC app</Text>
          </Pressable>
        </View>

        <View style={styles.connectFooter}>
          <Text style={[styles.footerStatus, { color: statusColor(status) }]}>
            {statusText(status, errorMessage)}
          </Text>
          <Pressable onPress={handleConnectPress}>
            <LinearGradient
              colors={isActive ? [colors.dangerDark, colors.danger] : [colors.blue, colors.cyan]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.primaryBtn, styles.primaryBtnGlow]}
            >
              <Ionicons name={isActive ? 'close' : 'wifi'} size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>{isActive ? 'Cancel' : 'Connect Live'}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeDark}>
      <StatusBar barStyle="light-content" />
      <View style={styles.homeWrap}>
        <View style={styles.logoGlow}>
          <View style={styles.logoOuterRing}>
            <View style={styles.logoInnerRing}>
              <View style={styles.logoDot} />
            </View>
          </View>
        </View>

        <Text style={styles.metaLine}>V{appConfig.expo.version} · WIRELESS</Text>
        <Text style={styles.appTitle}>Phone Webcam</Text>
        <Text style={styles.appSubtitle}>Turn this phone into a wireless webcam for your PC</Text>

        <View style={styles.statusCard}>
          <View style={styles.statusCardLeft}>
            <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
            <Text style={styles.statusCardText}>{statusText(status, errorMessage)}</Text>
          </View>
          <View style={styles.statusCardDivider} />
          <Text style={styles.statusCardMeta}>LAN ONLY</Text>
        </View>
      </View>

      <View style={styles.homeFooter}>
        <Pressable onPress={() => setStage('connect')}>
          <LinearGradient
            colors={[colors.blue, colors.cyan]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.primaryBtn, styles.primaryBtnGlow]}
          >
            <Ionicons name="wifi" size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>Get Connected</Text>
          </LinearGradient>
        </Pressable>
        <View style={styles.footerCaptionRow}>
          <Ionicons name="lock-closed" size={11} color={colors.textFaint} />
          <Text style={styles.footerCaption}>Encrypted peer-to-peer (WebRTC)</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeDark: { flex: 1, backgroundColor: colors.bgDeep },

  // Home
  homeWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  logoGlow: {
    shadowColor: colors.cyan,
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  logoOuterRing: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 1.5,
    borderColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoInnerRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.blue,
    shadowColor: colors.blue,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  metaLine: {
    marginTop: 22,
    color: colors.cyan,
    fontSize: 11,
    letterSpacing: 1.5,
    fontFamily: 'Menlo',
  },
  appTitle: { marginTop: 10, color: colors.text, fontSize: 28, fontWeight: '800' },
  appSubtitle: {
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 260,
  },
  statusCard: {
    marginTop: 40,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  statusCardLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  statusCardText: { color: colors.text, fontSize: 12 },
  statusCardDivider: { width: 1, height: 16, backgroundColor: colors.line, marginHorizontal: 12 },
  statusCardMeta: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'Menlo' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  homeFooter: { paddingHorizontal: 24, paddingBottom: 20, gap: 12 },
  footerCaptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerCaption: { color: colors.textFaint, fontSize: 11.5 },

  // Shared primary button
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 15,
  },
  primaryBtnGlow: {
    shadowColor: colors.cyan,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },

  // Connect screen
  connectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  connectTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  connectBody: { flex: 1, paddingHorizontal: 24, paddingTop: 28 },
  fieldHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  fieldLabel: { color: colors.textMuted, fontSize: 10.5, letterSpacing: 1, fontFamily: 'Menlo' },
  fieldRequired: { color: colors.cyan, fontSize: 10, letterSpacing: 1, fontFamily: 'Menlo' },
  fieldHint: { color: colors.textFaint, fontSize: 10, letterSpacing: 1, fontFamily: 'Menlo' },
  inputWrap: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputWrapFocused: {
    borderColor: colors.blue,
    shadowColor: colors.blue,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  input: { flex: 1, color: colors.text, fontSize: 14, fontFamily: 'Menlo' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 22 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { color: colors.textFaint, fontSize: 11, letterSpacing: 1 },
  qrCard: {
    borderWidth: 1,
    borderColor: colors.line,
    borderStyle: 'dashed',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    backgroundColor: colors.bgPanelAlt,
  },
  qrIconRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  qrCardTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  qrCardSubtitle: { color: colors.textFaint, fontSize: 11.5, marginTop: 4, textAlign: 'center' },
  connectFooter: { paddingHorizontal: 24, paddingBottom: 20, gap: 10 },
  footerStatus: { textAlign: 'center', fontSize: 12 },

  // Scanning overlay
  scanOverlayTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, paddingTop: 8 },
  scanOverlayBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 32, paddingBottom: 28 },
  iconBtnFloating: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanHint: { color: colors.text, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  reticleWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  reticle: { width: 200, height: 200 },
  reticleCorner: { position: 'absolute', width: 30, height: 30, borderColor: colors.cyan },
  reticleTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
  reticleTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
  reticleBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
  reticleBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },

  // Live screen
  liveTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  liveBadgeText: { color: colors.green, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  liveIpRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveIpText: { color: colors.textFaint, fontSize: 11.5, fontFamily: 'Menlo' },
  liveVideoWrap: { flex: 1, marginHorizontal: 12, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  videoHudChip: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  videoHudTopLeft: { top: 10, left: 10 },
  videoHudTopRight: { top: 10, right: 10 },
  videoHudText: { color: colors.textMuted, fontSize: 10.5, fontFamily: 'Menlo' },
  videoHudTextCyan: { color: colors.cyan, fontSize: 10.5, fontFamily: 'Menlo', fontWeight: '700' },
  videoRecRow: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  recDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
  liveStatsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, marginTop: 12 },
  statChip: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  statLabel: { color: colors.textFaint, fontSize: 9, letterSpacing: 1, fontFamily: 'Menlo' },
  statValue: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginTop: 2, fontFamily: 'Menlo' },
  liveControls: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 20 },
  controlItem: { alignItems: 'center', gap: 6 },
  controlCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlCircleActive: { borderColor: colors.amber },
  controlCircleStop: { borderColor: colors.danger },
  controlLabel: { color: colors.textMuted, fontSize: 10.5 },
});
