import { useCallback, useRef, useState } from 'react';
import {
  MediaStream,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

export type Status =
  | 'idle'
  | 'connecting'
  | 'waiting-for-answer'
  | 'connected'
  | 'ended'
  | 'error';

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
  });
}

export function useCameraStream() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
  }, [localStream]);

  const connect = useCallback(
    async (serverUrl: string, roomCode: string) => {
      setErrorMessage(null);
      setStatus('connecting');

      let stream: MediaStream;
      try {
        stream = (await mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode },
        })) as MediaStream;
      } catch (err: any) {
        setStatus('error');
        setErrorMessage(`Camera access failed: ${err?.message ?? err}`);
        return;
      }
      setLocalStream(stream);

      // Same-network only: no STUN/TURN needed, WebRTC connects via local
      // host candidates directly between the phone and the PC.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const ws = new WebSocket(serverUrl);
      wsRef.current = ws;

      ws.onerror = () => {
        setStatus('error');
        setErrorMessage('Could not reach the PC app — check the address and that both are on the same Wi-Fi.');
      };

      ws.onclose = () => {
        setStatus((prev) => (prev === 'connected' ? 'ended' : prev));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'joined') {
          const offer = await pc.createOffer({});
          await pc.setLocalDescription(offer);
          await waitForIceGatheringComplete(pc);
          setStatus('waiting-for-answer');
          ws.send(
            JSON.stringify({
              type: 'offer',
              payload: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type },
            })
          );
          return;
        }

        if (msg.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
          setStatus('connected');
          return;
        }

        if (msg.type === 'error') {
          setStatus('error');
          setErrorMessage(msg.message ?? 'Unknown error from PC app');
          cleanup();
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', code: roomCode }));
      };
    },
    [facingMode, cleanup]
  );

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('idle');
  }, [cleanup]);

  const switchCamera = useCallback(() => {
    const videoTrack = localStream?.getVideoTracks()[0] as any;
    videoTrack?._switchCamera?.();
    setFacingMode((m) => (m === 'user' ? 'environment' : 'user'));
  }, [localStream]);

  return { status, errorMessage, localStream, connect, disconnect, switchCamera };
}
