import { NextResponse } from "next/server";
import { getHomepageSettings } from "@/lib/db";

/** جلب إعدادات الصفحة الرئيسية (عام — للصفحة الرئيسية والهيدر) */
export async function GET() {
  try {
    const settings = await getHomepageSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error("API settings/homepage:", error);
    return NextResponse.json(
      { error: "Homepage settings are temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
