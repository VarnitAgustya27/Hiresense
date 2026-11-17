// HireSense AI Interview Evaluation Engine
// Generates role-grounded questions and computes structured scorecards.

export interface InterviewQuestion {
  id: string;
  phase: "intro" | "technical" | "architecture" | "scenario" | "closing";
  phaseLabel: string;
  question: string;
  contextHint: string;
  expectedKeywords: string[];
  idealAnswerOutline: string;
}

export interface CandidateAnswerRecord {
  questionId: string;
  question: string;
  phaseLabel: string;
  transcribedAnswer: string;
  durationSeconds: number;
  metrics: {
    technicalScore: number;
    clarityScore: number;
    relevanceScore: number;
  };
  strengths: string[];
  improvements: string[];
  modelAnswer: string;
}

export interface InterviewScorecard {
  candidateName: string;
  targetJobTitle: string;
  overallScore: number; // 0-100
  fitVerdict: "Strong Fit" | "Moderate Fit" | "Developing Fit";
  completedAt: string;
  durationFormatted: string;
  categories: {
    technicalAccuracy: number;
    communicationClarity: number;
    problemSolving: number;
    practicalEvidence: number;
  };
  answers: CandidateAnswerRecord[];
  keyTakeaways: string[];
  gaps: string[];
  recruiterVerificationNotes: string[];
}

/**
 * Dynamically builds a 5-question interview plan grounded in the job requisition and candidate background.
 */
export function generateInterviewQuestions(
  targetJobTitle: string,
  jobPosting: Record<string, unknown> = {},
  verificationQuestions: string[] = [],
): InterviewQuestion[] {
  const qualifications = jobPosting?.qualifications as { mandatory?: string[] } | undefined;
  const mandatoryQuals: string[] = qualifications?.mandatory || [];
  const techStack = (jobPosting?.tech_stack || []) as Array<{
    name: string;
    requirement_type?: string;
  }>;
  const mandatoryTech = techStack
    .filter((t) => t.requirement_type === "mandatory")
    .map((t) => t.name);

  const primaryTech = mandatoryTech[0] || "React and TypeScript";
  const secondaryTech = mandatoryTech[1] || mandatoryTech[0] || "modern component architecture";

  return [
    {
      id: "q1_intro",
      phase: "intro",
      phaseLabel: "Background & Project Verification",
      question: `Hi, I'm Mira. Welcome to your technical interview for the ${targetJobTitle} position. To start, could you introduce yourself and walk me through the most technically challenging project you have worked on recently?`,
      contextHint:
        "Focus on technical architecture, your individual role, tools chosen, and measurable outcomes.",
      expectedKeywords: [
        "project",
        "architecture",
        "built",
        "designed",
        "scale",
        "team",
        "performance",
      ],
      idealAnswerOutline:
        "Clear 2-minute overview introducing experience, explaining problem context of a major project, technical stack decisions, personal contribution, and outcome.",
    },
    {
      id: "q2_technical",
      phase: "technical",
      phaseLabel: "Core Stack & Technical Depth",
      question:
        verificationQuestions &&
        verificationQuestions.length > 0 &&
        verificationQuestions[0].length > 15
          ? verificationQuestions[0]
          : `This role demands high proficiency in ${primaryTech}. Can you explain how you handle state management, asynchronous data fetching, and race conditions in production applications?`,
      contextHint:
        "Highlight patterns you have practically implemented, caching strategies, and edge cases.",
      expectedKeywords: [
        primaryTech.toLowerCase(),
        "state",
        "cache",
        "async",
        "error",
        "lifecycle",
        "optimization",
      ],
      idealAnswerOutline:
        "Directly addresses state isolation, caching layers (e.g., React Query / TanStack), handling pending requests, cancel tokens, and error boundary integration.",
    },
    {
      id: "q3_architecture",
      phase: "architecture",
      phaseLabel: "System Design & Performance",
      question: `When building web applications that handle large data sets and responsive UI interactions, what performance bottlenecks do you actively monitor, and how do you optimize them?`,
      contextHint:
        "Discuss render cycles, bundle splitting, Web Vitals (LCP, INP), or API payload strategies.",
      expectedKeywords: [
        "render",
        "bundle",
        "memo",
        "lazy",
        "performance",
        "vitals",
        "metrics",
        "network",
      ],
      idealAnswerOutline:
        "Covers both client-side optimizations (code splitting, virtualization, memoization) and network-level improvements (payload compression, edge caching).",
    },
    {
      id: "q4_scenario",
      phase: "scenario",
      phaseLabel: "Situational & Engineering Judgment",
      question: `Imagine you discover a critical regression right before a scheduled production release, but product stakeholders are eager to ship. How do you evaluate the risk and communicate your decision with the team?`,
      contextHint:
        "Demonstrate engineering maturity, risk triage, rollback strategies, and stakeholder communication.",
      expectedKeywords: [
        "risk",
        "stakeholder",
        "triage",
        "rollback",
        "severity",
        "testing",
        "communication",
      ],
      idealAnswerOutline:
        "Triage bug severity, evaluate blast radius, communicate transparently with stakeholders offering pragmatic alternatives (feature flags, hotfix timeline), and document root cause.",
    },
    {
      id: "q5_closing",
      phase: "closing",
      phaseLabel: "Engineering Growth & Wrap-up",
      question: `Thank you for those insights. As our final question: what is a recent technical paradigm, library, or engineering practice you have explored, and how does it influence how you write software today?`,
      contextHint:
        "Show genuine technical curiosity, continuous learning, and practical evaluation of new tech.",
      expectedKeywords: [
        "learning",
        "explored",
        "pattern",
        "system",
        "tool",
        "productivity",
        "future",
      ],
      idealAnswerOutline:
        "Discusses an emerging practice (e.g., AI-assisted workflows, edge rendering, modern compiler toolchains) with critical reflection on its pros and cons.",
    },
  ];
}

/**
 * Evaluates whether an answer is pure noise, a trivial greeting, or non-technical filler.
 */
function isTrivialOrGreeting(text: string): { isTrivial: boolean; isGreetingOnly: boolean } {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed || trimmed === "[unanswered]" || trimmed === "none" || trimmed === "n/a") {
    return { isTrivial: true, isGreetingOnly: false };
  }

  // Greetings list
  const greetings = new Set([
    "hello",
    "hi",
    "hey",
    "hi there",
    "hello there",
    "good morning",
    "good afternoon",
    "good evening",
    "greetings",
    "hey mira",
    "hello mira",
  ]);
  if (greetings.has(trimmed)) {
    return { isTrivial: true, isGreetingOnly: true };
  }

  // Non-answers and single characters
  const nonAnswers = new Set([
    "yes",
    "no",
    "ok",
    "okay",
    "sure",
    "fine",
    "test",
    "testing",
    "idk",
    "i dont know",
    "i don't know",
    "pass",
    "skip",
    "nothing",
    "bye",
    "thanks",
    "thank you",
  ]);
  if (nonAnswers.has(trimmed)) {
    return { isTrivial: true, isGreetingOnly: false };
  }

  // Single characters or repeating gibberish (e.g., "s", "aaaa", "wfdf")
  if (trimmed.length <= 2) {
    return { isTrivial: true, isGreetingOnly: false };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1 && /^(.)\1+$/.test(trimmed)) {
    return { isTrivial: true, isGreetingOnly: false };
  }

  return { isTrivial: false, isGreetingOnly: false };
}

/**
 * Computes an objective, evidence-based scorecard from candidate answers.
 */
export function evaluateInterviewSession(
  candidateName: string,
  targetJobTitle: string,
  questions: InterviewQuestion[],
  answers: Record<string, string>,
  durations: Record<string, number>,
): InterviewScorecard {
  let totalTechnical = 0;
  let totalClarity = 0;
  let totalRelevance = 0;
  let substantiveAnswersCount = 0;

  const totalDurationSeconds = Object.values(durations).reduce((acc, d) => acc + d, 0);
  const minutes = Math.floor(totalDurationSeconds / 60);
  const seconds = totalDurationSeconds % 60;
  const durationFormatted = `${minutes > 0 ? `${minutes}m ` : ""}${seconds}s`;

  const processedAnswers: CandidateAnswerRecord[] = questions.map((q) => {
    const rawAnswer = (answers[q.id] || "").trim();
    const duration = durations[q.id] || 30;
    const lower = rawAnswer.toLowerCase();
    const words = rawAnswer.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // Check trivial or greeting
    const { isTrivial, isGreetingOnly } = isTrivialOrGreeting(rawAnswer);

    // Keyword overlap
    const allTokens = q.expectedKeywords
      .flatMap((k) => k.toLowerCase().split(/\s+/))
      .filter((t) => t.length > 2);
    const matchedTokens = allTokens.filter((token) => lower.includes(token));
    const matchedCount = matchedTokens.length;
    const tokenRatio =
      allTokens.length > 0
        ? Math.min(1, matchedCount / Math.max(2, Math.min(5, allTokens.length * 0.4)))
        : 0;

    const matchedNames = Array.from(new Set(matchedTokens));

    let technicalScore = 0;
    let clarityScore = 0;
    let relevanceScore = 0;
    const strengths: string[] = [];
    const improvements: string[] = [];

    if (wordCount === 0 || rawAnswer === "[Unanswered]") {
      // Unanswered question
      technicalScore = 0;
      clarityScore = 0;
      relevanceScore = 0;
      strengths.push("No answer recorded for this question.");
      improvements.push(
        "No response was captured. Ensure your microphone is active or type your answer before submitting.",
      );
    } else if (isTrivial) {
      if (isGreetingOnly) {
        technicalScore = 0;
        clarityScore = 15;
        relevanceScore = 0;
        strengths.push("Polite conversational opening.");
        improvements.push(
          "Answer was only a greeting without technical depth or role experience. Directly address the question prompt with concrete examples.",
        );
      } else {
        technicalScore = 0;
        clarityScore = 0;
        relevanceScore = 0;
        strengths.push("No substantive technical content provided.");
        improvements.push(
          "Non-responsive or non-technical input captured. Provide a detailed technical explanation addressing the question requirements.",
        );
      }
    } else if (wordCount < 7 && matchedCount === 0) {
      // Non-technical brief phrase (e.g. "I don't remember really")
      technicalScore = 5;
      clarityScore = 25;
      relevanceScore = 10;
      strengths.push("Brief verbal engagement with topic.");
      improvements.push(
        "Response was too brief and omitted core technical terminology. Expand on system mechanisms and implementation.",
      );
      substantiveAnswersCount++;
    } else {
      // Substantive answer: score based on keyword depth, technical density, and structure
      const substanceBonus = wordCount >= 35 ? 24 : wordCount >= 18 ? 16 : wordCount >= 10 ? 8 : 0;
      const matchBonus =
        matchedCount >= 3 ? 32 : matchedCount >= 2 ? 24 : matchedCount >= 1 ? 14 : 0;
      const keywordScore = Math.round(tokenRatio * 32);

      technicalScore = Math.min(96, Math.max(20, 20 + keywordScore + matchBonus + substanceBonus));
      clarityScore = Math.min(
        96,
        Math.max(
          40,
          50 + (wordCount >= 25 ? 26 : wordCount >= 14 ? 18 : 6) + (matchedCount > 0 ? 14 : 0),
        ),
      );
      relevanceScore = Math.min(
        95,
        Math.max(25, 25 + Math.round(tokenRatio * 35) + matchBonus + (substanceBonus > 0 ? 10 : 0)),
      );

      if (matchedCount >= 2) {
        strengths.push(
          "Articulated practical experience with context and domain terminology.",
          `Directly addressed target concepts: ${matchedNames.slice(0, 3).join(", ")}.`,
        );
      } else if (matchedCount === 1) {
        strengths.push(`Referenced core domain concept: ${matchedNames[0]}.`);
      } else {
        strengths.push("Articulated general contextual background.");
      }

      if (wordCount < 18) {
        improvements.push(
          "Response was concise; expand on specific architectural trade-offs and personal ownership.",
        );
      }
      if (wordCount < 30) {
        improvements.push(
          "Could provide concrete production metrics or measurable outcomes from past experience.",
        );
      } else {
        improvements.push(
          "Consider citing specific automated testing patterns, failure modes, or rollback runbooks.",
        );
      }
      substantiveAnswersCount++;
    }

    totalTechnical += technicalScore;
    totalClarity += clarityScore;
    totalRelevance += relevanceScore;

    return {
      questionId: q.id,
      question: q.question,
      phaseLabel: q.phaseLabel,
      transcribedAnswer: rawAnswer || "No verbal or typed answer captured during session.",
      durationSeconds: duration,
      metrics: {
        technicalScore,
        clarityScore,
        relevanceScore,
      },
      strengths:
        strengths.length > 0 ? strengths : ["Demonstrated engagement with the question topic."],
      improvements:
        improvements.length > 0
          ? improvements
          : ["Provide deeper comparison of alternative architectural approaches."],
      modelAnswer: q.idealAnswerOutline,
    };
  });

  const totalQuestions = questions.length || 5;
  const avgTechnical = Math.round(totalTechnical / totalQuestions);
  const avgClarity = Math.round(totalClarity / totalQuestions);
  const avgRelevance = Math.round(totalRelevance / totalQuestions);
  const avgEvidence = Math.round(avgTechnical * 0.6 + avgRelevance * 0.4);

  // Overall Score Formula
  const overall = Math.round(
    avgTechnical * 0.4 + avgRelevance * 0.25 + avgClarity * 0.2 + avgEvidence * 0.15,
  );
  const clampedOverall = Math.min(100, Math.max(0, overall));

  const verdict: InterviewScorecard["fitVerdict"] =
    clampedOverall >= 75 ? "Strong Fit" : clampedOverall >= 50 ? "Moderate Fit" : "Developing Fit";

  // Dynamic, honest takeaways and gaps grounded in performance
  let keyTakeaways: string[];
  let gaps: string[];
  let recruiterVerificationNotes: string[];

  if (clampedOverall < 35 || substantiveAnswersCount === 0) {
    keyTakeaways = [
      `${candidateName} provided minimal or non-substantive responses across the majority of interview phases.`,
      `Critical gap: Insufficient technical evidence captured to verify competencies required for the ${targetJobTitle} position.`,
      `Candidate did not demonstrate practical architecture trade-offs, system mechanisms, or hands-on problem solving.`,
    ];
    gaps = [
      "Multiple interview phases were skipped, unanswered, or answered with non-technical single-word responses.",
      `Core ${targetJobTitle} technical principles were not articulated during the session.`,
      "Spoken communication was insufficient to evaluate clarity, technical vocabulary, or reasoning structure.",
    ];
    recruiterVerificationNotes = [
      `Conduct a preliminary recruiter phone screen to assess basic communication and interest in the ${targetJobTitle} role.`,
      "Verify whether brevity was due to hardware/microphone configuration or candidate unfamiliarity with the stack.",
      "Require a verified portfolio, GitHub repository, or take-home assessment before allocating engineering interview resources.",
    ];
  } else if (clampedOverall < 65) {
    keyTakeaways = [
      `${candidateName} demonstrated foundational familiarity with core tools, but responses remained predominantly high-level.`,
      `Strongest alignment identified in ${avgClarity >= avgTechnical ? "communication clarity and openness" : "familiarity with target technology names"}.`,
      `Technical depth requires deeper probing: candidate named tools without fully detailing implementation constraints or trade-offs.`,
    ];
    gaps = processedAnswers
      .flatMap((a) => a.improvements)
      .filter((imp) => !imp.includes("No response was captured"))
      .slice(0, 3);
    if (gaps.length === 0) {
      gaps = [
        "Elaborate on production scalability constraints and disaster recovery patterns.",
        "Provide measurable production metrics and quantifiable impact from prior engineering projects.",
      ];
    }
    recruiterVerificationNotes = [
      "In the live technical round, focus on system design scenarios and probe past production failure modes.",
      "Ask candidate to walk through a real code sample or architecture diagram to verify hands-on execution.",
    ];
  } else {
    keyTakeaways = [
      `${candidateName} demonstrated ${verdict === "Strong Fit" ? "rigorous technical depth and structured problem solving" : "competent domain knowledge"} across the interview phases.`,
      `Strongest performance identified in ${avgTechnical >= avgClarity ? "technical architecture and domain terminology" : "articulate communication and clear reasoning"}.`,
      `Recommended next step: Proceed to live technical panel focusing on real-world system boundaries and organizational fit.`,
    ];
    gaps = processedAnswers.flatMap((a) => a.improvements).slice(0, 3);
    recruiterVerificationNotes = [
      "Validate candidate's specific ownership and code contributions on flagship projects mentioned in Question 2.",
      "Probe candidate's experience collaborating cross-functionally with product managers and stakeholders under tight deadlines.",
    ];
  }

  return {
    candidateName,
    targetJobTitle,
    overallScore: clampedOverall,
    fitVerdict: verdict,
    completedAt: new Date().toISOString(),
    durationFormatted,
    categories: {
      technicalAccuracy: avgTechnical,
      communicationClarity: avgClarity,
      problemSolving: avgRelevance,
      practicalEvidence: avgEvidence,
    },
    answers: processedAnswers,
    keyTakeaways,
    gaps,
    recruiterVerificationNotes,
  };
}
