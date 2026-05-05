import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DropZone } from "../DropZone";

describe("DropZone", () => {
  const defaultProps = {
    id: "test-drop",
    accept: ".mp4,.mov",
    label: "Upload video",
    onFiles: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders without crash", () => {
    render(<DropZone {...defaultProps} />);
    expect(screen.getByText("Upload video")).toBeInTheDocument();
  });

  it("shows label (not placeholder-only)", () => {
    render(<DropZone {...defaultProps} label="Add video clips" />);
    // Label is visible, not just a placeholder
    const label = screen.getByText("Add video clips");
    expect(label.tagName).toBe("LABEL");
  });

  it("shows sublabel when provided", () => {
    render(<DropZone {...defaultProps} subLabel="MP4, MOV only" />);
    expect(screen.getByText("MP4, MOV only")).toBeInTheDocument();
  });

  it("is keyboard accessible via role=button", () => {
    render(<DropZone {...defaultProps} />);
    const zone = screen.getByRole("button");
    expect(zone).toBeInTheDocument();
    expect(zone).toHaveAttribute("tabIndex", "0");
  });

  it("marks aria-disabled when disabled", () => {
    render(<DropZone {...defaultProps} disabled />);
    const zone = screen.getByRole("button");
    expect(zone).toHaveAttribute("aria-disabled", "true");
    expect(zone).toHaveAttribute("tabIndex", "-1");
  });

  it("calls onFiles when files are selected via input", () => {
    const onFiles = jest.fn();
    render(<DropZone {...defaultProps} onFiles={onFiles} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    const file = new File(["content"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(input, "files", { value: [file], writable: false });
    fireEvent.change(input);

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("calls onFiles on drop", () => {
    const onFiles = jest.fn();
    render(<DropZone {...defaultProps} onFiles={onFiles} />);

    const zone = screen.getByRole("button");
    const file = new File(["content"], "clip.mp4", { type: "video/mp4" });

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, {
      dataTransfer: { files: [file] },
    });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("does not call onFiles when disabled and files dropped", () => {
    const onFiles = jest.fn();
    render(<DropZone {...defaultProps} disabled onFiles={onFiles} />);

    const zone = screen.getByRole("button");
    const file = new File(["content"], "clip.mp4", { type: "video/mp4" });

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("updates visual state on drag over", () => {
    render(<DropZone {...defaultProps} />);
    const zone = screen.getByRole("button");

    fireEvent.dragOver(zone);
    expect(screen.getByText("Drop files here")).toBeInTheDocument();
  });
});
