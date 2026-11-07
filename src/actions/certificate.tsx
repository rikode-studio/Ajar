"use server";

import { pdf } from "@react-pdf/renderer";

import { getSession } from "@/lib/auth";
import { sendCertificateEmail } from "@/lib/email/resend";
import { CertificateDocument } from "@/lib/pdf/certificate";

type GenerateCertificateInput = {
  userName: string;
  userEmail: string;
  courseTitle: string;
};

export async function generateCertificate(input: GenerateCertificateInput) {
  // ponytail: enforce auth so anonymous callers cannot trigger PDF rendering or outbound emails
  const session = await getSession();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }

  const certificateCode = `AJR-${Date.now()}`;
  const issuedAt = new Date().toISOString();

  const document = (
    <CertificateDocument
      userName={session.user.name || input.userName}
      courseTitle={input.courseTitle}
      certificateCode={certificateCode}
      issuedAt={issuedAt}
      certId={certificateCode}
    />
  );

  const instance = pdf(document);
  const pdfStream = await instance.toBuffer();

  await sendCertificateEmail({
    to: session.user.email,
    courseTitle: input.courseTitle,
    certificateCode,
  });

  return {
    certificateCode,
    issuedAt,
    hasPdfStream: Boolean(pdfStream),
  };
}
