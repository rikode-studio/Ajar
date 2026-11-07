"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enrollments, payments } from "@/lib/db/schema";
import { createDokuCheckoutSession } from "@/lib/payment/doku";
import { createStripeCheckoutSession } from "@/lib/payment/stripe";
import { features } from "@/lib/features";

import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

type StartCheckoutInput = {
  courseId: string;
  courseTitle: string;
  courseSlug?: string;
  amount: number;
  currency: string;
};

export async function startCheckout(input: StartCheckoutInput) {
  const session = await getSession();

  if (!session?.user) {
    throw new Error("Anda harus login untuk membeli kursus");
  }

  const paymentId = `INV-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  // ponytail: always read price, currency, and slug from DB — never trust client input
  const course = await db.query.courses.findFirst({
    where: (c, { eq }) => eq(c.id, input.courseId),
  });

  if (!course || course.status !== "published") {
    throw new Error("Kursus tidak ditemukan atau belum dipublikasikan");
  }

  const price = Number(course.price);
  if (price <= 0) {
    throw new Error("Kursus ini gratis, silakan daftar tanpa pembayaran");
  }

  const currency = course.currency || "IDR";
  const courseSlug = course.slug || "course";
  const locale = await getLocale();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Check if DOKU is enabled (default primary)
  if (features.doku) {
    // Create pending payment record
    await db.insert(payments).values({
      id: paymentId,
      userId: session.user.id,
      courseId: course.id,
      amount: price.toString(),
      currency,
      gateway: "doku",
      status: "pending",
    });

    // Ensure enrollment exists with pending status
    await db
      .insert(enrollments)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        courseId: course.id,
        paymentStatus: "pending",
      })
      .onConflictDoUpdate({
        target: [enrollments.userId, enrollments.courseId],
        set: { paymentStatus: "pending" },
      });

    const dokuSession = await createDokuCheckoutSession({
      orderId: paymentId,
      amount: price,
      courseTitle: input.courseTitle,
      courseSlug,
      userId: session.user.id,
      customerName: session.user.name || "Student",
      customerEmail: session.user.email,
      locale,
      appUrl,
    });

    await db
      .update(payments)
      .set({ gatewayId: dokuSession.invoiceNumber })
      .where(eq(payments.id, paymentId));

    return {
      provider: "doku",
      checkoutUrl: dokuSession.url,
    };
  }

  if (features.stripe) {
    await db.insert(payments).values({
      id: paymentId,
      userId: session.user.id,
      courseId: course.id,
      amount: price.toString(),
      currency,
      gateway: "stripe",
      status: "pending",
    });

    await db
      .insert(enrollments)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        courseId: course.id,
        paymentStatus: "pending",
      })
      .onConflictDoUpdate({
        target: [enrollments.userId, enrollments.courseId],
        set: { paymentStatus: "pending" },
      });

    const sessionStripe = await createStripeCheckoutSession({
      orderId: paymentId,
      amount: price,
      currency,
      courseTitle: input.courseTitle,
      courseId: course.id,
      userId: session.user.id,
      customerEmail: session.user.email,
      successUrl: `${appUrl}/${locale}/my-courses?status=success`,
      cancelUrl: `${appUrl}/${locale}/courses/${courseSlug}?status=cancelled`,
    });

    await db
      .update(payments)
      .set({ gatewayId: sessionStripe.id })
      .where(eq(payments.id, paymentId));

    return {
      provider: "stripe",
      checkoutUrl: sessionStripe.url || `${appUrl}/${locale}/my-courses`,
    };
  }

  throw new Error("Payment gateway is currently not configured");
}

export async function enrollFreeCourse(courseId: string) {
  const session = await getSession();
  const locale = await getLocale();

  if (!session?.user) {
    throw new Error("Anda harus login untuk mendaftar kursus");
  }

  // Fetch course slug, enrollmentType, and first lesson ID
  const course = await db.query.courses.findFirst({
    where: (c, { eq }) => eq(c.id, courseId),
    with: {
      modules: {
        orderBy: (m, { asc }) => [asc(m.order)],
        with: {
          lessons: {
            orderBy: (l, { asc }) => [asc(l.order)],
          },
        },
      },
    },
  });

  if (!course || course.status !== "published") throw new Error("Kursus tidak ditemukan");
  if (Number(course.price) > 0) {
    throw new Error("Kursus ini berbayar, silakan lakukan pembayaran terlebih dahulu");
  }

  const isManualApproval = course.enrollmentType === "manual";
  const initialStatus = isManualApproval ? "pending" : "paid";

  await db
    .insert(enrollments)
    .values({
      id: crypto.randomUUID(),
      userId: session.user.id,
      courseId: courseId,
      paymentStatus: initialStatus,
    })
    .onConflictDoUpdate({
      target: [enrollments.userId, enrollments.courseId],
      set: { paymentStatus: initialStatus },
    });

  const firstLesson = course.modules[0]?.lessons[0];
  const redirectUrl = isManualApproval
    ? `/courses/${course.slug}`
    : firstLesson
      ? `/learn/${course.slug}/${firstLesson.id}`
      : `/my-courses`;

  return {
    success: true,
    redirectUrl,
    isPendingApproval: isManualApproval,
    hasLessons: Boolean(firstLesson),
  };
}
