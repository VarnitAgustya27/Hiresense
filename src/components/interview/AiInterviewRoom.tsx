"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  Volume2,
  Clock,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  RotateCcw,
  RefreshCw,
  X,
  ChevronDown,
  ChevronUp,
  User,
  Radio,
  Keyboard,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import {
  generateInterviewQuestions,
  evaluateInterviewSession,
  type InterviewQuestion,
  type InterviewScorecard,
} from "@/lib/ai-interview";
import { useMediaSession } from "@/hooks/useMediaSession";
import { VoicePill, type VoiceState } from "@/components/interview/VoicePill";
import {
  LiveSyncedTranscript,
  type ConversationTurn,
} from "@/components/kokonutui/synced-transcript";
import AI_Voice from "@/components/kokonutui/ai-voice";
import { AppleActivityCard, type ActivityData } from "@/components/kokonutui/apple-activity-card";
import {
  recordInterviewStarted,
  recordInterviewProgress,
  recordInterviewCompleted,
} from "@/lib/applications";

interface SpeechRecognitionResultItem {
  transcript: string;
}

interface SpeechRecognitionResultList {
  [index: number]: {
    [index: number]: SpeechRecognitionResultItem;
    isFinal: boolean;
    length: number;
  };
  length: number;
}

interface BrowserSpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent {
  error: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface AiInterviewRoomProps {
  userId?: string;
  jobId?: string;
  candidateName: string;
  targetJobTitle: string;
  jobPosting?: Record<string, unknown>;
  verificationQuestions?: string[];
  preferredLanguage?: "en" | "hi" | "hinglish" | "code_mixed";
  onClose: () => void;
}

export function AiInterviewRoom({
  userId = "guest_user",
  jobId = "demo-job",
  candidateName,
  targetJobTitle,
  jobPosting = {},
  verificationQuestions = [],
  preferredLanguage = "en",
  onClose,
}: AiInterviewRoomProps) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);

  // Session stage: "lobby" | "interview" | "scorecard"
  const [stage, setStage] = useState<"lobby" | "interview" | "scorecard">("lobby");

  // Language mapping
  const normalizedLanguage: "en" | "hi" | "hinglish" =
    preferredLanguage === "code_mixed" ? "hinglish" : preferredLanguage;
  const [language, setLanguage] = useState<"en" | "hi" | "hinglish">(normalizedLanguage);

  // Questions and progress (initialized synchronously so interview is never blank)
  const [questions, setQuestions] = useState<InterviewQuestion[]>(() =>
    generateInterviewQuestions(targetJobTitle, jobPosting, verificationQuestions),
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [sessionId] = useState(() => `session_${Date.now()}`);

  // Single media session from context (Phase 3)
  const {
    stream,
    isAcquired,
    isAcquiring,
    permissionStatus,
    hasCamera,
    hasMic,
    audioLevel,
    acquire,
    release,
  } = useMediaSession();

  // Local device toggles
  const [isCameraActive, setIsCameraActive] = useState(true);
  const [isMicMuted, setIsMicMuted] = useState(false);

  // Voice & Interview states
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isTtsSpeaking, setIsTtsSpeaking] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [manualTextMode, setManualTextMode] = useState(false);
  const [silencePrompt, setSilencePrompt] = useState(false);

  // Transcripts & Conversation Turns for Kokonut Synced Transcript
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(undefined);

  // Answers & Durations
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const [sessionSeconds, setSessionSeconds] = useState(0);

  // End Session Confirmation Modal
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  // Scorecard
  const [scorecard, setScorecard] = useState<InterviewScorecard | null>(null);
  const [expandedAnswerId, setExpandedAnswerId] = useState<string | null>(null);

  // Audio / Speech refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const lobbyVideoRef = useRef<HTMLVideoElement>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const shouldListenRef = useRef<boolean>(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAudioElemRef = useRef<HTMLAudioElement | null>(null);
  const isTtsSpeakingRef = useRef<boolean>(false);
  const lastAskedQuestionIdRef = useRef<string | null>(null);
  const speakTextRef = useRef<((text: string, onEnd?: () => void) => Promise<void>) | null>(null);
  const planFetchedRef = useRef<boolean>(false);

  // Callback ref for lobby video to ensure instant attachment on element mount
  const setLobbyVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      lobbyVideoRef.current = el;
      if (el && stream) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        el.play().catch(() => {});
      }
    },
    [stream],
  );

  // Callback ref for interview video to ensure instant attachment on element mount
  const setInterviewVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      if (el && stream && isCameraActive) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        el.play().catch(() => {});
      }
    },
    [stream, isCameraActive],
  );

  // Lock body scroll on mount
  useEffect(() => {
    setMounted(true);
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = origOverflow;
    };
  }, []);

  // Ensure stream is acquired if not yet active
  useEffect(() => {
    if (!stream) {
      acquire().catch(() => {});
    }
  }, [stream, acquire]);

  // Sync stream to video elements when active
  useEffect(() => {
    if (!stream) return;

    if (stage === "interview" && videoRef.current) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
      }
      if (isCameraActive) {
        videoRef.current.play().catch(() => {});
      }
    } else if (stage === "lobby" && lobbyVideoRef.current) {
      if (lobbyVideoRef.current.srcObject !== stream) {
        lobbyVideoRef.current.srcObject = stream;
      }
      lobbyVideoRef.current.play().catch(() => {});
    }
  }, [stage, stream, isCameraActive]);

  // Plan generation on start (Phase 6) - strictly guarded to run once per session
  useEffect(() => {
    if (planFetchedRef.current) return;
    planFetchedRef.current = true;
    let active = true;

    async function fetchPlan() {
      try {
        const resp = await fetch("/api/interview/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobTitle: targetJobTitle,
            jobPosting,
            verificationQuestions,
            language,
          }),
        });

        if (resp.ok && active) {
          const data = await resp.json();
          if (Array.isArray(data.questions) && data.questions.length > 0) {
            setQuestions(data.questions);
            return;
          }
        }
      } catch (err) {
        console.warn("Interview plan API fallback:", err);
      }

      if (active) {
        // Deterministic fallback
        const deterministic = generateInterviewQuestions(
          targetJobTitle,
          jobPosting,
          verificationQuestions,
        );
        setQuestions(deterministic);
      }
    }

    fetchPlan();

    return () => {
      active = false;
    };
  }, [targetJobTitle, jobPosting, verificationQuestions, language]);

  // Session Timer
  useEffect(() => {
    if (stage !== "interview") return;
    const interval = setInterval(() => {
      setSessionSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [stage]);

  const formatTime = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Stop STT
  const stopSpeechRecognition = useCallback(() => {
    shouldListenRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        void e;
      }
      recognitionRef.current = null;
    }
  }, []);

  // Start STT (Indian English / Hindi support)
  const startSpeechRecognition = useCallback(() => {
    if (isMicMuted || stage !== "interview") return;

    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SpeechRecognitionClass = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setManualTextMode(true);
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {
          void e;
        }
      }

      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = language === "hi" ? "hi-IN" : "en-IN";

      shouldListenRef.current = true;

      recognition.onstart = () => {
        setVoiceState("listening");
      };

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        // Reset silence timer on speech
        setSilencePrompt(false);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

        // Barge-in check (Phase 4.4): if TTS is speaking, interrupt it within 150ms
        if (isTtsSpeakingRef.current) {
          if (activeAudioElemRef.current) {
            activeAudioElemRef.current.pause();
            activeAudioElemRef.current = null;
          }
          if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
          }
          setIsTtsSpeaking(false);
          isTtsSpeakingRef.current = false;
          setVoiceState("listening");
        }

        let finalTranscript = "";
        let interimTranscript = "";

        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          if (!res || !res[0]) continue;
          const chunk = res[0].transcript;
          if (res.isFinal) {
            finalTranscript += chunk + " ";
          } else {
            interimTranscript += chunk;
          }
        }

        const combined = (finalTranscript + interimTranscript).trim();
        if (combined) {
          setCurrentAnswer(combined);

          // Update candidate turn in SyncedTranscript
          setTurns((prev) => {
            const lastTurn = prev[prev.length - 1];
            if (lastTurn && lastTurn.speaker === "candidate") {
              return [...prev.slice(0, -1), { ...lastTurn, text: combined, isStreaming: true }];
            } else {
              return [
                ...prev,
                {
                  id: `cand_${Date.now()}`,
                  speaker: "candidate",
                  speakerName: candidateName,
                  text: combined,
                  isStreaming: true,
                },
              ];
            }
          });
        }
      };

      recognition.onerror = (event: BrowserSpeechRecognitionErrorEvent) => {
        if (event.error === "no-speech") return;
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setManualTextMode(true);
          shouldListenRef.current = false;
        }
      };

      recognition.onend = () => {
        if (shouldListenRef.current && !isMicMuted && stage === "interview") {
          if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
          restartTimerRef.current = setTimeout(() => {
            if (shouldListenRef.current && !isMicMuted && stage === "interview") {
              try {
                recognition.start();
              } catch (e) {
                void e;
              }
            }
          }, 250);
        }
      };

      recognition.start();
      recognitionRef.current = recognition;
    } catch (err) {
      console.warn("Speech recognition initialization fallback:", err);
    }
  }, [isMicMuted, stage, language, candidateName]);

  // Fallback to browser SpeechSynthesis
  const fallbackToWebSpeech = useCallback(
    (text: string, onEndCallback?: () => void) => {
      if (!("speechSynthesis" in window)) {
        setIsTtsSpeaking(false);
        setVoiceState("listening");
        startSpeechRecognition();
        if (onEndCallback) onEndCallback();
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.05;

      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find((v) => v.lang.includes("en-IN") || v.name.toLowerCase().includes("india")) ||
        voices.find((v) => v.lang.includes("en-US") && v.name.includes("Natural")) ||
        voices.find((v) => v.lang.includes("en"));

      if (preferredVoice) utterance.voice = preferredVoice;

      utterance.onend = () => {
        setIsTtsSpeaking(false);
        isTtsSpeakingRef.current = false;
        setVoiceState("listening");
        startSpeechRecognition();
        if (onEndCallback) onEndCallback();
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => setSilencePrompt(true), 4000);
      };

      utterance.onerror = () => {
        setIsTtsSpeaking(false);
        isTtsSpeakingRef.current = false;
        setVoiceState("listening");
        startSpeechRecognition();
      };

      window.speechSynthesis.speak(utterance);
    },
    [startSpeechRecognition],
  );

  // Text-To-Speech (Mira voice synthesis with server fallback to browser)
  const speakText = useCallback(
    async (text: string, onEndCallback?: () => void) => {
      stopSpeechRecognition();
      setVoiceState("speaking");
      setIsTtsSpeaking(true);
      isTtsSpeakingRef.current = true;
      setSilencePrompt(false);

      // Attempt server-side synthesis
      try {
        const resp = await fetch("/api/speech/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, language }),
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data.audioBase64 && !data.useBrowserFallback) {
            const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
            activeAudioElemRef.current = audio;

            audio.onended = () => {
              setIsTtsSpeaking(false);
              isTtsSpeakingRef.current = false;
              setVoiceState("listening");
              activeAudioElemRef.current = null;
              startSpeechRecognition();
              if (onEndCallback) onEndCallback();
              // Start 4s silence detection
              if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = setTimeout(() => setSilencePrompt(true), 4000);
            };

            audio.onerror = () => {
              fallbackToWebSpeech(text, onEndCallback);
            };

            await audio.play();
            return;
          }
        }
      } catch (err) {
        console.warn("Speech synthesis API fallback:", err);
      }

      // Fallback to Web Speech API
      fallbackToWebSpeech(text, onEndCallback);
    },
    [language, startSpeechRecognition, stopSpeechRecognition, fallbackToWebSpeech],
  );

  useEffect(() => {
    speakTextRef.current = speakText;
  }, [speakText]);

  // Handle Question advance & rotation (guaranteed single trigger per question)
  useEffect(() => {
    if (stage !== "interview" || questions.length === 0 || !questions[currentIdx]) {
      return;
    }

    const q = questions[currentIdx];

    // Strictly guard against asking or adding duplicate messages for the same question
    if (lastAskedQuestionIdRef.current === q.id) {
      return;
    }
    lastAskedQuestionIdRef.current = q.id;

    setCurrentAnswer("");
    setQuestionStartTime(Date.now());
    stopSpeechRecognition();

    const turnId = `mira_q_${q.id}`;
    setActiveTurnId(turnId);

    // Append Mira's question to transcript idempotently
    setTurns((prev) => {
      if (prev.some((t) => t.id === turnId)) {
        return prev;
      }
      return [
        ...prev,
        {
          id: turnId,
          speaker: "mira",
          speakerName: "Mira",
          text: q.question,
          isStreaming: false,
        },
      ];
    });

    const timer = setTimeout(() => {
      speakTextRef.current?.(q.question);
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [stage, currentIdx, questions, stopSpeechRecognition]);

  // Start interview from lobby
  const handleJoinInterview = async () => {
    lastAskedQuestionIdRef.current = null;
    if (!isAcquired) {
      await acquire().catch(() => {});
    }
    setStage("interview");
    setCurrentIdx(0);
    setSessionSeconds(0);
    setAnswers({});
    setDurations({});
    setTurns([]);
    recordInterviewStarted(userId, jobId, sessionId);
  };

  // Toggle Camera
  const handleToggleCamera = () => {
    const nextState = !isCameraActive;
    setIsCameraActive(nextState);
    if (stream) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = nextState;
      });
    }
    if (videoRef.current && stream) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
      }
      if (nextState) {
        videoRef.current.play().catch(() => {});
      }
    }
  };

  // Toggle Mic
  const handleToggleMic = () => {
    const nextState = !isMicMuted;
    setIsMicMuted(nextState);
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !nextState;
      });
    }
    if (nextState) {
      stopSpeechRecognition();
    } else {
      startSpeechRecognition();
    }
  };

  // Repeat current question
  const handleRepeatQuestion = () => {
    if (questions[currentIdx]) {
      speakText(questions[currentIdx].question);
    }
  };

  // Finalize scorecard and end session
  const completeInterviewEvaluation = async (
    allAnswers: Record<string, string>,
    allDurations: Record<string, number>,
  ) => {
    stopSpeechRecognition();
    if (activeAudioElemRef.current) {
      activeAudioElemRef.current.pause();
      activeAudioElemRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    setVoiceState("thinking");

    let finalScorecard: InterviewScorecard | null = null;

    try {
      const resp = await fetch("/api/interview/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateName,
          targetJobTitle,
          questions,
          answers: allAnswers,
          durations: allDurations,
          language,
        }),
      });

      if (resp.ok) {
        finalScorecard = await resp.json();
      }
    } catch (err) {
      console.warn("Interview evaluation API fallback:", err);
    }

    if (!finalScorecard) {
      finalScorecard = evaluateInterviewSession(
        candidateName,
        targetJobTitle,
        questions,
        allAnswers,
        allDurations,
      );
    }

    // Record complete application progress
    recordInterviewCompleted(userId, jobId, finalScorecard);

    setScorecard(finalScorecard);
    setStage("scorecard");
  };

  // Advance to Next Question
  const handleNextQuestion = async () => {
    stopSpeechRecognition();
    if (activeAudioElemRef.current) {
      activeAudioElemRef.current.pause();
      activeAudioElemRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    const currentQ = questions[currentIdx];
    if (!currentQ) return;

    const timeSpent = Math.max(5, Math.round((Date.now() - questionStartTime) / 1000));
    const finalAnswer = currentAnswer.trim();

    const updatedAnswers = { ...answers, [currentQ.id]: finalAnswer };
    const updatedDurations = { ...durations, [currentQ.id]: timeSpent };

    setAnswers(updatedAnswers);
    setDurations(updatedDurations);

    // Autosave progress (Phase 4.3)
    recordInterviewProgress(userId, jobId, {
      sessionId,
      currentQuestion: currentIdx,
      totalQuestions: questions.length,
    });

    if (currentIdx < questions.length - 1) {
      setVoiceState("thinking");
      setTimeout(() => {
        setCurrentIdx((prev) => prev + 1);
      }, 500);
    } else {
      // Completed last question
      completeInterviewEvaluation(updatedAnswers, updatedDurations);
    }
  };

  // Confirm End Interview early
  const handleConfirmEndEarly = () => {
    setShowEndConfirm(false);
    const currentQ = questions[currentIdx];
    const finalAnswer = currentAnswer.trim();
    const updatedAnswers = {
      ...answers,
      [currentQ?.id || `q_${currentIdx}`]: finalAnswer,
    };
    const updatedDurations = {
      ...durations,
      [currentQ?.id || `q_${currentIdx}`]: Math.max(
        5,
        Math.round((Date.now() - questionStartTime) / 1000),
      ),
    };

    completeInterviewEvaluation(updatedAnswers, updatedDurations);
  };

  // Retake interview
  const handleRetake = () => {
    lastAskedQuestionIdRef.current = null;
    setStage("lobby");
    setCurrentIdx(0);
    setAnswers({});
    setDurations({});
    setTurns([]);
  };

  // Done button navigation
  const handleDone = () => {
    release();
    onClose();
    navigate({ to: "/dashboard" });
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-md p-2 sm:p-5 overflow-y-auto">
      <div className="relative w-full max-w-6xl rounded-[24px] bg-[#0a0a0a] border border-[rgba(255,255,255,0.12)] p-4 sm:p-8 shadow-2xl flex flex-col justify-between my-auto max-h-[94vh] overflow-y-auto">
        {/* ========================================================= */}
        {/* STAGE 1: LOBBY & EQUIPMENT READINESS                      */}
        {/* ========================================================= */}
        {stage === "lobby" && (
          <div className="flex-1 flex flex-col justify-between space-y-6">
            <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-[30%] bg-[#141414] border border-[rgba(255,255,255,0.12)] text-[#f5f5f5] font-[650] text-[15px]">
                  M
                </div>
                <div>
                  <h3 className="text-[18px] sm:text-[20px] font-[650] text-[#f5f5f5] tracking-tight">
                    Mira AI Interview Room.
                  </h3>
                  <p className="text-[12px] font-[450] text-[#8a8a8a]">
                    Pre-session readiness check for{" "}
                    <span className="text-[#f5f5f5] font-[600]">{targetJobTitle}</span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="text-[#8a8a8a] hover:text-[#f5f5f5] p-1.5 transition-colors"
                title="Exit interview setup"
              >
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center flex-1">
              {/* Left: Square Camera Preview Mirror */}
              <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-5 flex flex-col items-center justify-center space-y-3 relative overflow-hidden">
                <div className="relative w-full aspect-square max-w-[280px] sm:max-w-[310px] rounded-[18px] bg-[#1a1a1a] overflow-hidden flex items-center justify-center border border-[rgba(255,255,255,0.08)] shadow-inner">
                  {hasCamera && stream && isCameraActive ? (
                    <video
                      ref={setLobbyVideo}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      style={{ transform: "scaleX(-1)" }}
                    />
                  ) : hasMic && stream && !hasCamera ? (
                    /* Audio-only fallback (Phase 3.4) */
                    <div className="flex flex-col items-center justify-center space-y-3 p-4 text-center">
                      <div className="h-20 w-20 rounded-full bg-[#141414] border border-[rgba(255,255,255,0.15)] flex items-center justify-center text-[22px] font-[700] text-[#f5f5f5]">
                        {candidateName
                          .split(" ")
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </div>
                      <span className="text-[11px] font-[600] px-3 py-1 rounded-full bg-[#141414] text-[#8a8a8a] border border-[rgba(255,255,255,0.10)]">
                        Audio only mode
                      </span>
                    </div>
                  ) : (
                    <video
                      ref={setLobbyVideo}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      style={{ transform: "scaleX(-1)" }}
                    />
                  )}

                  {(!isAcquired || !stream?.active) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center space-y-3 bg-[#141414]/90 backdrop-blur-sm p-4 text-center z-10">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1a1a1a] border border-[rgba(255,255,255,0.10)] text-[#8a8a8a]">
                        <VideoOff size={20} />
                      </div>

                      <div className="space-y-1">
                        <p className="text-[13px] font-[650] text-[#f5f5f5]">
                          {isAcquiring ? "Connecting media devices..." : "Camera & mic standby"}
                        </p>
                        <p className="text-[11px] text-[#8a8a8a] max-w-[210px] leading-relaxed">
                          {permissionStatus === "denied"
                            ? "Camera or microphone blocked. Allow permissions in the address bar and tap retry."
                            : "Enable camera & microphone to preview video before entering."}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => acquire()}
                        disabled={isAcquiring}
                        className="inline-flex h-8 items-center gap-1.5 px-4 rounded-full bg-[#f5f5f5] text-[12px] font-[600] text-[#0a0a0a] hover:bg-[#e0e0e0] transition-colors disabled:opacity-50"
                      >
                        <RefreshCw size={12} className={isAcquiring ? "animate-spin" : ""} />
                        <span>{isAcquiring ? "Connecting..." : "Enable camera & mic"}</span>
                      </button>
                    </div>
                  )}

                  <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-[11px] text-[#f5f5f5] font-[500] border border-white/10 flex items-center gap-1.5 z-20">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isAcquired ? "bg-emerald-400 animate-pulse" : "bg-[#707070]"
                      }`}
                    />
                    <span>{candidateName}</span>
                  </div>
                </div>

                <div className="w-full max-w-[310px] flex items-center justify-between text-[11px] text-[#8a8a8a] px-1">
                  <span className="flex items-center gap-1.5">
                    <Mic
                      size={12}
                      className={audioLevel > 0.15 ? "text-emerald-400" : "text-[#707070]"}
                    />
                    <span>Microphone check</span>
                  </span>
                  <div className="w-24 h-1.5 rounded-full bg-[#1a1a1a] overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 transition-all duration-75"
                      style={{ width: `${Math.round(audioLevel * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Right: Briefing & Language Selection */}
              <div className="space-y-4">
                <div className="space-y-1">
                  <span className="text-[11px] font-[600] text-[#0066ff]">Protocol Guide</span>
                  <h4 className="text-[20px] font-[650] text-[#f5f5f5] tracking-tight">
                    How your AI interview works.
                  </h4>
                  <p className="text-[13px] text-[#8a8a8a] leading-relaxed">
                    Mira asks 5 structured, spoken-length questions covering resume verification,
                    technical depth, and system trade-offs. Your spoken answers are transcribed in
                    real time.
                  </p>
                </div>

                <div className="space-y-2.5 text-[12px] text-[#8a8a8a]">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                    <span>Barge-in supported: speak naturally at any point to interrupt.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                    <span>Type mode available at any moment if background noise occurs.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                    <span>All evaluations link directly to verbatim evidence snippets.</span>
                  </div>
                </div>

                <div className="pt-2 flex items-center gap-2">
                  <span className="text-[12px] text-[#8a8a8a] mr-2">Language:</span>
                  {(["en", "hi", "hinglish"] as const).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => setLanguage(lang)}
                      className={`px-3 py-1.5 rounded-full text-[12px] font-[600] transition-colors ${
                        language === lang
                          ? "bg-[#f5f5f5] text-[#0a0a0a]"
                          : "bg-[#141414] text-[#8a8a8a] border border-[rgba(255,255,255,0.08)] hover:text-[#f5f5f5]"
                      }`}
                    >
                      {lang === "en" ? "English" : lang === "hi" ? "Hindi (हिन्दी)" : "Hinglish"}
                    </button>
                  ))}
                </div>

                <div className="pt-4">
                  <button
                    type="button"
                    onClick={handleJoinInterview}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-[#f5f5f5] px-7 text-[14px] font-[600] text-[#0a0a0a] hover:bg-[#e0e0e0] transition-colors"
                  >
                    <span>Enter interview room</span>
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Fallback loader if questions are ever empty */}
        {stage === "interview" && (questions.length === 0 || !questions[currentIdx]) && (
          <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-4 text-center my-auto">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgba(255,255,255,0.15)] border-t-[#f5f5f5]" />
            <p className="text-[14px] text-[#8a8a8a]">Preparing your interview session...</p>
          </div>
        )}

        {/* ========================================================= */}
        {/* STAGE 2: REDESIGNED SPLIT INTERVIEW SCREEN (Phase 4 & 5)   */}
        {/* ========================================================= */}
        {stage === "interview" && questions.length > 0 && questions[currentIdx] && (
          <div className="flex-1 flex flex-col space-y-6">
            {/* Desktop Split Layout: 5fr Media Column / 7fr Conversation Column */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Media Column (5fr) */}
              <div className="lg:col-span-5 space-y-4">
                {/* 1. Stacked AI Speaker Card (Top) */}
                <div className="rounded-[24px] bg-[#141414] border border-[rgba(255,255,255,0.10)] p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-[30%] bg-[#1a1a1a] border border-[rgba(255,255,255,0.12)] text-[#f5f5f5] font-[650] text-[15px]">
                        M
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[14px] font-[650] text-[#f5f5f5]">Mira</span>
                          <span className="text-[11px] text-[#8a8a8a]">· Technical Panel</span>
                        </div>
                        <span className="text-[11px] text-[#8a8a8a] block">
                          {voiceState === "speaking"
                            ? "Speaking question..."
                            : voiceState === "thinking"
                              ? "Reflecting on answer..."
                              : "Listening to candidate..."}
                        </span>
                      </div>
                    </div>

                    {/* Wispr-flow VoicePill (Phase 5) */}
                    <VoicePill
                      state={voiceState}
                      audioLevel={audioLevel}
                      isTtsSpeaking={isTtsSpeaking}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[rgba(255,255,255,0.06)] text-[12px]">
                    <button
                      type="button"
                      onClick={handleRepeatQuestion}
                      className="inline-flex items-center gap-1.5 text-[#8a8a8a] hover:text-[#f5f5f5] transition-colors"
                    >
                      <Volume2 size={13} />
                      <span>Repeat question</span>
                    </button>
                    <span className="text-[11px] text-[#5c5c5c] capitalize">
                      Language: {language}
                    </span>
                  </div>
                </div>

                {/* 2. Candidate Camera Card (Bottom, 16:9 mirrored) */}
                <div className="rounded-[24px] bg-[#141414] border border-[rgba(255,255,255,0.10)] p-4 space-y-3">
                  <div className="relative w-full aspect-video rounded-[16px] bg-[#0a0a0a] overflow-hidden flex items-center justify-center">
                    {hasCamera && isCameraActive && stream ? (
                      <video
                        ref={setInterviewVideo}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                        style={{ transform: "scaleX(-1)" }}
                      />
                    ) : hasMic && !hasCamera ? (
                      /* Audio-only in interview (Rule 3.4) */
                      <div className="flex flex-col items-center justify-center space-y-2">
                        <div className="h-16 w-16 rounded-full bg-[#141414] border border-[rgba(255,255,255,0.15)] flex items-center justify-center text-[18px] font-[700] text-[#f5f5f5]">
                          {candidateName
                            .split(" ")
                            .map((n) => n[0])
                            .slice(0, 2)
                            .join("")
                            .toUpperCase()}
                        </div>
                        <span className="text-[10px] font-[600] px-2.5 py-0.5 rounded-full bg-[#1a1a1a] text-[#8a8a8a] border border-[rgba(255,255,255,0.08)]">
                          Audio only mode
                        </span>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center space-y-2 text-[#5c5c5c] bg-[#141414]">
                        <VideoOff size={28} />
                        <span className="text-[12px]">
                          {!isCameraActive ? "Camera feed disabled" : "Camera disconnected"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (!stream) {
                              acquire().catch(() => {});
                            } else {
                              handleToggleCamera();
                            }
                          }}
                          className="px-3 py-1 rounded-full bg-[#1a1a1a] text-[11px] text-[#f5f5f5] border border-white/10 hover:bg-[#262626] transition-colors"
                        >
                          Turn on camera
                        </button>
                      </div>
                    )}

                    {/* Candidate Name Badge */}
                    <div className="absolute top-2.5 left-2.5 px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] text-[#f5f5f5] font-[500] border border-white/10 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>You · {candidateName}</span>
                    </div>

                    {/* Action Controls Overlay */}
                    <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 z-10">
                      <button
                        type="button"
                        onClick={handleToggleMic}
                        className={`h-7 w-7 rounded-full flex items-center justify-center backdrop-blur-md border transition-colors ${
                          isMicMuted
                            ? "bg-red-500/80 border-red-500/40 text-white"
                            : "bg-black/60 border-white/10 text-white hover:bg-black/80"
                        }`}
                        title={isMicMuted ? "Unmute Mic" : "Mute Mic"}
                      >
                        {isMicMuted ? <MicOff size={13} /> : <Mic size={13} />}
                      </button>

                      <button
                        type="button"
                        onClick={handleToggleCamera}
                        className={`h-7 w-7 rounded-full flex items-center justify-center backdrop-blur-md border transition-colors ${
                          !isCameraActive
                            ? "bg-red-500/80 border-red-500/40 text-white"
                            : "bg-black/60 border-white/10 text-white hover:bg-black/80"
                        }`}
                        title={isCameraActive ? "Disable Camera" : "Enable Camera"}
                      >
                        {isCameraActive ? <Video size={13} /> : <VideoOff size={13} />}
                      </button>
                    </div>

                    {/* Non-diagnostic proctoring tag */}
                    <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[10px] text-[#8a8a8a] border border-white/10">
                      Proctoring: Active & Monitored
                    </div>
                  </div>

                  {/* Mic Level Bar */}
                  <div className="flex items-center justify-between text-[11px] text-[#8a8a8a] px-1">
                    <span className="flex items-center gap-1.5">
                      <Mic
                        size={12}
                        className={audioLevel > 0.15 ? "text-emerald-400" : "text-[#707070]"}
                      />
                      <span>Mic Input {isMicMuted ? "(Muted)" : ""}</span>
                    </span>
                    <div className="w-28 h-1.5 rounded-full bg-[#1a1a1a] overflow-hidden">
                      <div
                        className="h-full bg-emerald-400 transition-all duration-75"
                        style={{ width: `${isMicMuted ? 0 : Math.round(audioLevel * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Conversation Column (7fr) */}
              <div className="lg:col-span-7 space-y-4">
                {/* Sticky Top Header Bar */}
                <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] pb-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#141414] text-[12px] font-[600] text-[#f5f5f5] border border-[rgba(255,255,255,0.08)]">
                      <Clock size={12} className="text-[#8a8a8a]" />
                      <span>{formatTime(sessionSeconds)}</span>
                    </span>

                    <span className="inline-flex items-center px-3 py-1 rounded-full bg-[#141414] text-[12px] font-[600] text-[#0066ff] border border-[rgba(255,255,255,0.08)]">
                      Question {currentIdx + 1} of {questions.length}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowEndConfirm(true)}
                    className="h-8 px-3.5 rounded-full bg-[#1a1a1a] text-[12px] font-[600] text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-colors"
                  >
                    End Session
                  </button>
                </div>

                {/* Question Details Card */}
                <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.10)] p-5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#f5f5f5]" />
                    <span className="text-[12px] font-[600] text-[#8a8a8a]">
                      {questions[currentIdx].phaseLabel}
                    </span>
                  </div>
                  <h3 className="text-[20px] sm:text-[22px] font-[650] text-[#f5f5f5] tracking-tight leading-snug">
                    {questions[currentIdx].question}
                  </h3>
                  <p className="text-[13px] text-[#707070] italic">
                    Hint: {questions[currentIdx].contextHint}
                  </p>
                </div>

                {/* Synced Transcript Component (Kokonutui live transcript) */}
                <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-4 max-h-[260px] overflow-hidden flex flex-col">
                  <span className="text-[11px] font-[600] text-[#8a8a8a] uppercase tracking-wider mb-2 block">
                    Live Transcript
                  </span>
                  <LiveSyncedTranscript
                    turns={turns}
                    candidateName={candidateName}
                    activeTurnId={activeTurnId}
                    className="flex-1"
                  />
                </div>

                {/* Silence prompt (Phase 4.5 VAD) */}
                {silencePrompt && (
                  <div className="rounded-[14px] bg-[#1a1a1a] border border-[rgba(255,255,255,0.06)] px-4 py-2 text-[12px] text-[#8a8a8a] text-center animate-in fade-in">
                    Take your time, or tap Submit when ready.
                  </div>
                )}

                {/* Response & Control Bar */}
                <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-4 space-y-3">
                  <div className="flex items-center justify-between text-[12px] text-[#8a8a8a]">
                    <div className="flex items-center gap-2">
                      <Radio size={13} className="text-emerald-400 animate-pulse" />
                      <span className="text-emerald-400 font-[600]">
                        {manualTextMode ? "Manual Text Mode" : "Voice Detection Active"}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setManualTextMode(!manualTextMode)}
                      className="inline-flex items-center gap-1.5 text-[#8a8a8a] hover:text-[#f5f5f5] transition-colors"
                    >
                      <Keyboard size={13} />
                      <span>{manualTextMode ? "Switch to Voice" : "Type Answer"}</span>
                    </button>
                  </div>

                  {manualTextMode ? (
                    <textarea
                      rows={3}
                      value={currentAnswer}
                      onChange={(e) => setCurrentAnswer(e.target.value)}
                      placeholder="Type your response here..."
                      className="w-full p-3.5 rounded-[16px] bg-[#1a1a1a] border-0 text-[13px] text-[#f5f5f5] placeholder-[#5c5c5c] focus:outline-none focus:ring-2 focus:ring-[#f5f5f5]"
                    />
                  ) : (
                    <div className="flex items-center justify-center py-1">
                      <AI_Voice
                        compact
                        level={audioLevel}
                        onStop={() => handleNextQuestion()}
                        onSend={() => handleNextQuestion()}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-[#5c5c5c]">
                      {currentAnswer.trim().split(/\s+/).filter(Boolean).length} words transcribed
                    </span>

                    <button
                      type="button"
                      onClick={handleNextQuestion}
                      className="inline-flex h-11 items-center gap-2 rounded-full bg-[#f5f5f5] px-7 text-[14px] font-[600] text-[#0a0a0a] hover:bg-[#e0e0e0] transition-colors active:scale-[0.98]"
                    >
                      <span>
                        {currentIdx < questions.length - 1
                          ? "Submit & Next Question"
                          : "Submit & Complete"}
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* End Session Confirmation Modal (Phase 4.2) */}
            {showEndConfirm && (
              <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                <div className="max-w-md w-full rounded-[24px] bg-[#141414] border border-[rgba(255,255,255,0.12)] p-6 space-y-4 shadow-2xl">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-400">
                      <AlertTriangle size={18} />
                    </div>
                    <div>
                      <h4 className="text-[18px] font-[650] text-[#f5f5f5]">End interview?</h4>
                      <p className="text-[13px] text-[#8a8a8a]">
                        Your answers up to question {currentIdx + 1} will be scored. Unanswered
                        questions will receive 0.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-[rgba(255,255,255,0.06)]">
                    <button
                      type="button"
                      onClick={() => setShowEndConfirm(false)}
                      className="h-10 px-5 rounded-full bg-[#1a1a1a] text-[13px] font-[600] text-[#f5f5f5] hover:bg-[#262626] transition-colors"
                    >
                      Keep interviewing
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmEndEarly}
                      className="h-10 px-5 rounded-full bg-red-500/10 border border-red-500/30 text-[13px] font-[600] text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      End and score
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* STAGE 3: RESULTS SCREEN DECLUTTER (Phase 7)               */}
        {/* ========================================================= */}
        {stage === "scorecard" && scorecard && (
          <div className="flex-1 max-w-[1100px] w-full mx-auto space-y-8 animate-in fade-in duration-300">
            {/* Header: Lead & Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[rgba(255,255,255,0.08)] pb-5">
              <div>
                <span className="text-[12px] font-[600] text-[#8a8a8a] block mb-1">
                  Interview Performance Scorecard.
                </span>
                <h1 className="text-[26px] sm:text-[32px] font-[650] text-[#f5f5f5] tracking-tight leading-tight">
                  Interview evaluation.
                </h1>
                <p className="text-[14px] text-[#8a8a8a] mt-1">
                  Candidate <strong className="text-[#f5f5f5]">{scorecard.candidateName}</strong>{" "}
                  for <strong className="text-[#f5f5f5]">{scorecard.targetJobTitle}</strong> ·
                  Evaluated{" "}
                  {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={handleRetake}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[#1a1a1a] border border-[rgba(255,255,255,0.12)] px-5 text-[13px] font-[600] text-[#f5f5f5] hover:bg-[#262626] transition-colors"
                >
                  <RotateCcw size={14} />
                  <span>Retake Interview</span>
                </button>

                <button
                  type="button"
                  onClick={handleDone}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[#f5f5f5] px-7 text-[13px] font-[600] text-[#0a0a0a] hover:bg-[#e0e0e0] transition-colors"
                >
                  <span>Done</span>
                </button>
              </div>
            </div>

            {/* Apple Activity Card with 3 Concentric Monochrome Rings (Phase 7.2) */}
            <AppleActivityCard
              title="Competency Activity Rings"
              overallScore={scorecard.overallScore}
              activities={[
                {
                  label: "Technical Accuracy",
                  current: scorecard.categories.technicalAccuracy,
                  target: 100,
                  color: "#f5f5f5",
                  colorEnd: "#e0e0e0",
                  size: 200,
                  description: "Grounded technical depth, core stack mechanisms, and architecture",
                },
                {
                  label: "Communication Clarity",
                  current: scorecard.categories.communicationClarity,
                  target: 100,
                  color: "#a3a3a3",
                  colorEnd: "#8a8a8a",
                  size: 160,
                  description: "Structured responses, articulate reasoning, and concise delivery",
                },
                {
                  label: "Problem Solving",
                  current: scorecard.categories.problemSolving,
                  target: 100,
                  color: "#525252",
                  colorEnd: "#404040",
                  size: 120,
                  description: "System engineering judgment, trade-offs, and pragmatic decisions",
                },
              ]}
            />

            {/* Summary Row: 3 Clean Cards (Strengths, Gaps, Human Verification) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-5 space-y-2.5">
                <span className="text-[12px] font-[650] text-[#f5f5f5] block">
                  Identified Strengths
                </span>
                <ul className="space-y-1.5 text-[13px] text-[#8a8a8a] pl-4 list-disc">
                  {scorecard.keyTakeaways.slice(0, 3).map((item, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-5 space-y-2.5">
                <span className="text-[12px] font-[650] text-[#f5f5f5] block">
                  Observed Gaps & Trade-offs
                </span>
                <ul className="space-y-1.5 text-[13px] text-[#8a8a8a] pl-4 list-disc">
                  {(scorecard.gaps || []).slice(0, 3).map((item: string, idx: number) => (
                    <li key={idx} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-5 space-y-2.5">
                <span className="text-[12px] font-[650] text-[#f5f5f5] block">
                  Questions for Human Interview Round
                </span>
                <ul className="space-y-1.5 text-[13px] text-[#8a8a8a] pl-4 list-disc">
                  {scorecard.recruiterVerificationNotes.slice(0, 3).map((note, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Accordion: Question-by-Question Audit & Transcripts (Phase 7.4) */}
            <div className="space-y-4">
              <h3 className="text-[18px] font-[650] text-[#f5f5f5]">
                Question-by-Question Audit & Transcripts.
              </h3>

              <div className="space-y-3">
                {scorecard.answers.map((item, idx) => {
                  const isExpanded =
                    expandedAnswerId === item.questionId ||
                    (expandedAnswerId === null && idx === 0);
                  const qCompositeScore = Math.round(
                    item.metrics.technicalScore * 0.5 +
                      item.metrics.relevanceScore * 0.3 +
                      item.metrics.clarityScore * 0.2,
                  );
                  const isLowScore = qCompositeScore < 40;
                  const isHighScore = qCompositeScore >= 70;

                  return (
                    <div
                      key={item.questionId}
                      className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-5 space-y-3"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedAnswerId(isExpanded ? "none" : item.questionId)}
                        className="w-full flex items-center justify-between text-left"
                      >
                        <div className="space-y-1">
                          <span className="text-[11px] font-[600] text-[#0066ff] block">
                            Question {idx + 1} · {item.phaseLabel}
                          </span>
                          <span className="text-[15px] font-[600] text-[#f5f5f5] block">
                            {item.question}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-4">
                          <span
                            className={`text-[13px] font-[650] tabular ${
                              isLowScore
                                ? "text-red-400"
                                : isHighScore
                                  ? "text-emerald-400"
                                  : "text-[#f5f5f5]"
                            }`}
                          >
                            Score: {qCompositeScore}/100
                          </span>
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="pt-3 border-t border-[rgba(255,255,255,0.06)] space-y-3.5 text-[13px] animate-in fade-in duration-150">
                          {/* Transcribed Candidate Answer with verbatim quote highlighting */}
                          <div className="space-y-1">
                            <span className="text-[11px] font-[600] text-[#8a8a8a] block">
                              Transcribed Candidate Response:
                            </span>
                            <p
                              className={`p-3.5 rounded-[14px] text-[13px] leading-relaxed italic ${
                                isLowScore
                                  ? "bg-red-500/10 text-red-300 border border-red-500/20"
                                  : "bg-[#1a1a1a] text-[#d4d4d4]"
                              }`}
                            >
                              "{item.transcribedAnswer}"
                            </p>
                          </div>

                          {/* Metric breakdown row */}
                          <div className="grid grid-cols-3 gap-2.5 text-center">
                            <div className="rounded-[12px] bg-[#1a1a1a] p-2.5 border border-[rgba(255,255,255,0.06)]">
                              <span className="text-[11px] text-[#8a8a8a] block">Technical</span>
                              <span className="text-[14px] font-[650] text-[#f5f5f5]">
                                {item.metrics.technicalScore}%
                              </span>
                            </div>
                            <div className="rounded-[12px] bg-[#1a1a1a] p-2.5 border border-[rgba(255,255,255,0.06)]">
                              <span className="text-[11px] text-[#8a8a8a] block">Clarity</span>
                              <span className="text-[14px] font-[650] text-[#f5f5f5]">
                                {item.metrics.clarityScore}%
                              </span>
                            </div>
                            <div className="rounded-[12px] bg-[#1a1a1a] p-2.5 border border-[rgba(255,255,255,0.06)]">
                              <span className="text-[11px] text-[#8a8a8a] block">Relevance</span>
                              <span className="text-[14px] font-[650] text-[#f5f5f5]">
                                {item.metrics.relevanceScore}%
                              </span>
                            </div>
                          </div>

                          {/* Strengths and Recommendations */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
                            <div className="space-y-1">
                              <span className="font-[600] text-emerald-400 block">
                                Strengths Identified:
                              </span>
                              <ul className="list-disc pl-4 space-y-1 text-[#8a8a8a]">
                                {item.strengths.map((s, sIdx) => (
                                  <li key={sIdx}>{s}</li>
                                ))}
                              </ul>
                            </div>

                            <div className="space-y-1">
                              <span className="font-[600] text-amber-400 block">
                                Improvement Recommendations:
                              </span>
                              <ul className="list-disc pl-4 space-y-1 text-[#8a8a8a]">
                                {item.improvements.map((imp, impIdx) => (
                                  <li key={impIdx}>{imp}</li>
                                ))}
                              </ul>
                            </div>
                          </div>

                          {/* Mira's Benchmark Guide */}
                          <div className="p-3.5 rounded-[14px] bg-[#1a1a1a]/60 border border-[rgba(255,255,255,0.06)] space-y-1 text-[12px]">
                            <span className="font-[600] text-[#f5f5f5] block">
                              Mira's Benchmark Guide:
                            </span>
                            <p className="text-[#8a8a8a] leading-relaxed">{item.modelAnswer}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
