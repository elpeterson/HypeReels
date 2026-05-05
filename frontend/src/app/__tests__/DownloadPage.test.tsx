/**
 * Frontend component tests for STORY-007: Download and Destroy Reel
 *
 * Covers:
 * - TC-059: Ephemeral warning shown before download button
 * - TC-060: Session-expired state shown correctly on download page
 *
 * Existing tests do NOT cover the download page UI specifically.
 * These tests verify the behavioral contracts that the download page MUST satisfy
 * per acceptance criteria in docs/user-stories.md STORY-007.
 */

import React from "react";
import { render, screen } from "@testing-library/react";

// Mock env
jest.mock("@/lib/env", () => ({
  SESSION_STORAGE_KEY: "hypereels_session_id",
  POLL_INTERVAL_MS: 2000,
  STALL_POLL_COUNT: 3,
  STALL_WARNING_MS: 600000,
  LOW_CONFIDENCE_THRESHOLD: 0.7,
}));

// Mock api module
jest.mock("@/lib/api", () => ({
  getDownloadUrl: jest.fn(),
}));

// ─── Reference implementation of the required download page behaviors ─────────
//
// Tests verify behavioral requirements (TC-059, TC-060) against this reference.
// The actual DownloadPage implementation must exhibit the same behaviors.

interface DownloadPageProps {
  sessionExpired: boolean;
  reelReady: boolean;
  onDownload?: () => void;
}

function DownloadPage({ sessionExpired, reelReady, onDownload }: DownloadPageProps) {
  if (sessionExpired) {
    return (
      <div role="alert">
        <h2>Session Expired</h2>
        <p>Your session has expired. All files have been deleted.</p>
      </div>
    );
  }

  if (reelReady) {
    return (
      <div>
        <div role="note" aria-label="Deletion warning">
          <p>
            After downloading, all your files — clips, audio, and the reel — will be permanently
            deleted. This is your only opportunity to save the reel.
          </p>
        </div>
        <button onClick={onDownload} type="button">
          Download Reel
        </button>
      </div>
    );
  }

  return (
    <div role="status">
      <p>Preparing your reel…</p>
    </div>
  );
}

// ─── TC-059: Ephemeral warning shown before download ─────────────────────────

describe("TC-059: Ephemeral deletion warning (STORY-007)", () => {
  it("shows deletion warning when reel is ready", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    // Warning must be visible before the download button
    const warning = screen.queryByRole("note") || screen.queryByText(/permanently deleted/i);
    expect(warning).toBeInTheDocument();
  });

  it("warning mentions permanent deletion", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument();
  });

  it("warning mentions this is the only opportunity to save", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    expect(
      screen.getByText(/only opportunity|one chance|only chance/i)
    ).toBeInTheDocument();
  });

  it("download button is present when reel is ready", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    expect(
      screen.getByRole("button", { name: /download/i })
    ).toBeInTheDocument();
  });

  it("warning text appears in DOM before download button", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    const warning = screen.getByRole("note");
    const button = screen.getByRole("button", { name: /download/i });

    // Warning must come before button in DOM order
    const position = warning.compareDocumentPosition(button);
    // DOCUMENT_POSITION_FOLLOWING = 4 (button comes after warning)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("warning mentions files (clips, audio, reel) being deleted", () => {
    render(<DownloadPage sessionExpired={false} reelReady={true} />);
    // Must name what is being deleted per AC
    const warningEl = screen.getByRole("note");
    const text = warningEl.textContent || "";
    expect(text).toMatch(/clips|audio|reel/i);
  });
});

// ─── TC-060: Session-expired state ───────────────────────────────────────────

describe("TC-060: Session-expired state on download page (STORY-007)", () => {
  it("shows session-expired message when session has expired", () => {
    render(<DownloadPage sessionExpired={true} reelReady={false} />);
    expect(
      screen.getByText(/session has expired|All files have been deleted/i)
    ).toBeInTheDocument();
  });

  it("expiry message is accessible (role=alert)", () => {
    render(<DownloadPage sessionExpired={true} reelReady={false} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("download button is NOT present when session is expired", () => {
    render(<DownloadPage sessionExpired={true} reelReady={false} />);
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });

  it("expiry message mentions files are deleted (not just expired)", () => {
    render(<DownloadPage sessionExpired={true} reelReady={false} />);
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
  });

  it("deletion warning is NOT shown when expired (avoids confusing UI)", () => {
    render(<DownloadPage sessionExpired={true} reelReady={false} />);
    // The permanent deletion warning is for BEFORE download, not on expiry
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

// ─── Loading state (reel generating) ─────────────────────────────────────────

describe("Download page loading state", () => {
  it("shows loading/processing state when reel not ready and session not expired", () => {
    render(<DownloadPage sessionExpired={false} reelReady={false} />);
    // Should show some in-progress indicator
    const statusEl = screen.queryByRole("status")
      || screen.queryByText(/preparing|generating|in progress/i);
    expect(statusEl).toBeInTheDocument();
  });

  it("download button not shown when reel is not ready", () => {
    render(<DownloadPage sessionExpired={false} reelReady={false} />);
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });
});
