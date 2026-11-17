"use client";

import { ArrowDown, Volume2 } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ConversationTurn {
  id: string;
  speaker: "mira" | "candidate";
  speakerName: string;
  text: string;
  isStreaming?: boolean;
  timestamp?: string;
}

export interface LiveSyncedTranscriptProps {
  turns: ConversationTurn[];
  candidateName: string;
  activeTurnId?: string | undefined;
  playbackProgress?: number; // 0..1 for active Mira TTS audio
  onReplayTurn?: (turn: ConversationTurn) => void;
  className?: string;
}

interface Word {
  text: string;
  startRatio: number;
  index: number;
}

function splitTurnWords(text: string, baseIndex: number): { words: Word[]; nextIndex: number } {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((sum, w) => sum + w.length + 1, 0);
  let accumulated = 0;
  let idx = baseIndex;

  const words = parts.map((part) => {
    const startRatio = total > 0 ? accumulated / total : 0;
    accumulated += part.length + 1;
    const item: Word = { text: part, startRatio, index: idx };
    idx += 1;
    return item;
  });

  return { words, nextIndex: idx };
}

const MemoizedParagraph = memo(function MemoizedParagraph({
  words,
  activeRatio,
  isMira,
  isStreaming,
}: {
  words: Word[];
  activeRatio: number; // 0..1
  isMira: boolean;
  isStreaming?: boolean;
}) {
  return (
    <p className="leading-relaxed text-[14px]">
      {words.map((word) => {
        const isSpoken = !isMira || isStreaming || activeRatio >= word.startRatio;
        return (
          <span
            key={word.index}
            data-index={word.index}
            className={cn(
              "transition-colors duration-150 inline-block mr-1",
              isSpoken ? "text-[#f5f5f5]" : "text-[#5c5c5c]",
            )}
          >
            {word.text}
          </span>
        );
      })}
    </p>
  );
});

export function LiveSyncedTranscript({
  turns,
  candidateName,
  activeTurnId,
  playbackProgress = 0,
  onReplayTurn,
  className,
}: LiveSyncedTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [showBackToNow, setShowBackToNow] = useState(false);

  // Split words per turn
  const preparedTurns = useMemo(() => {
    let globalIndex = 0;
    return turns.map((turn) => {
      const { words, nextIndex } = splitTurnWords(turn.text, globalIndex);
      globalIndex = nextIndex;
      return {
        ...turn,
        words,
      };
    });
  }, [turns]);

  // Scroll to bottom when new words or turns arrive if user is following
  const scrollToLatest = useCallback((smooth = true) => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTo({
      top: box.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setFollowing(true);
    setShowBackToNow(false);
  }, []);

  // Detect user scroll away
  const handleScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const distanceToBottom = box.scrollHeight - (box.scrollTop + box.clientHeight);
    const isAtBottom = distanceToBottom < 60;
    setFollowing(isAtBottom);
    setShowBackToNow(!isAtBottom);
  }, []);

  useEffect(() => {
    if (following) {
      scrollToLatest(true);
    }
  }, [turns, following, scrollToLatest]);

  return (
    <div
      className={cn(
        "relative flex flex-col h-full rounded-[20px] bg-[#141414] border border-[rgba(255,255,255,0.08)] overflow-hidden",
        className,
      )}
    >
      {/* Minimal Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.08)] bg-[#141414]/90 backdrop-blur-md z-10">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-[650] text-[#f5f5f5]">Conversation</span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>
        <span className="text-[11px] text-[#707070]">
          {turns.length} message{turns.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Internal Scrollable Content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-left"
        tabIndex={0}
        aria-label="Interview conversation transcript"
      >
        {preparedTurns.length === 0 ? (
          <div className="py-12 text-center text-[#707070] text-[13px]">
            Mira will begin the interview shortly...
          </div>
        ) : (
          preparedTurns.map((turn, idx) => {
            const isMira = turn.speaker === "mira";
            const isActive = turn.id === activeTurnId;
            const progress = isActive ? playbackProgress : 1;
            const isLatest = idx === preparedTurns.length - 1;

            return (
              <div
                key={`${turn.id}_${idx}`}
                className={cn(
                  "group relative rounded-[16px] p-3.5 transition-colors border",
                  isMira
                    ? "bg-[#171717] border-[rgba(255,255,255,0.06)]"
                    : "bg-[#1a1a1a] border-[rgba(255,255,255,0.08)]",
                )}
                aria-live={isLatest ? "polite" : undefined}
              >
                {/* Speaker row */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "h-6 w-6 rounded-[30%] flex items-center justify-center text-[11px] font-[700]",
                        isMira
                          ? "bg-[#1a1a1a] border border-[rgba(255,255,255,0.15)] text-[#f5f5f5]"
                          : "bg-[#f5f5f5] text-[#0a0a0a]",
                      )}
                    >
                      {isMira ? "M" : (candidateName[0] || "Y").toUpperCase()}
                    </div>
                    <span className="text-[12px] font-[650] text-[#f5f5f5]">
                      {isMira ? "Mira" : candidateName}
                    </span>
                    {turn.isStreaming && (
                      <span className="text-[11px] text-emerald-400 font-[500] animate-pulse">
                        (speaking...)
                      </span>
                    )}
                  </div>

                  {/* Replay action for Mira lines */}
                  {isMira && onReplayTurn && !turn.isStreaming && (
                    <button
                      type="button"
                      onClick={() => onReplayTurn(turn)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full text-[#8a8a8a] hover:text-[#f5f5f5] hover:bg-[#262626]"
                      title="Replay this question"
                      aria-label="Replay this question"
                    >
                      <Volume2 size={13} />
                    </button>
                  )}
                </div>

                {/* Words */}
                <MemoizedParagraph
                  words={turn.words}
                  activeRatio={progress}
                  isMira={isMira}
                  isStreaming={turn.isStreaming}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Floating "Back to now" pill when user scrolled away */}
      {showBackToNow && (
        <button
          type="button"
          onClick={() => scrollToLatest(true)}
          className="absolute bottom-3 right-5 z-20 inline-flex items-center gap-1.5 rounded-full bg-[#f5f5f5] px-3.5 py-1 text-[12px] font-[600] text-[#0a0a0a] shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <ArrowDown size={13} />
          <span>Back to now</span>
        </button>
      )}
    </div>
  );
}

export default LiveSyncedTranscript;
