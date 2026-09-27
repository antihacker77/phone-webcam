"""Receive-side tuning of aiortc for a steady 1080p30 phone stream.

Import once, before any RTCPeerConnection is created — everything here
patches aiortc module state. Three independent fixes, each for a way the
stock library made the phone's frame rate collapse (30 -> 5 -> 1-2 fps)
while the resolution stayed put:

1. H264 at Level 5.2 instead of 3.1. Stock aiortc only advertises H264 with
   profile-level-id ...1f (Level 3.1), which can't carry 1080p — that's why
   the project was forced onto VP8, which iOS encodes in *software*. A
   software 1080p VP8 encode on a phone runs into libwebrtc's CPU-overuse
   adaptation, and with degradationPreference "maintain-resolution" that
   adaptation cuts frame rate instead, all the way down to its 2fps floor.
   Advertising Level 5.2 lets the phone use its hardware H264 encoder
   (VideoToolbox) at 1080p with essentially no CPU cost. The level is only
   an SDP ceiling on what the sender may produce; the decoder (FFmpeg) has
   no such limit. VP8 stays negotiable as a fallback.

2. A bigger video jitter buffer that gives up on a lost packet quickly.
   Stock capacity is 128 packets; a 1080p keyframe plus the start of the
   next frame can exceed that, so the keyframe gets truncated, a PLI asks
   for another keyframe, which is just as big — a freeze loop. Capacity is
   raised to 1024, and so that a packet that never arrives (NACK
   retransmission failed) can't stall the stream until 1024 packets pile up
   behind it, an incomplete frame is dropped once newer media is more than
   GAP_TIMEOUT_MS ahead of it, with a PLI to resync.

3. A floor under the REMB bandwidth estimate. aiortc's delay-based
   estimator reads ordinary Wi-Fi jitter as congestion and cuts its REMB
   multiplicatively; the phone obeys by starving its encoder, and under
   "maintain-resolution" a starved encoder drops frames. On a LAN the
   phone's own loss-based control (driven by our receiver reports) is a
   sufficient safety net, so REMB is kept from going below REMB_FLOOR_BPS —
   above libwebrtc's own 1080p default max (~2.5 Mbps), i.e. never the
   limiting factor.
"""

import copy

from aiortc import codecs as _codecs
from aiortc import rtcrtpreceiver as _receiver
from aiortc.jitterbuffer import JitterBuffer
from aiortc.rate import RemoteBitrateEstimator
from aiortc.rtcrtpparameters import RTCRtpCodecParameters

H264_LEVEL = "34"  # Level 5.2: 1080p60 and beyond
VIDEO_JITTER_CAPACITY = 1024
GAP_TIMEOUT_MS = 150
REMB_FLOOR_BPS = 8_000_000

_VIDEO_CLOCK = 90000
_GAP_TICKS = GAP_TIMEOUT_MS * _VIDEO_CLOCK // 1000


def _patch_h264_levels():
    video = _codecs.CODECS["video"]
    h264 = [c for c in video if c.mimeType.lower() == "video/h264"]
    if not h264:
        return
    for c in h264:
        c.parameters["profile-level-id"] = c.parameters["profile-level-id"][:4] + H264_LEVEL
    # iOS/libwebrtc also offers Constrained High (640c..) — often listed
    # first, and more efficient than Baseline at the same bitrate.
    if not any(c.parameters["profile-level-id"].startswith("640c") for c in h264):
        next_pt = max(c.payloadType for c in video) + 1
        high = copy.deepcopy(h264[0])
        high.payloadType = next_pt
        high.parameters["profile-level-id"] = "640c" + H264_LEVEL
        video.append(high)
        video.append(RTCRtpCodecParameters(
            mimeType="video/rtx", clockRate=_VIDEO_CLOCK,
            payloadType=next_pt + 1, parameters={"apt": next_pt},
        ))


def _ts_ahead(a: int, b: int) -> int:
    """How far RTP timestamp a is ahead of b (32-bit wraparound)."""
    return (a - b) & 0xFFFFFFFF


class _VideoJitterBuffer(JitterBuffer):
    def add(self, packet):
        pli_flag, frame = super().add(packet)
        if frame is None and self._origin is not None:
            if self._drop_stale_incomplete_frame(packet.timestamp):
                pli_flag = True
                frame = self._remove_frame(packet.sequence_number)
        return pli_flag, frame

    def _drop_stale_incomplete_frame(self, newest_ts: int) -> bool:
        """If the oldest buffered frame is stuck behind a missing packet and
        media is already GAP_TIMEOUT_MS past it, discard up to the next frame
        boundary (a packet following a marker-bit packet)."""
        cap = self._capacity
        oldest_ts = None
        for i in range(cap):
            p = self._packets[(self._origin + i) % cap]
            if p is not None:
                oldest_ts = p.timestamp
                break
        if oldest_ts is None or _ts_ahead(newest_ts, oldest_ts) >= 1 << 31:
            return False
        if _ts_ahead(newest_ts, oldest_ts) < _GAP_TICKS:
            return False
        prev = None
        for i in range(1, cap):
            prev = self._packets[(self._origin + i - 1) % cap]
            cur = self._packets[(self._origin + i) % cap]
            if (cur is not None and prev is not None and prev.marker
                    and cur.timestamp != oldest_ts):
                self.remove(i)
                return True
        return False


def _jitter_buffer_factory(capacity, prefetch=0, is_video=False):
    if is_video:
        return _VideoJitterBuffer(capacity=max(capacity, VIDEO_JITTER_CAPACITY),
                                  prefetch=prefetch, is_video=True)
    return JitterBuffer(capacity=capacity, prefetch=prefetch, is_video=is_video)


_original_remb_add = RemoteBitrateEstimator.add


def _remb_add_with_floor(self, *args, **kwargs):
    result = _original_remb_add(self, *args, **kwargs)
    if result is None:
        return None
    bitrate, ssrcs = result
    return max(bitrate, REMB_FLOOR_BPS), ssrcs


def preferred_video_codecs(capabilities):
    """H264 (hardware-encoded on phones) first, High before Baseline, then
    everything else (VP8) as fallback."""
    def rank(c):
        if c.mimeType.lower() != "video/h264":
            return 2
        return 0 if c.parameters.get("profile-level-id", "").startswith("640c") else 1
    return sorted(capabilities, key=rank)


_applied = False


def apply():
    global _applied
    if _applied:
        return
    _applied = True
    _patch_h264_levels()
    _receiver.JitterBuffer = _jitter_buffer_factory
    RemoteBitrateEstimator.add = _remb_add_with_floor
