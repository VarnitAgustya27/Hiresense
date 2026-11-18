import datasetBank from "@/data/interview-questions-dataset.json";
import type { InterviewQuestion } from "@/lib/ai-interview";

export type ProfileCategory =
  | "data_scientist"
  | "machine_learning_engineer"
  | "data_analyst"
  | "data_engineer"
  | "python_developer"
  | "sql_database_engineer"
  | "frontend_engineer"
  | "behavioral_general";

export interface DatasetQuestionItem {
  id: string;
  question: string;
  category: string;
  domain: string;
  company?: string | null;
  phase: "intro" | "technical" | "architecture" | "scenario" | "closing";
  contextHint: string;
  expectedKeywords: string[];
  idealAnswerOutline: string;
}

interface DatasetBankCategory {
  title: string;
  totalInDataset: number;
  questions: DatasetQuestionItem[];
}

type DatasetBankType = Record<string, DatasetBankCategory>;

const bank = datasetBank as unknown as DatasetBankType;

/**
 * Detects the most relevant profile category based on the job title and posting details.
 */
export function detectProfileCategory(
  targetJobTitle: string,
  jobPosting?: Record<string, unknown>,
): ProfileCategory {
  const combined = `${targetJobTitle || ""} ${JSON.stringify(jobPosting || {})}`.toLowerCase();

  if (
    combined.includes("machine learning") ||
    combined.includes("ml engineer") ||
    combined.includes("deep learning") ||
    combined.includes("nlp") ||
    combined.includes("computer vision") ||
    combined.includes("ai engineer") ||
    combined.includes("artificial intelligence")
  ) {
    return "machine_learning_engineer";
  }

  if (
    combined.includes("data analyst") ||
    combined.includes("data analytics") ||
    combined.includes("business intelligence") ||
    combined.includes("bi analyst") ||
    combined.includes("tableau") ||
    combined.includes("reporting")
  ) {
    return "data_analyst";
  }

  if (
    combined.includes("data engineer") ||
    combined.includes("big data") ||
    combined.includes("etl") ||
    combined.includes("pipeline") ||
    combined.includes("spark") ||
    combined.includes("hadoop") ||
    combined.includes("data platform")
  ) {
    return "data_engineer";
  }

  if (
    combined.includes("data scientist") ||
    combined.includes("data science") ||
    combined.includes("statistician") ||
    combined.includes("applied scientist")
  ) {
    return "data_scientist";
  }

  if (
    combined.includes("sql") ||
    combined.includes("dba") ||
    combined.includes("database engineer") ||
    combined.includes("postgres") ||
    combined.includes("mysql")
  ) {
    return "sql_database_engineer";
  }

  if (
    combined.includes("frontend") ||
    combined.includes("front end") ||
    combined.includes("react") ||
    combined.includes("ui engineer") ||
    combined.includes("web developer") ||
    combined.includes("client engineer")
  ) {
    return "frontend_engineer";
  }

  if (
    combined.includes("python") ||
    combined.includes("backend") ||
    combined.includes("api") ||
    combined.includes("software engineer") ||
    combined.includes("software developer")
  ) {
    return "python_developer";
  }

  return "python_developer";
}

/**
 * Retrieves raw dataset questions for prompt few-shot grounding in LLM planning.
 */
export function getReferenceQuestionsForPrompt(
  targetJobTitle: string,
  company?: string,
  limit: number = 5,
): string[] {
  const category = detectProfileCategory(targetJobTitle);
  const catData = bank[category] || bank.python_developer;
  if (!catData || !catData.questions || catData.questions.length === 0) {
    return [];
  }

  const normalizedCompany = (company || "").trim().toLowerCase();

  // Prioritize matching company if specified
  const companyMatched = normalizedCompany
    ? catData.questions.filter(
        (q) => q.company && q.company.toLowerCase().includes(normalizedCompany),
      )
    : [];

  const others = catData.questions.filter((q) => !companyMatched.some((cq) => cq.id === q.id));

  const combined = [...companyMatched, ...others];
  return combined.slice(0, limit).map((q) => q.question);
}

/**
 * Builds a comprehensive 5-phase interview plan directly grounded in the dataset.
 */
export function generateQuestionsFromDataset(
  targetJobTitle: string,
  jobPosting: Record<string, unknown> = {},
  verificationQuestions: string[] = [],
): InterviewQuestion[] {
  const category = detectProfileCategory(targetJobTitle, jobPosting);
  const catData = bank[category] || bank.python_developer;
  const pool = catData?.questions || [];

  const companyName = (jobPosting?.company || jobPosting?.company_name || "") as string;
  const normalizedCompany = companyName.trim().toLowerCase();

  // Find company-specific questions if available
  const findInPool = (
    phase: "technical" | "architecture" | "scenario" | "closing",
    fallbackIndex: number,
  ): DatasetQuestionItem => {
    const phaseQuestions = pool.filter((q) => q.phase === phase);
    if (normalizedCompany) {
      const match = phaseQuestions.find(
        (q) => q.company && q.company.toLowerCase().includes(normalizedCompany),
      );
      if (match) return match;
    }
    if (phaseQuestions.length > 0) {
      return phaseQuestions[fallbackIndex % phaseQuestions.length];
    }
    // Fallback across entire pool
    return pool[fallbackIndex % pool.length];
  };

  // Phase 1: Intro
  const introQuestion: InterviewQuestion = {
    id: "q1_intro",
    phase: "intro",
    phaseLabel: "Background & Project Verification",
    question: `Hi, I'm Mira. Welcome to your interview for the ${targetJobTitle} position. To start, could you introduce yourself and walk me through the most technically challenging project you have worked on in ${catData.title}?`,
    contextHint:
      "Focus on technical context, architectural choices, your individual contributions, and measurable outcomes.",
    expectedKeywords: [
      "project",
      "architecture",
      "designed",
      "implemented",
      "scale",
      "impact",
      "team",
    ],
    idealAnswerOutline:
      "Clear 2-minute overview introducing background, explaining the business/technical problem, tools used, individual contribution, and quantifiable outcome.",
  };

  // Phase 2: Technical Depth
  const technicalItem = findInPool("technical", 0);
  const technicalQuestion: InterviewQuestion = {
    id: "q2_technical",
    phase: "technical",
    phaseLabel: "Core Domain & Technical Depth",
    question:
      verificationQuestions &&
      verificationQuestions.length > 0 &&
      verificationQuestions[0].length > 15
        ? verificationQuestions[0]
        : technicalItem?.question ||
          `What are the most critical technical principles and performance considerations you rely on when building in ${catData.title}?`,
    contextHint:
      technicalItem?.contextHint ||
      `Demonstrate depth of knowledge in ${catData.title}, addressing edge cases, algorithmic efficiency, and real-world application.`,
    expectedKeywords: [
      ...(technicalItem?.expectedKeywords || []),
      "state",
      "cache",
      "async",
      "performance",
      "architecture",
    ],
    idealAnswerOutline:
      technicalItem?.idealAnswerOutline ||
      "Directly defines core concepts, contrasts alternatives, provides a concrete implementation example, and notes performance considerations.",
  };

  // Phase 3: Architecture & System Design
  const archItem = findInPool("architecture", 0);
  const archQuestion: InterviewQuestion = {
    id: "q3_architecture",
    phase: "architecture",
    phaseLabel: "Architecture & Scale",
    question:
      archItem?.question ||
      `When scaling systems and pipelines in ${catData.title}, what architectural bottlenecks do you actively monitor and how do you resolve them?`,
    contextHint:
      archItem?.contextHint ||
      "Discuss architectural tradeoffs, scalability bottlenecks, fault tolerance, and system constraints.",
    expectedKeywords: [
      ...(archItem?.expectedKeywords || []),
      "render",
      "bundle",
      "vitals",
      "performance",
      "scale",
      "bottlenecks",
      "caching",
    ],
    idealAnswerOutline:
      archItem?.idealAnswerOutline ||
      "Defines requirements, breaks down components, addresses bottlenecks (concurrency, data volume, network/disk I/O), and justifies design choices.",
  };

  // Phase 4: Situational / Real-world Scenario
  const scenarioItem = findInPool("scenario", 0);
  const scenarioQuestion: InterviewQuestion = {
    id: "q4_scenario",
    phase: "scenario",
    phaseLabel: "Situational Judgment & Problem Solving",
    question:
      scenarioItem?.question ||
      `Imagine you discover a critical anomaly or regression in a production workflow right before a major milestone. How do you triage the risk and communicate with stakeholders?`,
    contextHint:
      scenarioItem?.contextHint ||
      "Demonstrate analytical rigor, pragmatic communication with stakeholders, and structured problem-solving.",
    expectedKeywords: [
      ...(scenarioItem?.expectedKeywords || []),
      "risk",
      "stakeholder",
      "triage",
      "rollback",
      "communication",
      "severity",
    ],
    idealAnswerOutline:
      scenarioItem?.idealAnswerOutline ||
      "Identifies core problem, evaluates options pragmatically, explains mitigation strategy, communicates clearly, and reflects on root causes.",
  };

  // Phase 5: Closing & Evolution
  const closingItem = findInPool("closing", 0);
  const closingQuestion: InterviewQuestion = {
    id: "q5_closing",
    phase: "closing",
    phaseLabel: "Engineering Growth & Wrap-up",
    question:
      closingItem?.question ||
      `To wrap up our interview: what is a recent methodology, emerging tool, or engineering practice in ${catData.title} that you have explored, and how does it influence your work?`,
    contextHint:
      closingItem?.contextHint ||
      "Highlight technical curiosity, engineering best practices, and continuous professional development.",
    expectedKeywords: [
      ...(closingItem?.expectedKeywords || []),
      "practice",
      "learning",
      "explored",
      "compiler",
      "rendering",
      "architecture",
    ],
    idealAnswerOutline:
      closingItem?.idealAnswerOutline ||
      "Shares concrete examples of recently adopted patterns or tools, assessing tradeoffs and long-term maintainability.",
  };

  return [introQuestion, technicalQuestion, archQuestion, scenarioQuestion, closingQuestion];
}
