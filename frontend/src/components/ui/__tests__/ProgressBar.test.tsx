import React from "react";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "../ProgressBar";

describe("ProgressBar", () => {
  it("renders without crash", () => {
    render(<ProgressBar value={50} ariaLabel="Upload progress" />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("sets aria-valuenow to clamped percentage", () => {
    render(<ProgressBar value={75} ariaLabel="Test progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "75");
  });

  it("clamps value above 100 to 100", () => {
    render(<ProgressBar value={150} ariaLabel="Test" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("clamps value below 0 to 0", () => {
    render(<ProgressBar value={-10} ariaLabel="Test" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows percentage text when showPercentage is true", () => {
    render(<ProgressBar value={42} showPercentage ariaLabel="Test" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("shows label when provided", () => {
    render(<ProgressBar value={50} label="Uploading file" />);
    expect(screen.getByText("Uploading file")).toBeInTheDocument();
  });

  it("has correct aria attributes for screen readers", () => {
    render(<ProgressBar value={30} ariaLabel="Custom label" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-label", "Custom label");
  });
});
