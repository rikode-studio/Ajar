"use server";

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { lessonProgress, quizAttempts, quizQuestions, quizzes } from "@/lib/db/schema";
import { getSession } from "@/lib/auth";
import { markLessonComplete } from "./lesson-progress";
import { awardXP } from "./xp";

type SubmitQuizInput = {
  quizId: string;
  lessonId: string;
  selectedAnswers: string[]; // List of selected choice IDs in question order
};

export async function submitQuizAttempt(input: SubmitQuizInput) {
  const session = await getSession();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }

  // ponytail: grade on server from DB choices — never trust client-supplied correctAnswers or userId
  const quiz = await db.query.quizzes.findFirst({
    where: eq(quizzes.id, input.quizId),
    with: {
      questions: {
        orderBy: [asc(quizQuestions.order)],
        with: {
          choices: true,
        },
      },
    },
  });

  if (!quiz || quiz.lessonId !== input.lessonId) {
    throw new Error("Quiz tidak ditemukan");
  }

  const correctAnswers = quiz.questions.map(
    (q) => q.choices.find((c) => c.isCorrect)?.id || ""
  );

  const maxScore = correctAnswers.length;
  const score = input.selectedAnswers.reduce((total, answer, index) => {
    return total + Number(Boolean(answer) && answer === correctAnswers[index]);
  }, 0);

  const percentage = Math.round((score / Math.max(1, maxScore)) * 100);

  // Save attempt to database
  await db.insert(quizAttempts).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    quizId: input.quizId,
    answers: JSON.stringify(input.selectedAnswers),
    score: score,
    submittedAt: new Date(),
  });

  // If score >= 80%, mark lesson as complete and award XP once
  let nextLessonId = null;
  if (percentage >= 80) {
    const alreadyCompleted = await db.query.lessonProgress.findFirst({
      where: and(
        eq(lessonProgress.userId, session.user.id),
        eq(lessonProgress.lessonId, input.lessonId)
      ),
    });

    if (!alreadyCompleted) {
      await awardXP(session.user.id, 50, `Passed quiz: ${input.quizId}`);
    }

    const result = await markLessonComplete(input.lessonId);
    nextLessonId = result.nextLessonId;
  }

  return {
    score,
    maxScore,
    percentage,
    passed: percentage >= 80,
    nextLessonId,
    correctAnswers,
  };
}
