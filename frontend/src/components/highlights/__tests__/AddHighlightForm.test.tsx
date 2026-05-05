import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddHighlightForm } from "../HighlightRange";

describe("AddHighlightForm", () => {
  const defaultProps = {
    clipDurationMs: 60_000, // 60 seconds
    existingHighlights: [],
    onAdd: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders without crash", () => {
    render(<AddHighlightForm {...defaultProps} />);
    expect(screen.getByLabelText("Start (seconds)")).toBeInTheDocument();
    expect(screen.getByLabelText("End (seconds)")).toBeInTheDocument();
  });

  it("has visible labels for all inputs", () => {
    render(<AddHighlightForm {...defaultProps} />);
    // All form inputs have visible labels — not placeholder-only
    expect(screen.getByText("Start (seconds)")).toBeInTheDocument();
    expect(screen.getByText("End (seconds)")).toBeInTheDocument();
  });

  it("calls onAdd with correct ms values", () => {
    const onAdd = jest.fn();
    render(<AddHighlightForm {...defaultProps} onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("End (seconds)"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect(onAdd).toHaveBeenCalledWith(5000, 15000);
  });

  it("shows error when duration is less than 1 second", () => {
    render(<AddHighlightForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("End (seconds)"), { target: { value: "5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect(screen.getByRole("alert")).toHaveTextContent("at least 1 second");
    expect(defaultProps.onAdd).not.toHaveBeenCalled();
  });

  it("shows error when end <= start", () => {
    render(<AddHighlightForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("End (seconds)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect(screen.getByRole("alert")).toHaveTextContent("End time must be after start time");
    expect(defaultProps.onAdd).not.toHaveBeenCalled();
  });

  it("shows error when end exceeds clip duration", () => {
    render(<AddHighlightForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "55" } });
    fireEvent.change(screen.getByLabelText("End (seconds)"), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect(screen.getByRole("alert")).toHaveTextContent("clip duration");
    expect(defaultProps.onAdd).not.toHaveBeenCalled();
  });

  it("shows error on overlap with existing highlight", () => {
    const existing = [{ highlight_id: "h1", start_ms: 10_000, end_ms: 20_000 }];
    render(<AddHighlightForm {...defaultProps} existingHighlights={existing} />);

    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("End (seconds)"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect(screen.getByRole("alert")).toHaveTextContent("overlaps");
    expect(defaultProps.onAdd).not.toHaveBeenCalled();
  });

  it("Add button is disabled when inputs are empty", () => {
    render(<AddHighlightForm {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Add highlight range" })).toBeDisabled();
  });

  it("clears inputs after successful add", () => {
    const onAdd = jest.fn();
    render(<AddHighlightForm {...defaultProps} onAdd={onAdd} />);

    const startInput = screen.getByLabelText("Start (seconds)");
    const endInput = screen.getByLabelText("End (seconds)");

    fireEvent.change(startInput, { target: { value: "5" } });
    fireEvent.change(endInput, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Add highlight range" }));

    expect((startInput as HTMLInputElement).value).toBe("");
    expect((endInput as HTMLInputElement).value).toBe("");
  });
});
