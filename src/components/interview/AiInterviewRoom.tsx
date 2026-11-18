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
  ArrowRight,
  RotateCcw,
  X,
  ChevronDown,
  ChevronUp,
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
import { useMiraSpeech } from "@/hooks/useMiraSpeech";
import { VoicePill, type VoiceState } from "@/components/interview/VoicePill";
import {
  LiveSyncedTranscript,
  type ConversationTurn,
} from "@/components/kokonutui/synced-transcript";
import AI_Voice from "@/components/kokonutui/ai-voice";
import { AppleActivityCard } from "@/components/kokonutui/apple-activity-card";
import AITextLoading from "@/components/kokonutui/ai-text-loading";
import {
  recordInterviewStarted,
  recordInterviewProgress,
  recordInterviewCompleted,
} from "@/lib/applications";
import { cn } from "@/lib/utils";

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

  // Session stage: "lobby" | "interview" | "evaluating" | "scorecard"
  const [stage, setStage] = useState<"lobby" | "interview" | "evaluating" | "scorecard">("lobby");

  // Language mapping
  const normalizedLanguage: "en" | "hi" | "hinglish" =
    preferredLanguage === "code_mixed" ? "hinglish" : preferredLanguage;
  const [language, setLanguage] = useState<"en" | "hi" | "hinglish">(normalizedLanguage);

  // Questions in lobby (initialized synchronously so interview is never blank)
  const [questions, setQuestions] = useState<InterviewQuestion[]>(() =>
    generateInterviewQuestions(targetJobTitle, jobPosting, verificationQuestions),
  );

  // Frozen question snapshot used exclusively once interview starts
  const [sessionQuestions, setSessionQuestions] = useState<InterviewQuestion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  // Dedicated single-owner Mira speech engine
  const {
    phase: speechPhase,
    progress: speechProgress,
    speak: speakSpeech,
    prefetch: prefetchSpeech,
    cancel: cancelSpeech,
    isSpeaking: isSpeechSpeaking,
  } = useMiraSpeech();

  // Question reveal state: question text and hint revealed only after real sound starts
  const [revealedQuestionId, setRevealedQuestionId] = useState<string | null>(null);
  const [isPreparingOver150ms, setIsPreparingOver150ms] = useState(false);
  const [voiceFailedNotice, setVoiceFailedNotice] = useState(false);

  // Single media session from context
  const { stream, isAcquired, hasCamera, hasMic, audioLevel, acquire, release } = useMediaSession();

  // Local device toggles
  const [isCameraActive, setIsCameraActive] = useState(true);
  const [isMicMuted, setIsMicMuted] = useState(false);

  // Voice & Interview states
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
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
  const sessionStartedRef = useRef<boolean>(false);

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
  const lastAskedQuestionIdRef = useRef<string | null>(null);
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

  // Plan generation on start - strictly guarded to run once per session while in lobby
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

  // Prefetch question 1 while candidate is reviewing the lobby
  useEffect(() => {
    if (stage === "lobby" && questions.length > 0) {
      prefetchSpeech(questions[0].question, language);
    }
  }, [stage, questions, language, prefetchSpeech]);

  // Session Timer: interval only increments once sessionStartedRef becomes true (on first onStart)
  useEffect(() => {
    if (stage !== "interview") return;
    const interval = setInterval(() => {
      if (sessionStartedRef.current) {
        setSessionSeconds((prev) => prev + 1);
      }
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
        setSilencePrompt(false);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

        // Barge-in check: if Mira is currently speaking, cancel immediately
        if (isSpeechSpeaking()) {
          cancelSpeech();
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

          setTurns((prev) => {
            const lastTurn = prev[prev.length - 1];
            if (lastTurn && lastTurn.speaker === "candidate") {
              setActiveTurnId(lastTurn.id);
              return [...prev.slice(0, -1), { ...lastTurn, text: combined, isStreaming: true }];
            } else {
              const candTurnId = `cand_${Date.now()}`;
              setActiveTurnId(candTurnId);
              return [
                ...prev,
                {
                  id: candTurnId,
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
  }, [isMicMuted, stage, language, candidateName, isSpeechSpeaking, cancelSpeech]);

  // Clean unmount safety
  useEffect(() => {
    return () => {
      cancelSpeech();
      stopSpeechRecognition();
    };
  }, [cancelSpeech, stopSpeechRecognition]);

  // Track preparation state for the current question
  const currentQ = sessionQuestions[currentIdx];
  const isPreparing =
    stage === "interview" && Boolean(currentQ) && revealedQuestionId !== currentQ?.id;

  // Anti-flicker: only show skeleton if preparing lasts longer than 150ms
  useEffect(() => {
    if (!isPreparing) {
      setIsPreparingOver150ms(false);
      return;
    }
    const timer = setTimeout(() => {
      setIsPreparingOver150ms(true);
    }, 150);
    return () => clearTimeout(timer);
  }, [isPreparing]);

  // Handle Question advance & rotation (strictly depends only on [stage, currentIdx])
  useEffect(() => {
    if (stage !== "interview" || sessionQuestions.length === 0 || !sessionQuestions[currentIdx]) {
      return;
    }

    const q = sessionQuestions[currentIdx];

    // Reset per-question UI states
    setRevealedQuestionId(null);
    setVoiceFailedNotice(false);
    setCurrentAnswer("");
    stopSpeechRecognition();
    setSilencePrompt(false);
    setVoiceState("thinking");

    const timer = setTimeout(() => {
      lastAskedQuestionIdRef.current = q.id;

      speakSpeech(q.question, {
        language,
        onStart: () => {
          // Real sound is audible now! Reveal question and update conversation turn
          setRevealedQuestionId(q.id);
          setVoiceState("speaking");

          if (!sessionStartedRef.current) {
            sessionStartedRef.current = true;
          }
          setQuestionStartTime(Date.now());

          const turnId = `mira_q_${q.id}`;
          setActiveTurnId(turnId);
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

          // Prefetch next question
          if (currentIdx + 1 < sessionQuestions.length) {
            prefetchSpeech(sessionQuestions[currentIdx + 1].question, language);
          }
        },
      }).then((result) => {
        if (result === "completed") {
          setVoiceState("listening");
          startSpeechRecognition();
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => setSilencePrompt(true), 4000);
        } else if (result === "failed") {
          // Graceful degradation: both engines failed
          setRevealedQuestionId(q.id);
          setVoiceFailedNotice(true);
          setManualTextMode(true);
          setVoiceState("idle");

          if (!sessionStartedRef.current) {
            sessionStartedRef.current = true;
          }
          setQuestionStartTime(Date.now());

          const turnId = `mira_q_${q.id}`;
          setActiveTurnId(turnId);
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
        }
      });
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [stage, currentIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start interview from lobby: snapshot questions into sessionQuestions
  const handleJoinInterview = async () => {
    lastAskedQuestionIdRef.current = null;
    sessionStartedRef.current = false;
    cancelSpeech();
    stopSpeechRecognition();

    if (!isAcquired) {
      await acquire().catch(() => {});
    }

    const snapshot = [...questions];
    setSessionQuestions(snapshot);
    setStage("interview");
    setCurrentIdx(0);
    setSessionSeconds(0);
    setAnswers({});
    setDurations({});
    setTurns([]);
    setRevealedQuestionId(null);
    setVoiceFailedNotice(false);

    recordInterviewStarted(userId, jobId, snapshot.length);
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

  // Repeat current question: replay audio without appending a duplicate turn
  const handleRepeatQuestion = () => {
    if (isPreparing) return;
    const currentQuestion = sessionQuestions[currentIdx];
    if (!currentQuestion) return;

    cancelSpeech();
    stopSpeechRecognition();
    setVoiceState("thinking");

    speakSpeech(currentQuestion.question, {
      language,
      onStart: () => {
        setVoiceState("speaking");
      },
    }).then((result) => {
      if (result === "completed") {
        setVoiceState("listening");
        startSpeechRecognition();
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => setSilencePrompt(true), 4000);
      }
    });
  };

  // Finalize scorecard and end session
  const completeInterviewEvaluation = async (
    allAnswers: Record<string, string>,
    allDurations: Record<string, number>,
  ) => {
    cancelSpeech();
    stopSpeechRecognition();
    setVoiceState("thinking");
    setStage("evaluating");

    // Finalize all candidate turns
    setTurns((prev) =>
      prev.map((t) => (t.speaker === "candidate" ? { ...t, isStreaming: false } : t)),
    );

    const startTime = Date.now();
    let finalScorecard: InterviewScorecard | null = null;

    try {
      const resp = await fetch("/api/interview/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateName,
          targetJobTitle,
          questions: sessionQuestions,
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
        sessionQuestions,
        allAnswers,
        allDurations,
      );
    }

    // Ensure candidate experiences the loading animation smoothly for at least 2.5 seconds
    const elapsed = Date.now() - startTime;
    if (elapsed < 2500) {
      await new Promise((r) => setTimeout(r, 2500 - elapsed));
    }

    recordInterviewCompleted(userId, jobId, finalScorecard);
    setScorecard(finalScorecard);
    setStage("scorecard");
  };

  // Advance to Next Question
  const handleNextQuestion = async () => {
    if (isPreparing) return;

    cancelSpeech();
    stopSpeechRecognition();

    // Mark active streaming turns as completed
    setTurns((prev) =>
      prev.map((t) => (t.speaker === "candidate" ? { ...t, isStreaming: false } : t)),
    );

    const currentQuestion = sessionQuestions[currentIdx];
    if (!currentQuestion) return;

    const timeSpent = Math.max(5, Math.round((Date.now() - questionStartTime) / 1000));
    const finalAnswer = currentAnswer.trim();

    const updatedAnswers = { ...answers, [currentQuestion.id]: finalAnswer };
    const updatedDurations = { ...durations, [currentQuestion.id]: timeSpent };

    setAnswers(updatedAnswers);
    setDurations(updatedDurations);

    recordInterviewProgress(userId, jobId, currentIdx + 1, sessionQuestions.length);

    if (currentIdx < sessionQuestions.length - 1) {
      setCurrentIdx((prev) => prev + 1);
    } else {
      completeInterviewEvaluation(updatedAnswers, updatedDurations);
    }
  };

  // Confirm End Interview early
  const handleConfirmEndEarly = () => {
    cancelSpeech();
    stopSpeechRecognition();
    setShowEndConfirm(false);

    const currentQuestion = sessionQuestions[currentIdx];
    const finalAnswer = currentAnswer.trim();
    const updatedAnswers = {
      ...answers,
      [currentQuestion?.id || `q_${currentIdx}`]: finalAnswer,
    };
    const updatedDurations = {
      ...durations,
      [currentQuestion?.id || `q_${currentIdx}`]: Math.max(
        5,
        Math.round((Date.now() - questionStartTime) / 1000),
      ),
    };

    completeInterviewEvaluation(updatedAnswers, updatedDurations);
  };

  // Retake interview
  const handleRetake = () => {
    cancelSpeech();
    stopSpeechRecognition();
    lastAskedQuestionIdRef.current = null;
    sessionStartedRef.current = false;
    setStage("lobby");
    setCurrentIdx(0);
    setSessionSeconds(0);
    setAnswers({});
    setDurations({});
    setTurns([]);
    setRevealedQuestionId(null);
    setVoiceFailedNotice(false);
  };

  // Done button navigation
  const handleDone = () => {
    cancelSpeech();
    stopSpeechRecognition();
    release();
    onClose();
    navigate({ to: "/dashboard" });
  };

  // Close handler for lobby X button
  const handleClose = () => {
    cancelSpeech();
    stopSpeechRecognition();
    onClose();
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
                    Pre-session readiness check for {targetJobTitle}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleClose}
                className="rounded-full p-2 text-[#8a8a8a] hover:bg-[#1a1a1a] hover:text-[#f5f5f5] transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center py-4">
              {/* Left: Video Self-View */}
              <div className="flex flex-col items-center space-y-3">
                <div className="relative w-full max-w-[310px] aspect-video rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.10)] overflow-hidden flex items-center justify-center">
                  {hasCamera && isCameraActive && stream ? (
                    <video
                      ref={setLobbyVideo}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      style={{ transform: "scaleX(-1)" }}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center space-y-2 text-[#8a8a8a]">
                      <VideoOff size={28} />
                      <span className="text-[12px]">
                        {!hasCamera ? "No camera detected" : "Camera turned off"}
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
                        Enable camera
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
        {stage === "interview" &&
          (sessionQuestions.length === 0 || !sessionQuestions[currentIdx]) && (
            <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-4 text-center my-auto">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgba(255,255,255,0.15)] border-t-[#f5f5f5]" />
              <p className="text-[14px] text-[#8a8a8a]">Preparing your interview session...</p>
            </div>
          )}

        {/* ========================================================= */}
        {/* STAGE 2: REDESIGNED SPLIT INTERVIEW SCREEN                */}
        {/* ========================================================= */}
        {stage === "interview" && sessionQuestions.length > 0 && currentQ && (
          <div className="flex-1 flex flex-col space-y-6">
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
                          {isPreparing
                            ? "Preparing the question..."
                            : voiceState === "speaking"
                              ? "Speaking question..."
                              : voiceState === "thinking"
                                ? "Reflecting on answer..."
                                : "Listening to candidate..."}
                        </span>
                      </div>
                    </div>

                    <VoicePill
                      state={voiceState}
                      audioLevel={audioLevel}
                      isTtsSpeaking={speechPhase === "speaking"}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[rgba(255,255,255,0.06)] text-[12px]">
                    <button
                      type="button"
                      disabled={isPreparing}
                      onClick={handleRepeatQuestion}
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[#8a8a8a] transition-colors",
                        isPreparing ? "opacity-50 cursor-not-allowed" : "hover:text-[#f5f5f5]",
                      )}
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

                    <div className="absolute top-2.5 left-2.5 px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] text-[#f5f5f5] font-[500] border border-white/10 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>You · {candidateName}</span>
                    </div>

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

                    <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[10px] text-[#8a8a8a] border border-white/10">
                      Proctoring: Active & Monitored
                    </div>
                  </div>

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
                      Question {currentIdx + 1} of {sessionQuestions.length}
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
                      {currentQ.phaseLabel}
                    </span>
                  </div>

                  {isPreparing ? (
                    isPreparingOver150ms ? (
                      <div
                        role="status"
                        aria-live="polite"
                        aria-busy="true"
                        className="space-y-2.5 py-1 min-h-[132px]"
                      >
                        <span className="sr-only">Mira is preparing the question.</span>
                        <div className="h-6 w-[92%] rounded-full bg-[#1a1a1a] animate-pulse motion-reduce:animate-none" />
                        <div className="h-6 w-[78%] rounded-full bg-[#1a1a1a] animate-pulse motion-reduce:animate-none" />
                        <div className="h-6 w-[55%] rounded-full bg-[#1a1a1a] animate-pulse motion-reduce:animate-none" />
                      </div>
                    ) : (
                      <div className="min-h-[132px] py-1" aria-hidden="true" />
                    )
                  ) : (
                    <div className="min-h-[132px] space-y-2 py-1">
                      <h3 className="text-[20px] sm:text-[22px] font-[650] text-[#f5f5f5] tracking-tight leading-snug">
                        {currentQ.question}
                      </h3>
                      <p className="text-[13px] text-[#707070] italic">
                        Hint: {currentQ.contextHint}
                      </p>
                      {voiceFailedNotice && (
                        <p className="text-[12px] text-[#8a8a8a] mt-2">
                          Voice is unavailable. Read the question and answer by typing or speaking.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Synced Transcript Component */}
                <div className="rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] p-4 max-h-[260px] overflow-hidden flex flex-col">
                  <span className="text-[11px] font-[600] text-[#8a8a8a] uppercase tracking-wider mb-2 block">
                    Live Transcript
                  </span>
                  <LiveSyncedTranscript
                    turns={turns}
                    candidateName={candidateName}
                    activeTurnId={activeTurnId}
                    speechProgress={
                      speechPhase === "speaking" || speechProgress.isComplete
                        ? {
                            turnId: activeTurnId || "",
                            wordIndex: speechProgress.wordIndex,
                            isComplete: speechProgress.isComplete,
                          }
                        : undefined
                    }
                    isPreparingNextQuestion={isPreparing}
                    className="flex-1"
                  />
                </div>

                {/* Silence prompt */}
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
                      disabled={isPreparing}
                      onClick={handleNextQuestion}
                      className={cn(
                        "inline-flex h-11 items-center gap-2 rounded-full px-7 text-[14px] font-[600] transition-colors",
                        isPreparing
                          ? "bg-[#1a1a1a] text-[#707070] opacity-50 cursor-not-allowed"
                          : "bg-[#f5f5f5] text-[#0a0a0a] hover:bg-[#e0e0e0] active:scale-[0.98]",
                      )}
                    >
                      <span>
                        {currentIdx < sessionQuestions.length - 1
                          ? "Submit & Next Question"
                          : "Submit & Complete"}
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* End Session Confirmation Modal */}
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
        {/* STAGE 2.5: EVALUATION LOADING SCREEN (Kokonut UI)         */}
        {/* ========================================================= */}
        {stage === "evaluating" && (
          <div className="flex-1 flex flex-col items-center justify-center min-h-[520px] w-full max-w-2xl mx-auto px-4 py-12 text-center animate-in fade-in duration-300">
            <div className="w-full rounded-[24px] bg-[#141414] border border-[rgba(255,255,255,0.10)] p-8 sm:p-12 space-y-8 shadow-2xl relative overflow-hidden">
              {/* Subtle top indicator bar */}
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[rgba(255,255,255,0.3)] to-transparent" />

              {/* Status Pill */}
              <div className="inline-flex items-center gap-2 rounded-full bg-[#1a1a1a] border border-[rgba(255,255,255,0.12)] px-4 py-1.5 mx-auto">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="text-[12px] font-[600] text-[#f5f5f5] tracking-wide">
                  Mira Evaluation Engine · In progress
                </span>
              </div>

              {/* Kokonut UI Animated Wave Text Loader */}
              <div className="py-2">
                <AITextLoading
                  texts={[
                    "Evaluating responses...",
                    "Analyzing communication evidence...",
                    "Benchmarking technical competencies...",
                    "Calculating objective rubrics...",
                    "Compiling comprehensive scorecard...",
                    "Almost ready...",
                  ]}
                  className="text-2xl sm:text-3xl font-[650] text-[#f5f5f5] tracking-tight justify-center"
                  interval={1800}
                  showElapsed={true}
                  label="Evaluating interview session"
                />
              </div>

              {/* Editorial context */}
              <div className="space-y-3 max-w-md mx-auto pt-2 border-t border-[rgba(255,255,255,0.06)]">
                <p className="text-[13px] text-[#8a8a8a] leading-relaxed">
                  Every score links directly back to transcripts and verified evidence. Human
                  recruiters review all decisions.
                </p>
                <div className="flex items-center justify-center gap-3 text-[12px] text-[#5c5c5c]">
                  <span>{sessionQuestions.length} Questions Processed</span>
                  <span>•</span>
                  <span>Session Duration {formatTime(sessionSeconds)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* STAGE 3: RESULTS SCREEN DECLUTTER                         */}
        {/* ========================================================= */}
        {stage === "scorecard" && scorecard && (
          <div className="flex-1 max-w-[1100px] w-full mx-auto space-y-8 animate-in fade-in duration-300">
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
