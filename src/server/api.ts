import { z } from "zod";
import {
  generateInterviewQuestions,
  evaluateInterviewSession,
  type InterviewQuestion,
} from "../lib/ai-interview";

// Configurable model IDs and voices from environment
const LLM_MODEL_PRIMARY = process.env.LLM_MODEL_PRIMARY || "gemini-3.8-flash";
const LLM_MODEL_FALLBACK = process.env.LLM_MODEL_FALLBACK || "gpt-4o-mini";
const STT_MODEL = process.env.STT_MODEL || "gemini-3.8-flash";
const TTS_MODEL = process.env.TTS_MODEL || "gemini-2.5-flash";
const TTS_VOICE = process.env.TTS_VOICE || "echo";

// Timeouts in milliseconds
const TIMEOUT_LLM = 25000;
const TIMEOUT_STT = 20000;
const TIMEOUT_TTS = 20000;

// Retry helper with backoff on 429/5xx
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  maxRetries = 1,
): Promise<Response> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt < maxRetries) {
          attempt++;
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
      }

      return response;
    } catch (err) {
      if (attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Request failed after retries");
}

/* ========================================================================== */
/* 1. /api/interview/plan                                                     */
/* ========================================================================== */

export const PlanRequestSchema = z.object({
  jobTitle: z.string().min(1),
  jobPosting: z.record(z.unknown()).optional().default({}),
  resumeSummary: z.string().optional().default(""),
  projects: z.array(z.string()).optional().default([]),
  verificationQuestions: z.array(z.string()).optional().default([]),
  language: z.enum(["en", "hi", "hinglish"]).optional().default("en"),
});

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

const planCache = new Map<
  string,
  { timestamp: number; plan: { questions: InterviewQuestion[]; modelUsed: string } }
>();
const planInFlight = new Map<
  string,
  Promise<{ questions: InterviewQuestion[]; modelUsed: string }>
>();

export async function handleInterviewPlan(payload: PlanRequest) {
  const cacheKey = `${payload.jobTitle}_${payload.language}_${(payload.verificationQuestions || []).join(",")}`;
  const cached = planCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 120_000) {
    console.log(`[interview/plan] Serving cached plan for ${payload.jobTitle}`);
    return cached.plan;
  }
  if (planInFlight.has(cacheKey)) {
    console.log(`[interview/plan] Reusing in-flight plan promise for ${payload.jobTitle}`);
    return planInFlight.get(cacheKey)!;
  }

  const execPromise = (async () => {
    const t0 = Date.now();
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const openAiKey = process.env.OPENAI_API_KEY?.trim();

    // State machine: INTRO -> RESUME -> TECHNICAL -> PROJECT -> SITUATIONAL -> CLOSING
    const systemPrompt = `You are Mira, HireSense's lead AI technical interviewer.
Generate exactly 5 role-specific, spoken-length interview questions for the position of "${payload.jobTitle}".
State machine order:
1. INTRO (Warm opening and candidate introduction)
2. RESUME (Resume & project background verification)
3. TECHNICAL (Deep dive into mandatory tech stack skills)
4. PROJECT (System architecture and technical decision making)
5. SITUATIONAL (Engineering judgment, trade-offs, and communication)

STRICT RULES:
- Language: Output in ${payload.language === "hi" ? "Hindi (Devanagari script)" : payload.language === "hinglish" ? "Hinglish (conversational code-mixed Indian English and Roman Hindi)" : "English"}.
- Spoken-length: Under 35 words per question. Conversational and natural.
- Concrete and non-leading: Test practical depth without giving away answers.
- Prohibited topics: Never ask about age, religion, family, caste, nationality, gender, or health.

Output JSON format matching this schema:
{
  "questions": [
    {
      "id": "q1_intro",
      "phase": "intro",
      "phaseLabel": "Background and project verification",
      "question": string,
      "contextHint": string,
      "expectedKeywords": [string],
      "idealAnswerOutline": string
    }
  ]
}`;

    // 1. Try Gemini primary
    if (geminiKey) {
      try {
        const resp = await fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL_PRIMARY}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: systemPrompt },
                    {
                      text: `Job Requirements: ${JSON.stringify(payload.jobPosting)}\nCandidate Summary: ${payload.resumeSummary}`,
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.2,
              },
            }),
          },
          TIMEOUT_LLM,
        );

        if (resp.ok) {
          const data = await resp.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed.questions) && parsed.questions.length >= 5) {
              console.log(`[interview/plan] Generated via Gemini in ${Date.now() - t0}ms`);
              const plan = {
                questions: parsed.questions.slice(0, 5) as InterviewQuestion[],
                modelUsed: LLM_MODEL_PRIMARY,
              };
              planCache.set(cacheKey, { timestamp: Date.now(), plan });
              return plan;
            }
          }
        }
      } catch (geminiErr) {
        console.warn("[interview/plan] Gemini fallback:", geminiErr);
      }
    }

    // 2. Try OpenAI fallback
    if (openAiKey) {
      try {
        const resp = await fetchWithRetry(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openAiKey}`,
            },
            body: JSON.stringify({
              model: LLM_MODEL_FALLBACK,
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Job Requirements: ${JSON.stringify(payload.jobPosting)}\nCandidate Summary: ${payload.resumeSummary}`,
                },
              ],
              response_format: { type: "json_object" },
              temperature: 0.2,
            }),
          },
          TIMEOUT_LLM,
        );

        if (resp.ok) {
          const data = await resp.json();
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.questions) && parsed.questions.length >= 5) {
              console.log(`[interview/plan] Generated via OpenAI in ${Date.now() - t0}ms`);
              const plan = {
                questions: parsed.questions.slice(0, 5) as InterviewQuestion[],
                modelUsed: LLM_MODEL_FALLBACK,
              };
              planCache.set(cacheKey, { timestamp: Date.now(), plan });
              return plan;
            }
          }
        }
      } catch (openAiErr) {
        console.warn("[interview/plan] OpenAI fallback:", openAiErr);
      }
    }

    // 3. Fallback to deterministic plan
    console.log(`[interview/plan] Using deterministic planner in ${Date.now() - t0}ms`);
    const deterministic = generateInterviewQuestions(
      payload.jobTitle,
      payload.jobPosting,
      payload.verificationQuestions,
    );
    const plan = {
      questions: deterministic,
      modelUsed: "HireSense Dynamic Planner",
    };
    planCache.set(cacheKey, { timestamp: Date.now(), plan });
    return plan;
  })();

  planInFlight.set(cacheKey, execPromise);
  try {
    return await execPromise;
  } finally {
    planInFlight.delete(cacheKey);
  }
}

/* ========================================================================== */
/* 2. /api/interview/turn                                                     */
/* ========================================================================== */

export const TurnRequestSchema = z.object({
  questionId: z.string(),
  phase: z.string(),
  currentQuestion: z.string(),
  candidateAnswer: z.string().optional().default(""),
  hasFollowedUp: z.boolean().optional().default(false),
  language: z.enum(["en", "hi", "hinglish"]).optional().default("en"),
});

export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export async function handleInterviewTurn(payload: TurnRequest) {
  const t0 = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const answer = payload.candidateAnswer.trim();

  // App-enforced boundary: max 1 follow-up per question
  if (payload.hasFollowedUp) {
    return {
      shouldFollowUp: false,
      followUpQuestion: null,
      feedback: "Answer received. Advancing to the next question.",
    };
  }

  // If answer is empty or minimal, trigger a polite clarification
  if (answer.length === 0) {
    return {
      shouldFollowUp: false,
      followUpQuestion: null,
      feedback: "Unanswered. Advancing to next question.",
    };
  }

  const systemPrompt = `You are Mira, an AI technical interviewer.
The candidate just answered: "${answer}"
For the question: "${payload.currentQuestion}"
Determine if a targeted follow-up question is warranted:
- Trigger follow-up ONLY if the answer is vague, under 15 words, or makes a major technical claim without explaining how it was built.
- Do NOT trigger follow-up if the answer is already clear or sufficient.
- Language: Output in ${payload.language === "hi" ? "Hindi (Devanagari)" : payload.language === "hinglish" ? "Hinglish (Latin script)" : "English"}.
- Spoken-length: Under 25 words.

Output JSON format:
{
  "shouldFollowUp": boolean,
  "followUpQuestion": string | null,
  "rationale": string
}`;

  if (geminiKey) {
    try {
      const resp = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL_PRIMARY}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          }),
        },
        TIMEOUT_LLM,
      );

      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          console.log(`[interview/turn] Evaluated turn in ${Date.now() - t0}ms`);
          return {
            shouldFollowUp: Boolean(parsed.shouldFollowUp),
            followUpQuestion: parsed.followUpQuestion || null,
            feedback: parsed.rationale || "Answer analyzed.",
          };
        }
      }
    } catch (e) {
      console.warn("[interview/turn] Gemini fallback:", e);
    }
  }

  // Fallback heuristic: follow up once if answer is very short (< 15 words)
  const wordCount = answer.split(/\s+/).length;
  const needFollowUp = wordCount < 15;
  return {
    shouldFollowUp: needFollowUp,
    followUpQuestion: needFollowUp
      ? "Could you elaborate briefly on the specific implementation steps you took?"
      : null,
    feedback: "Turn processed.",
  };
}

/* ========================================================================== */
/* 3. /api/interview/evaluate                                                 */
/* ========================================================================== */

export const EvaluateRequestSchema = z.object({
  candidateName: z.string().min(1),
  targetJobTitle: z.string().min(1),
  questions: z.array(
    z.object({
      id: z.string(),
      phase: z.string().optional().default("technical"),
      phaseLabel: z.string(),
      question: z.string(),
      expectedKeywords: z.array(z.string()).optional().default([]),
      idealAnswerOutline: z.string().optional().default(""),
    }),
  ),
  answers: z.record(z.string()),
  durations: z.record(z.number()),
  language: z.enum(["en", "hi", "hinglish"]).optional().default("en"),
});

export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

export async function handleInterviewEvaluate(payload: EvaluateRequest) {
  const t0 = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();

  // Check if all questions were unanswered
  const totalAnswers = Object.values(payload.answers).filter(
    (a) => a && a.trim().length > 0,
  ).length;
  if (totalAnswers === 0) {
    const emptyScorecard = evaluateInterviewSession(
      payload.candidateName,
      payload.targetJobTitle,
      payload.questions as InterviewQuestion[],
      payload.answers,
      payload.durations,
    );
    emptyScorecard.overallScore = 0;
    return emptyScorecard;
  }

  const systemPrompt = `You are HireSense's objective interview evaluation rubric engine.
Score the candidate's actual interview transcript strictly against these weights:
- Technical correctness: 35%
- Problem solving & reasoning: 20%
- Project understanding: 15%
- Answer relevance & completeness: 10%
- Communication clarity: 10%
- Role-specific behavioral evidence: 10%

CRITICAL SCORING RUBRIC (STRICT ENFORCEMENT):
1. NOISE & GREETINGS: If a candidate answer is a greeting (e.g., "hello", "hi"), single-character/letters (e.g. "s", "wfdf", "asdf"), non-answer ("idk", "ok", "yes"), or empty/skipped:
   - YOU MUST SCORE 0 FOR technicalScore AND 0 FOR relevanceScore!
   - clarityScore may be at most 15 for a clear polite greeting, or 0 for noise.
   - DO NOT award courtesy or default points (e.g., 25% or 65%) for meaningless input!
2. SUBSTANTIVE ANSWERS:
   - 0-20: Non-responsive, noise, or completely inaccurate.
   - 21-45: Superficial mention of tech stack names without explaining architecture, trade-offs, or mechanisms.
   - 46-69: Foundational operational knowledge; covers basics but lacks production edge-case depth or telemetry metrics.
   - 70-85: Strong technical competency; clearly articulates architecture, optimization, and practical trade-offs.
   - 86-100: Exceptional domain mastery; comprehensive system design, edge case mitigation, and production metrics.
3. Every non-zero score must link to candidate evidence quotes.
4. Key takeaways and gaps MUST honestly reflect actual performance:
   - If candidate provided minimal answers or scored low (<40), state candidly that insufficient technical evidence was captured. DO NOT invent false praise like "demonstrated consistent communication" if the candidate typed noise.
5. NEVER make personality, honesty, or psychological judgments.

Return JSON strictly matching:
{
  "overallScore": number (0 to 100),
  "fitVerdict": "Strong Fit" | "Moderate Fit" | "Developing Fit",
  "categories": {
    "technicalAccuracy": number (0 to 100),
    "communicationClarity": number (0 to 100),
    "problemSolving": number (0 to 100),
    "practicalEvidence": number (0 to 100)
  },
  "answers": [
    {
      "questionId": string,
      "metrics": {
        "technicalScore": number (0 to 100),
        "clarityScore": number (0 to 100),
        "relevanceScore": number (0 to 100)
      },
      "evidenceQuotes": [string],
      "gaps": [string],
      "strengths": [string],
      "confidence": number (0 to 100)
    }
  ],
  "keyTakeaways": [string],
  "gaps": [string],
  "questionsToVerify": [string]
}`;

  const promptContent = `Candidate: ${payload.candidateName}
Role: ${payload.targetJobTitle}
Questions and Candidate Transcripts:
${payload.questions
  .map(
    (q, i) => `Q${i + 1} (${q.phaseLabel}): "${q.question}"
Candidate Answer: "${payload.answers[q.id] || "[Unanswered]"}"
Duration: ${payload.durations[q.id] || 0}s`,
  )
  .join("\n\n")}`;

  // 1. Try Gemini Primary
  if (geminiKey) {
    try {
      const resp = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL_PRIMARY}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }, { text: promptContent }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
          }),
        },
        TIMEOUT_LLM,
      );

      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          console.log(`[interview/evaluate] Evaluated via Gemini in ${Date.now() - t0}ms`);
          return formatEvaluatedScorecard(parsed, payload);
        }
      }
    } catch (e) {
      console.warn("[interview/evaluate] Gemini fallback:", e);
    }
  }

  // 2. Try OpenAI Fallback
  if (openAiKey) {
    try {
      const resp = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: LLM_MODEL_FALLBACK,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: promptContent },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
          }),
        },
        TIMEOUT_LLM,
      );

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          console.log(`[interview/evaluate] Evaluated via OpenAI in ${Date.now() - t0}ms`);
          return formatEvaluatedScorecard(parsed, payload);
        }
      }
    } catch (e) {
      console.warn("[interview/evaluate] OpenAI fallback:", e);
    }
  }

  // 3. Fallback to deterministic evaluation
  console.log(`[interview/evaluate] Using deterministic scorecard in ${Date.now() - t0}ms`);
  return evaluateInterviewSession(
    payload.candidateName,
    payload.targetJobTitle,
    payload.questions as InterviewQuestion[],
    payload.answers,
    payload.durations,
  );
}

function formatEvaluatedScorecard(
  parsed: Record<string, unknown>,
  payload: EvaluateRequest,
): InterviewScorecard {
  const totalDuration = Object.values(payload.durations).reduce((a, b) => a + b, 0);
  const mins = Math.floor(totalDuration / 60);
  const secs = totalDuration % 60;
  const categories = (parsed.categories as Record<string, number>) || {};
  const parsedAnswers = (parsed.answers as Array<Record<string, unknown>>) || [];

  return {
    candidateName: payload.candidateName,
    targetJobTitle: payload.targetJobTitle,
    overallScore: Math.round(Number(parsed.overallScore) || 0),
    fitVerdict:
      (parsed.fitVerdict as InterviewScorecard["fitVerdict"]) ||
      (Number(parsed.overallScore) >= 75
        ? "Strong Fit"
        : Number(parsed.overallScore) >= 50
          ? "Moderate Fit"
          : "Developing Fit"),
    completedAt: new Date().toISOString(),
    durationFormatted: `${mins > 0 ? `${mins}m ` : ""}${secs}s`,
    categories: {
      technicalAccuracy: Math.round(categories.technicalAccuracy || 0),
      communicationClarity: Math.round(categories.communicationClarity || 0),
      problemSolving: Math.round(categories.problemSolving || 0),
      practicalEvidence: Math.round(categories.practicalEvidence || 0),
    },
    answers: payload.questions.map((q) => {
      const evaluatedAnswer = parsedAnswers.find((a) => a.questionId === q.id);
      const rawAnswer = (payload.answers[q.id] || "").trim();
      const isUnanswered = !rawAnswer || rawAnswer === "[Unanswered]";
      const isTrivial =
        rawAnswer.length < 3 || /^(hello|hi|hey|s|asdf|wfdf|pass|idk)$/i.test(rawAnswer);

      const metrics = (evaluatedAnswer?.metrics as Record<string, number>) || {};

      return {
        questionId: q.id,
        question: q.question,
        phaseLabel: q.phaseLabel,
        transcribedAnswer: rawAnswer || "[Unanswered / Skipped]",
        durationSeconds: payload.durations[q.id] || 0,
        metrics: {
          technicalScore: isUnanswered || isTrivial ? 0 : Math.round(metrics.technicalScore ?? 35),
          clarityScore: isUnanswered ? 0 : isTrivial ? 15 : Math.round(metrics.clarityScore ?? 45),
          relevanceScore: isUnanswered || isTrivial ? 0 : Math.round(metrics.relevanceScore ?? 35),
        },
        strengths: isTrivial
          ? ["Polite engagement or greeting captured."]
          : (evaluatedAnswer?.strengths as string[]) || ["Answer submitted."],
        improvements: isTrivial
          ? [
              "Response was non-substantive. Provide concrete technical architecture and trade-off details.",
            ]
          : (evaluatedAnswer?.gaps as string[]) || ["Elaborate on production failure modes."],
        evidenceQuotes: (evaluatedAnswer?.evidenceQuotes as string[]) || [],
        confidence: Number(evaluatedAnswer?.confidence) || 85,
        modelAnswer: q.idealAnswerOutline || "",
      };
    }),
    keyTakeaways: (parsed.keyTakeaways as string[]) || [],
    gaps: (parsed.gaps as string[]) || [],
    recruiterVerificationNotes:
      (parsed.questionsToVerify as string[]) ||
      (parsed.recruiterVerificationNotes as string[]) ||
      [],
  };
}

/* ========================================================================== */
/* 4. /api/speech/transcribe                                                  */
/* ========================================================================== */

export const TranscribeRequestSchema = z.object({
  audioBase64: z.string(),
  mimeType: z.string().optional().default("audio/webm"),
  language: z.enum(["en", "hi", "hinglish"]).optional().default("en"),
  fallbackText: z.string().optional().default(""),
});

export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export async function handleSpeechTranscribe(payload: TranscribeRequest) {
  const t0 = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();

  // Strict transcription-only prompt: verbatim, keep Hindi in Devanagari and English in Latin
  const prompt = `Listen to the audio recording and transcribe it strictly and verbatim.
Rules:
- Output ONLY the transcription text. No commentary, no summaries.
- If code-mixed Hindi and English, keep Hindi words in Devanagari script and English words in Latin script.
- Mark unclear or cut-off speech as [inaudible].`;

  // 1. Try Gemini Audio Transcription
  if (geminiKey && payload.audioBase64.length > 100) {
    try {
      const resp = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${STT_MODEL}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: payload.mimeType,
                      data: payload.audioBase64,
                    },
                  },
                ],
              },
            ],
          }),
        },
        TIMEOUT_STT,
      );

      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 0) {
          console.log(`[speech/transcribe] Gemini transcribed in ${Date.now() - t0}ms`);
          return {
            transcript: text,
            provider: "gemini",
            confidence: 0.95,
          };
        }
      }
    } catch (e) {
      console.warn("[speech/transcribe] Gemini audio fallback:", e);
    }
  }

  // 2. Try OpenAI Whisper if key present
  if (openAiKey && payload.audioBase64.length > 100) {
    try {
      const buffer = Buffer.from(payload.audioBase64, "base64");
      const blob = new Blob([buffer], { type: payload.mimeType });
      const formData = new FormData();
      formData.append("file", blob, "audio.webm");
      formData.append("model", "whisper-1");
      if (payload.language === "hi") formData.append("language", "hi");

      const resp = await fetchWithRetry(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${openAiKey}` },
          body: formData,
        },
        TIMEOUT_STT,
      );

      if (resp.ok) {
        const data = await resp.json();
        if (data.text) {
          console.log(`[speech/transcribe] OpenAI Whisper transcribed in ${Date.now() - t0}ms`);
          return {
            transcript: data.text.trim(),
            provider: "openai",
            confidence: 0.92,
          };
        }
      }
    } catch (e) {
      console.warn("[speech/transcribe] OpenAI Whisper fallback:", e);
    }
  }

  // 3. Fallback to client-side Web Speech interim caption text
  console.log(`[speech/transcribe] Falling back to live captions in ${Date.now() - t0}ms`);
  return {
    transcript: payload.fallbackText || "",
    provider: "client_fallback",
    confidence: 0.8,
  };
}

/* ========================================================================== */
/* 5. /api/speech/synthesize                                                  */
/* ========================================================================== */

export const SynthesizeRequestSchema = z.object({
  text: z.string().min(1),
  language: z.enum(["en", "hi", "hinglish"]).optional().default("en"),
  voice: z.string().optional().default(TTS_VOICE),
});

export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

export async function handleSpeechSynthesize(payload: SynthesizeRequest) {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();

  // If OpenAI key is available, call OpenAI TTS
  if (openAiKey) {
    try {
      const chosenVoice =
        payload.voice &&
        ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(payload.voice)
          ? payload.voice
          : TTS_VOICE;

      const resp = await fetchWithRetry(
        "https://api.openai.com/v1/audio/speech",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: "tts-1",
            input: payload.text,
            voice: chosenVoice,
            response_format: "mp3",
          }),
        },
        TIMEOUT_TTS,
      );

      if (resp.ok) {
        const arrayBuffer = await resp.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        return {
          audioBase64: base64,
          mimeType: "audio/mpeg",
          useBrowserFallback: false,
        };
      }
    } catch (e) {
      console.warn("[speech/synthesize] OpenAI TTS fallback:", e);
    }
  }

  // Clean fallback: tell client to use Web Speech speechSynthesis
  return {
    audioBase64: null,
    mimeType: null,
    useBrowserFallback: true,
  };
}
