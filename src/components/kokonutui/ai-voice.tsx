"use client";

import { ArrowUp, Mic, Pause, Play, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Mode = "idle" | "recording" | "review";

const BAR_COUNT = 48;
const BAR_IDS = Array.from({ length: BAR_COUNT + 1 }, (_, i) => `bar-${i}`);
const SAMPLE_MS = 70;
const REST_LEVEL = 0.12;

const STILL_LEVELS = BAR_IDS.map(
  (_, i) => 0.25 + 0.5 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)),
);
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EDGE_MASK = "linear-gradient(to right, transparent, black 18%, black 92%, transparent)";

function createVoiceSimulator() {
  let speaking = false;
  let switchAt = 0;
  let gate = 0;
  return (time: number) => {
    if (time >= switchAt) {
      speaking = !speaking;
      switchAt = time + (speaking ? 700 + Math.random() * 1600 : 180 + Math.random() * 500);
    }
    gate += ((speaking ? 1 : 0) - gate) * 0.35;
    const t = time / 1000;
    const syllable = Math.abs(Math.sin(t * Math.PI * 4.4 + Math.sin(t * 1.7) * 2));
    const grain = 0.65 + Math.random() * 0.35;
    return REST_LEVEL + gate * syllable * grain * (1 - REST_LEVEL);
  };
}

function condense(take: number[]) {
  if (take.length === 0) {
    return STILL_LEVELS.slice(0, BAR_COUNT);
  }
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const from = Math.floor((i / BAR_COUNT) * take.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / BAR_COUNT) * take.length));
    return Math.max(REST_LEVEL, ...take.slice(from, to));
  });
}

const formatTime = (seconds: number) => {
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const setScales = (bars: (HTMLSpanElement | null)[], levels: readonly number[]) => {
  bars.forEach((bar, i) => {
    if (bar) {
      bar.style.transform = `scaleY(${(levels[i] ?? REST_LEVEL).toFixed(3)})`;
    }
  });
};

type Face = "mic" | "stop" | "play" | "pause";

const mainLabelFor = (mode: Mode, playing: boolean) => {
  if (mode === "recording") {
    return "Stop recording";
  }
  if (mode === "review") {
    return playing ? "Pause playback" : "Play recording";
  }
  return "Start recording";
};

const timerText = (
  mode: Mode,
  seconds: number,
  duration: number,
  playing: boolean,
  playhead: number,
) => {
  if (mode === "review") {
    return formatTime(playing || playhead > 0 ? playhead : duration);
  }
  return formatTime(mode === "recording" ? seconds : 0);
};

const FACE_CLASS =
  "absolute transition-[opacity,filter,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-opacity";
const faceState = (visible: boolean) =>
  visible ? "scale-100 opacity-100 blur-0" : "scale-50 opacity-0 blur-[3px]";

function ButtonFaces({ visible }: { visible: Record<Face, boolean> }) {
  const icon = "h-5 w-5 sm:h-6 sm:w-6 text-[#f5f5f5]";
  return (
    <>
      <Mic aria-hidden="true" className={cn(FACE_CLASS, icon, faceState(visible.mic))} />
      <span
        aria-hidden="true"
        className={cn(
          FACE_CLASS,
          "h-4 w-4 sm:h-5 sm:w-5 rounded-[6px] bg-red-400",
          faceState(visible.stop),
        )}
      />
      <Play
        aria-hidden="true"
        className={cn(FACE_CLASS, icon, "fill-current", faceState(visible.play))}
      />
      <Pause
        aria-hidden="true"
        className={cn(FACE_CLASS, icon, "fill-current", faceState(visible.pause))}
      />
    </>
  );
}

const ACTION_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30";

function ReviewActions({ onDiscard, onSend }: { onDiscard: () => void; onSend: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      className="flex items-center gap-2"
      exit={{ opacity: 0, filter: "blur(2px)" }}
      initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
      transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
    >
      <button
        className={cn(
          "flex h-7 items-center gap-1 rounded-full px-3 text-[#8a8a8a] text-xs transition-colors duration-150 hover:bg-[#1a1a1a] hover:text-[#f5f5f5] border border-[rgba(255,255,255,0.08)]",
          ACTION_FOCUS,
        )}
        onClick={onDiscard}
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
        Discard
      </button>
      <button
        className={cn(
          "flex h-7 items-center gap-1 rounded-full bg-[#f5f5f5] px-3.5 text-[#0a0a0a] text-xs font-[600] transition-colors duration-150 hover:bg-[#e0e0e0]",
          ACTION_FOCUS,
        )}
        onClick={onSend}
        type="button"
      >
        Send
        <ArrowUp aria-hidden="true" className="size-3.5" />
      </button>
    </motion.div>
  );
}

export interface AIVoiceProps {
  className?: string;
  demo?: boolean;
  level?: number;
  recordedAudioUrl?: string | null;
  compact?: boolean;
  onListeningChange?: (listening: boolean) => void;
  onStop?: (duration: number) => void;
  onSend?: (duration: number) => void;
  onDiscard?: () => void;
}

export default function AI_Voice({
  className,
  demo = false,
  level,
  recordedAudioUrl,
  compact = false,
  onListeningChange,
  onStop,
  onSend,
  onDiscard,
}: AIVoiceProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [isDemo, setIsDemo] = useState(demo);
  const [seconds, setSeconds] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const shouldReduceMotion = useReducedMotion();

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const playedBarRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const takeRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const levelRef = useRef(level);
  const audioElemRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  const recording = mode === "recording";
  const reviewing = mode === "review";
  const announce = !isDemo;

  // Recording loop
  useEffect(() => {
    const bars = barRefs.current;
    const row = rowRef.current;
    const ring = ringRef.current;
    const root = rootRef.current;
    if (!(recording && row && ring && root)) {
      return;
    }
    takeRef.current = [];

    if (shouldReduceMotion) {
      setScales(bars, STILL_LEVELS);
      takeRef.current = STILL_LEVELS.slice();
      return;
    }

    const simulate = createVoiceSimulator();
    const samples = BAR_IDS.map(() => REST_LEVEL);
    let phase = 0;
    let smooth = 0;
    let last = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      phase += dt / SAMPLE_MS;
      while (phase >= 1) {
        phase -= 1;
        const live = levelRef.current;
        const s =
          typeof live === "number" && !isNaN(live)
            ? Math.max(REST_LEVEL, Math.min(1, live))
            : simulate(now);
        samples.shift();
        samples.push(s);
        takeRef.current.push(s);
      }
      smooth += ((samples[samples.length - 1] ?? REST_LEVEL) - smooth) * 0.18;
      const target = ring.parentElement?.getBoundingClientRect();
      const radius = target ? target.width / 2 : 32;
      const spread = radius * (0.15 + smooth * 0.55);
      ring.style.transform = `scale(${1 + spread / radius})`;
      ring.style.opacity = `${0.1 + smooth * 0.5}`;

      row.style.transform = `translateX(-${(phase * 5).toFixed(2)}px)`;
      setScales(bars, samples);

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ring.style.transform = "scale(1)";
      ring.style.opacity = "0";
      row.style.transform = "none";
    };
  }, [recording, shouldReduceMotion]);

  // Seconds count while recording
  useEffect(() => {
    if (!recording) return;
    startedAtRef.current = Date.now();
    setSeconds(0);
    const id = setInterval(() => {
      setSeconds((Date.now() - startedAtRef.current) / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  // Review mode waveform setup
  useEffect(() => {
    if (!reviewing) return;
    const condensed = condense(takeRef.current);
    setScales(barRefs.current, condensed);
    setScales(playedBarRefs.current, condensed);
  }, [reviewing]);

  // Review playback with actual audio element or simulated sweep
  useEffect(() => {
    if (!playing) return;

    if (recordedAudioUrl && audioElemRef.current) {
      audioElemRef.current.currentTime = 0;
      audioElemRef.current.play().catch(() => {});
      const onTime = () => {
        if (!audioElemRef.current) return;
        const cur = audioElemRef.current.currentTime;
        setPlayhead(cur);
        const p = duration > 0 ? Math.min(1, cur / duration) : 0;
        if (playedRef.current) {
          playedRef.current.style.clipPath = `inset(0 ${(100 - p * 100).toFixed(1)}% 0 0)`;
        }
      };
      const onEnded = () => {
        setPlaying(false);
        setPlayhead(0);
        if (playedRef.current) {
          playedRef.current.style.clipPath = "inset(0 100% 0 0)";
        }
      };
      const audio = audioElemRef.current;
      audio.addEventListener("timeupdate", onTime);
      audio.addEventListener("ended", onEnded);
      return () => {
        audio.removeEventListener("timeupdate", onTime);
        audio.removeEventListener("ended", onEnded);
        audio.pause();
      };
    }

    // Fallback simulated sweep if no audio URL
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = (now - start) / 1000;
      const progress = duration > 0 ? Math.min(1, elapsed / duration) : 1;
      setPlayhead(elapsed);
      if (playedRef.current) {
        playedRef.current.style.clipPath = `inset(0 ${(100 - progress * 100).toFixed(1)}% 0 0)`;
      }
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
        setPlayhead(0);
        if (playedRef.current) {
          playedRef.current.style.clipPath = "inset(0 100% 0 0)";
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, recordedAudioUrl]);

  const startRecording = (notify = true) => {
    setPlaying(false);
    setMode("recording");
    if (notify) {
      onListeningChange?.(true);
    }
  };

  const stopRecording = (notify = true) => {
    const taken = Math.max(
      (Date.now() - startedAtRef.current) / 1000,
      takeRef.current.length * (SAMPLE_MS / 1000),
    );
    setDuration(taken);
    setPlayhead(0);
    if (playedRef.current) {
      playedRef.current.style.clipPath = "inset(0 100% 0 0)";
    }
    setMode("review");
    if (notify) {
      onListeningChange?.(false);
      onStop?.(taken);
    }
  };

  const finish = (sent: boolean, notify = true) => {
    setPlaying(false);
    setMode("idle");
    if (!notify) return;
    mainRef.current?.focus();
    if (sent) {
      onSend?.(duration);
    } else {
      onDiscard?.();
    }
  };

  const togglePlay = () => {
    if (!playing && playedRef.current) {
      playedRef.current.style.clipPath = "inset(0 100% 0 0)";
    }
    setPlaying((p) => !p);
  };

  const endDemo = () => {
    if (isDemo) {
      setIsDemo(false);
      setPlaying(false);
      setMode("idle");
    }
  };

  const handleMainClick = () => {
    if (isDemo) {
      endDemo();
      startRecording();
    } else if (recording) {
      stopRecording();
    } else if (reviewing) {
      togglePlay();
    } else {
      startRecording();
    }
  };

  const faces: Record<Face, boolean> = {
    mic: mode === "idle",
    stop: recording,
    play: reviewing && !playing,
    pause: reviewing && playing,
  };
  const timerValue = timerText(mode, seconds, duration, playing, playhead);

  return (
    <div className={cn("w-full py-2", className)} onPointerDownCapture={endDemo} ref={rootRef}>
      {recordedAudioUrl && <audio ref={audioElemRef} src={recordedAudioUrl} className="hidden" />}

      <div className="relative mx-auto flex w-full max-w-sm flex-col items-center gap-2">
        <div className="relative">
          {/* Swells with the voice while recording */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full bg-red-400/20 opacity-0 transition-transform"
            ref={ringRef}
          />
          <button
            aria-label={mainLabelFor(mode, playing)}
            aria-pressed={recording && announce}
            className={cn(
              "relative flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-full transition-colors duration-150 ease-out border",
              ACTION_FOCUS,
              mode === "idle" &&
                "bg-[#141414] border-[rgba(255,255,255,0.12)] hover:bg-[#1a1a1a] text-[#f5f5f5]",
              recording && "bg-red-500/20 border-red-500/40 text-red-400",
              reviewing && "bg-[#1a1a1a] border-[rgba(255,255,255,0.12)] text-[#f5f5f5]",
            )}
            onClick={handleMainClick}
            ref={mainRef}
            type="button"
          >
            <ButtonFaces visible={faces} />
          </button>
        </div>

        {/* Timer */}
        <span
          className={cn(
            "relative font-mono text-[12px] tabular-nums transition-colors duration-300",
            mode === "idle" ? "text-[#5c5c5c]" : "text-[#f5f5f5]",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1/2 right-full mr-1.5 size-1.5 -translate-y-1/2 rounded-full bg-red-500 transition-opacity duration-150",
              recording ? "opacity-100 animate-pulse" : "opacity-0",
            )}
          />
          {timerValue}
        </span>

        {/* Waveform Bars */}
        <div
          aria-hidden="true"
          className={cn("relative h-6 w-48 sm:w-56 overflow-hidden", compact && "h-5 w-40")}
          style={{
            maskImage: recording ? EDGE_MASK : undefined,
            WebkitMaskImage: recording ? EDGE_MASK : undefined,
          }}
        >
          <div className="flex h-full items-center gap-[2px]" ref={rowRef}>
            {BAR_IDS.map((id, i) => (
              <span
                className={cn(
                  "h-full w-[3px] shrink-0 rounded-full",
                  recording
                    ? "bg-[#f5f5f5]"
                    : "bg-[rgba(255,255,255,0.18)] transition-transform duration-500 motion-reduce:transition-none",
                )}
                key={id}
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                style={{
                  transform: `scaleY(${REST_LEVEL})`,
                  transitionDelay: recording ? undefined : `${(BAR_COUNT - i) * 6}ms`,
                  transitionTimingFunction: EASE_OUT,
                }}
              />
            ))}
          </div>

          <div
            className={cn(
              "absolute inset-0 flex items-center gap-[2px] transition-opacity duration-200",
              reviewing ? "opacity-100" : "opacity-0",
            )}
            ref={playedRef}
            style={{ clipPath: "inset(0 100% 0 0)" }}
          >
            {BAR_IDS.map((id, i) => (
              <span
                className="h-full w-[3px] shrink-0 rounded-full bg-[#f5f5f5]"
                key={id}
                ref={(el) => {
                  playedBarRefs.current[i] = el;
                }}
                style={{ transform: `scaleY(${REST_LEVEL})` }}
              />
            ))}
          </div>
        </div>

        {/* Status / Review Actions */}
        <div className="relative flex h-7 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            {reviewing ? (
              <ReviewActions
                key="actions"
                onDiscard={() => finish(false)}
                onSend={() => finish(true)}
              />
            ) : (
              <motion.span
                animate={{ opacity: 1, filter: "blur(0px)" }}
                className="text-[#8a8a8a] text-[11px]"
                exit={{ opacity: 0, filter: "blur(2px)" }}
                initial={{ opacity: 0, filter: "blur(2px)" }}
                key="caption"
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              >
                {recording ? "Recording your answer..." : "Click mic to speak"}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <output aria-live={announce ? "polite" : "off"} className="sr-only">
          {announce && recording ? "Recording" : ""}
          {announce && reviewing ? "Recording ready to send" : ""}
        </output>
      </div>
    </div>
  );
}
