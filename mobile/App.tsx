import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import {
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
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [videoInfo, setVideoInfo] = useState<{ width?: number; height?: number; frameRate?: number } | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const { status, errorMessage, localStream, connect, disconnect, switchCamera } =
    useCameraStream();

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY_SERVER).then((saved) => {
      if (saved) setServerUrl(saved);
    });
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
            <View style={styles.videoHudChip}>
              <Text style={styles.videoHudText}>
                {videoInfo.width}×{videoInfo.height} · {Math.round(videoInfo.frameRate ?? 0)}fps
              </Text>
            </View>
          )}
        </View>

        <View style={styles.liveStatsRow}>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>ELAPSED</Text>
            <Text style={styles.statValue}>{formatElapsed(elapsedSeconds)}</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>PROTOCOL</Text>
            <Text style={styles.statValue}>WebRTC</Text>
          </View>
        </View>

        <View style={styles.liveControls}>
          <Pressable style={styles.controlBtn} onPress={switchCamera}>
            <Ionicons name="camera-reverse-outline" size={22} color={colors.text} />
            <Text style={styles.controlBtnLabel}>Flip</Text>
          </Pressable>
          <Pressable style={styles.controlBtn} onPress={disconnect}>
            <Ionicons name="stop-circle-outline" size={22} color={colors.danger} />
            <Text style={[styles.controlBtnLabel, { color: colors.danger }]}>Stop</Text>
          </Pressable>
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
          <View style={styles.iconBtnSpacer} />
        </View>

        <View style={styles.connectBody}>
          <View style={styles.fieldHeaderRow}>
            <Text style={styles.fieldLabel}>PC ADDRESS</Text>
            <Text style={styles.fieldRequired}>REQUIRED</Text>
          </View>
          <View style={styles.inputWrap}>
            <Ionicons name="server-outline" size={16} color={colors.cyan} />
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              editable={!isActive}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://192.168.1.42:8765"
              placeholderTextColor={colors.textFaint}
            />
          </View>

          <Text style={[styles.fieldLabel, { marginTop: 20 }]}>CONNECTION CODE</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={16} color={colors.cyan} />
            <TextInput
              style={styles.input}
              value={roomCode}
              onChangeText={setRoomCode}
              editable={!isActive}
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
              style={styles.primaryBtn}
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
        <LinearGradient colors={[colors.blue, colors.cyan]} style={styles.logoRing}>
          <View style={styles.logoInner}>
            <Ionicons name="videocam" size={30} color={colors.cyan} />
          </View>
        </LinearGradient>

        <Text style={styles.metaLine}>V{appConfig.expo.version} · WIRELESS</Text>
        <Text style={styles.appTitle}>Phone Webcam</Text>
        <Text style={styles.appSubtitle}>Turn this phone into a wireless webcam for your PC</Text>

        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
          <Text style={styles.statusPillText}>{statusText(status, errorMessage)}</Text>
          <Text style={styles.statusPillMeta}>LAN ONLY</Text>
        </View>
      </View>

      <View style={styles.homeFooter}>
        <Pressable onPress={() => setStage('connect')}>
          <LinearGradient
            colors={[colors.blue, colors.cyan]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.primaryBtn}
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
  logoRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoInner: {
    width: '100%',
    height: '100%',
    borderRadius: 42,
    backgroundColor: colors.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaLine: {
    marginTop: 18,
    color: colors.cyan,
    fontSize: 11,
    letterSpacing: 1.5,
    fontFamily: 'Menlo',
  },
  appTitle: { marginTop: 8, color: colors.text, fontSize: 28, fontWeight: '800' },
  appSubtitle: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 260,
  },
  statusPill: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusPillText: { color: colors.text, fontSize: 12 },
  statusPillMeta: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'Menlo', marginLeft: 6 },
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
  iconBtnSpacer: { width: 36 },
  connectTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  connectBody: { flex: 1, paddingHorizontal: 24, paddingTop: 24 },
  fieldHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  fieldLabel: { color: colors.textMuted, fontSize: 10.5, letterSpacing: 1, fontFamily: 'Menlo' },
  fieldRequired: { color: colors.cyan, fontSize: 10, letterSpacing: 1, fontFamily: 'Menlo' },
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
    top: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  videoHudText: { color: colors.text, fontSize: 10.5, fontFamily: 'Menlo' },
  liveStatsRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, marginTop: 12 },
  statChip: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  statLabel: { color: colors.textFaint, fontSize: 9.5, letterSpacing: 1, fontFamily: 'Menlo' },
  statValue: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 2, fontFamily: 'Menlo' },
  liveControls: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 16 },
  controlBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    paddingVertical: 12,
  },
  controlBtnLabel: { color: colors.text, fontSize: 11 },
});
