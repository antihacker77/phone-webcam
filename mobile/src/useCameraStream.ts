import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [isMuted, setIsMuted] = useState(false);
  const [uploadKbps, setUploadKbps] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const lastVideoStatsRef = useRef<{ bytes: number; time: number } | null>(null);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setIsMuted(false);
  }, [localStream]);

  const connect = useCallback(
    async (serverUrl: string, roomCode: string) => {
      setErrorMessage(null);
      setStatus('connecting');

      let stream: MediaStream;
      try {
        stream = (await mediaDevices.getUserMedia({
          audio: true,
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

  const toggleMute = useCallback(() => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = isMuted;
    setIsMuted((m) => !m);
  }, [localStream, isMuted]);

  // Real upload bitrate + round-trip latency, sampled from the live WebRTC
  // connection — not simulated.
  useEffect(() => {
    if (status !== 'connected') {
      setUploadKbps(null);
      setLatencyMs(null);
      lastVideoStatsRef.current = null;
      return;
    }
    const id = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      let report: any;
      try {
        report = await pc.getStats();
      } catch {
        return;
      }
      report.forEach((stat: any) => {
        const kind = stat.kind ?? stat.mediaType;
        if (stat.type === 'outbound-rtp' && kind === 'video' && typeof stat.bytesSent === 'number') {
          const now = Date.now();
          const prev = lastVideoStatsRef.current;
          if (prev) {
            const deltaBytes = stat.bytesSent - prev.bytes;
            const deltaSec = (now - prev.time) / 1000;
            if (deltaSec > 0 && deltaBytes >= 0) {
              setUploadKbps(Math.round((deltaBytes * 8) / deltaSec / 1000));
            }
          }
          lastVideoStatsRef.current = { bytes: stat.bytesSent, time: now };
        }
        if (
          stat.type === 'candidate-pair' &&
          (stat.state === 'succeeded' || stat.nominated) &&
          typeof stat.currentRoundTripTime === 'number'
        ) {
          setLatencyMs(Math.round(stat.currentRoundTripTime * 1000));
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  return {
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
  };
}
