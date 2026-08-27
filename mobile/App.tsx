import AsyncStorage from '@react-native-async-storage/async-storage';
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

export default function App() {
  const [serverUrl, setServerUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const { status, errorMessage, localStream, connect, disconnect, switchCamera } =
    useCameraStream();

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY_SERVER).then((saved) => {
      if (saved) setServerUrl(saved);
    });
  }, []);

  const isActive = status === 'connecting' || status === 'waiting-for-answer' || status === 'connected';

  const handleConnectPress = async () => {
    if (isActive) {
      disconnect();
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEY_SERVER, serverUrl);
    connect(serverUrl, roomCode.trim());
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {localStream ? (
        <RTCView streamURL={localStream.toURL()} style={styles.preview} objectFit="cover" mirror />
      ) : (
        <View style={[styles.preview, styles.previewPlaceholder]}>
          <Text style={styles.placeholderText}>Camera preview appears here</Text>
        </View>
      )}

      <View style={styles.controls}>
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

        <Text style={styles.status}>{statusText(status, errorMessage)}</Text>

        <View style={styles.row}>
          <Pressable style={[styles.button, isActive && styles.buttonDanger]} onPress={handleConnectPress}>
            <Text style={styles.buttonText}>{isActive ? 'Disconnect' : 'Connect'}</Text>
          </Pressable>
          <Pressable style={styles.buttonSecondary} onPress={switchCamera}>
            <Text style={styles.buttonText}>Flip camera</Text>
          </Pressable>
        </View>
      </View>
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
  row: { flexDirection: 'row', gap: 12, marginTop: 12 },
  button: { flex: 1, backgroundColor: '#2a6', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonDanger: { backgroundColor: '#a33' },
  buttonSecondary: { flex: 1, backgroundColor: '#333', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
