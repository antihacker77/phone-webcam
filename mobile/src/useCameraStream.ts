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

export type Resolution = { width: number; height: number };

export const DEFAULT_RESOLUTION: Resolution = { width: 1920, height: 1080 };

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
    async (serverUrl: string, roomCode: string, resolution: Resolution = DEFAULT_RESOLUTION) => {
      setErrorMessage(null);
      setStatus('connecting');

      let stream: MediaStream;
      try {
        stream = (await mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode,
            width: { ideal: resolution.width },
            height: { ideal: resolution.height },
          },
        })) as MediaStream;
      } catch (err: any) {
        setStatus('error');
        setErrorMessage(`Camera access failed: ${err?.message ?? err}`);
        return;
      }
      setLocalStream(stream);

      // Everything below is synchronous setup (WebSocket/RTCPeerConnection
      // construction) followed by event handlers that run later. Without
      // this try/catch, a single synchronous throw here — e.g.
      // `new WebSocket(serverUrl)` on a malformed address typed into the
      // manual-entry field — left status stuck on 'connecting' forever with
      // no error shown, since nothing after this point would ever run to
      // move it along. Stuck 'connecting' also means `isActive` stays true,
      // which disables both text inputs (`editable={!isActive}`) — from the
      // user's side, "the app won't let me type in the code field" with no
      // obvious cause or recovery.
      try {
        // Same-network only: no STUN/TURN needed, WebRTC connects via local
        // host candidates directly between the phone and the PC.
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const ws = new WebSocket(serverUrl);
        wsRef.current = ws;

        // Set once the WebRTC handshake completes, so onclose/onerror below
        // can tell "session ended after streaming" from "never connected"
        // without reading stale React state from this closure.
        let hasConnected = false;

        ws.onerror = () => {
          if (pcRef.current === null) return; // already torn down by cleanup()
          cleanup();
          setStatus('error');
          setErrorMessage('Could not reach the PC app — check the address and that both are on the same Wi-Fi.');
        };

        ws.onclose = () => {
          if (pcRef.current === null) return; // already torn down (disconnect(), onerror, or the error message below)
          const wasConnected = hasConnected;
          cleanup();
          setStatus(wasConnected ? 'ended' : 'error');
          if (!wasConnected) {
            setErrorMessage('Connection closed before it was established — the PC app may be busy or the code may be wrong.');
          }
        };

        ws.onmessage = async (event) => {
          try {
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
              hasConnected = true;
              setStatus('connected');
              return;
            }

            if (msg.type === 'error') {
              setStatus('error');
              setErrorMessage(msg.message ?? 'Unknown error from PC app');
              cleanup();
            }
          } catch (err: any) {
            // A malformed message or a WebRTC call throwing here (e.g.
            // createOffer/setRemoteDescription) is an async callback, not
            // caught by the outer try/catch — same "stuck forever" risk.
            cleanup();
            setStatus('error');
            setErrorMessage(`Signaling error: ${err?.message ?? err}`);
          }
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'join', code: roomCode }));
        };
      } catch (err: any) {
        cleanup();
        setStatus('error');
        setErrorMessage(`Could not start the connection: ${err?.message ?? err}`);
      }
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
