import { describe, it, expect } from "vitest";
import {
  detectProfileCategory,
  generateQuestionsFromDataset,
  getReferenceQuestionsForPrompt,
} from "@/lib/interview-dataset";

describe("HireSense Interview Dataset Integration", () => {
  it("detects profile categories correctly across different job titles", () => {
    expect(detectProfileCategory("Senior Data Scientist")).toBe("data_scientist");
    expect(detectProfileCategory("Lead Machine Learning Engineer")).toBe(
      "machine_learning_engineer",
    );
    expect(detectProfileCategory("Senior Data Analyst")).toBe("data_analyst");
    expect(detectProfileCategory("Data Platform Engineer (ETL/Spark)")).toBe("data_engineer");
    expect(detectProfileCategory("PostgreSQL Database Administrator")).toBe(
      "sql_database_engineer",
    );
    expect(detectProfileCategory("Staff Frontend Engineer (React/TypeScript)")).toBe(
      "frontend_engineer",
    );
    expect(detectProfileCategory("Backend Python Developer")).toBe("python_developer");
  });

  it("generates 5 distinct, role-grounded dataset questions for Data Scientist", () => {
    const questions = generateQuestionsFromDataset("Data Scientist");
    expect(questions).toHaveLength(5);
    expect(questions[0].phase).toBe("intro");
    expect(questions[1].phase).toBe("technical");
    expect(questions[2].phase).toBe("architecture");
    expect(questions[3].phase).toBe("scenario");
    expect(questions[4].phase).toBe("closing");

    expect(questions[0].question).toContain("Data Scientist");
    expect(questions[1].expectedKeywords.length).toBeGreaterThan(0);
  });

  it("generates role-grounded questions for Data Analyst and Data Engineer", () => {
    const daQuestions = generateQuestionsFromDataset("Senior Data Analyst");
    expect(daQuestions).toHaveLength(5);
    expect(daQuestions[0].question).toContain("Senior Data Analyst");

    const deQuestions = generateQuestionsFromDataset("Big Data Engineer");
    expect(deQuestions).toHaveLength(5);
    expect(deQuestions[0].question).toContain("Big Data Engineer");
  });

  it("matches company-specific questions when company is specified", () => {
    const awsQuestions = generateQuestionsFromDataset("Machine Learning Engineer", {
      company: "AWS",
    });
    expect(awsQuestions).toHaveLength(5);

    const goldmanQuestions = generateQuestionsFromDataset("Data Scientist", {
      company: "Goldman Sachs",
    });
    expect(goldmanQuestions).toHaveLength(5);
  });

  it("extracts reference benchmark questions for LLM prompt grounding", () => {
    const refQuestions = getReferenceQuestionsForPrompt("Machine Learning Engineer", "AWS", 4);
    expect(refQuestions.length).toBeGreaterThan(0);
    expect(refQuestions.length).toBeLessThanOrEqual(4);
    expect(typeof refQuestions[0]).toBe("string");
  });
});
