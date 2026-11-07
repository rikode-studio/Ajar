import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";

import { getSession } from "@/lib/auth";
import { getPresignedUrl } from "@/lib/r2";

export async function POST(req: NextRequest) {
  try {
    // Require authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { filename, contentType, folder = "courses" } = await req.json();

    if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType are required" },
        { status: 400 }
      );
    }

    // ponytail: validate MIME type and restrict studio folders to instructors/admins
    const allowedMime = /^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm)|application\/pdf)$/i;
    if (!allowedMime.test(contentType)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }

    const isPrivileged = session.user.role === "instructor" || session.user.role === "admin";
    const safeFolder =
      ["courses", "thumbnails", "avatars", "general"].includes(folder) &&
      (isPrivileged || folder === "avatars")
        ? folder
        : "avatars";

    // Generate unique key
    const extension = (filename.split(".").pop() || "jpg").replace(/[^a-zA-Z0-9]/g, "");
    const key = `${safeFolder}/${session.user.id}-${nanoid(12)}.${extension}`;

    const result = await getPresignedUrl(key, contentType);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      url: result.url,
      publicUrl: result.publicUrl,
    });
  } catch (error: any) {
    console.error("R2 Upload Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
