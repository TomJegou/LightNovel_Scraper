import type { Metadata } from "next";

import { getBook } from "@/lib/library";

type RouteParams = Promise<{ id: string; slug: string }>;

export async function generateMetadata({
  params,
}: {
  params: RouteParams;
}): Promise<Metadata> {
  const { id } = await params;
  const libraryId = Number(id);
  if (!Number.isFinite(libraryId) || libraryId <= 0 || String(libraryId) !== id) {
    return { title: "Reader" };
  }
  const entry = getBook(libraryId);
  if (!entry) {
    return { title: "Reader" };
  }
  const label = entry.title?.trim() || entry.bookId;
  return { title: label };
}

export default function ReadBookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
