import type { Metadata } from "next";
import "./globals.css";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

export const metadata: Metadata = {
  title: "HypeReels — Beat-Synced Video Highlight Reels",
  description:
    "Automatically generate high-energy hype reel videos from your clips, cut to the beat.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-white antialiased">
        <ErrorBoundary>
          <header className="border-b border-gray-800">
            <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
              <span
                className="text-red-500 text-2xl font-black tracking-tight"
                aria-label="HypeReels logo"
              >
                HYPE<span className="text-white">REELS</span>
              </span>
              <span className="text-gray-600 text-sm hidden sm:block">
                Beat-synced video highlights
              </span>
            </div>
          </header>
          <main id="main-content" className="max-w-5xl mx-auto px-4 py-8">
            {children}
          </main>
        </ErrorBoundary>
      </body>
    </html>
  );
}
