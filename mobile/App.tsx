import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
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

import { useCameraStream } from './src/useCameraStream';

const STORAGE_KEY_SERVER = 'phonewebcam.serverUrl';

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

export default function App() {
  useKeepAwake();
  const [serverUrl, setServerUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const { status, errorMessage, localStream, connect, disconnect, switchCamera } =
    useCameraStream();

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY_SERVER).then((saved) => {
      if (saved) setServerUrl(saved);
    });
  }, []);

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
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <CameraView
          style={styles.preview}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.controls}>
          <Text style={styles.status}>Point the camera at the QR code shown on the PC app</Text>
          <Pressable style={styles.buttonSecondary} onPress={() => setScanning(false)}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.controls}>
        {!isActive && (
          <Pressable style={styles.button} onPress={handleScanPress}>
            <Text style={styles.buttonText}>Scan QR to connect</Text>
          </Pressable>
        )}

        {!isActive && !showManualEntry && (
          <Pressable onPress={() => setShowManualEntry(true)}>
            <Text style={styles.link}>Enter address manually</Text>
          </Pressable>
        )}

        {(showManualEntry || isActive) && (
          <>
            <Text style={styles.label}>PC address (shown on PC app)</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              editable={!isActive}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://192.168.1.42:8765"
              placeholderTextColor="#888"
            />

            <Text style={styles.label}>Room code (shown on PC)</Text>
            <TextInput
              style={styles.input}
              value={roomCode}
              onChangeText={setRoomCode}
              editable={!isActive}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
              placeholderTextColor="#888"
            />

            <View style={styles.row}>
              <Pressable style={[styles.button, isActive && styles.buttonDanger]} onPress={handleConnectPress}>
                <Text style={styles.buttonText}>{isActive ? 'Disconnect' : 'Connect'}</Text>
              </Pressable>
              <Pressable style={styles.buttonSecondary} onPress={switchCamera}>
                <Text style={styles.buttonText}>Flip camera</Text>
              </Pressable>
            </View>
          </>
        )}

        <Text style={styles.status}>{statusText(status, errorMessage)}</Text>
      </View>

      {localStream ? (
        <RTCView streamURL={localStream.toURL()} style={styles.preview} objectFit="cover" mirror />
      ) : (
        <View style={[styles.preview, styles.previewPlaceholder]}>
          <Text style={styles.placeholderText}>Camera preview appears here</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function statusText(status: string, errorMessage: string | null) {
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
      return `Error: ${errorMessage ?? 'unknown'}`;
    default:
      return '';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  preview: { flex: 1 },
  previewPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  placeholderText: { color: '#666' },
  controls: { padding: 16, backgroundColor: '#111' },
  label: { color: '#aaa', fontSize: 12, marginTop: 8 },
  input: {
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 4,
  },
  status: { color: '#8f8', marginTop: 12, textAlign: 'center' },
  link: { color: '#6cf', textAlign: 'center', marginTop: 12, textDecorationLine: 'underline' },
  row: { flexDirection: 'row', gap: 12, marginTop: 12 },
  button: { flex: 1, backgroundColor: '#2a6', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonDanger: { backgroundColor: '#a33' },
  buttonSecondary: { flex: 1, backgroundColor: '#333', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
