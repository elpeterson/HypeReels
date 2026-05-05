import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PersonCard } from "../PersonCard";
import type { Person } from "@/types";

// Mock env
jest.mock("@/lib/env", () => ({
  LOW_CONFIDENCE_THRESHOLD: 0.7,
}));

const mockPerson: Person = {
  person_id: "person-1",
  bbox: [0, 0, 100, 100],
  thumbnail: "session-1/persons/person-1.jpg",
  thumbnail_url: null,
  confidence: 0.85,
  appearances: [
    { clip_id: "clip-1", timestamp_ms: 1000 },
    { clip_id: "clip-2", timestamp_ms: 2000 },
  ],
};

describe("PersonCard", () => {
  it("renders without crash", () => {
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={jest.fn()}
        index={0}
      />
    );
    expect(screen.getByRole("radio")).toBeInTheDocument();
  });

  it("shows confidence percentage", () => {
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={jest.fn()}
        index={0}
      />
    );
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("shows clip appearance count", () => {
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={jest.fn()}
        index={0}
      />
    );
    expect(screen.getByText(/2 clips/)).toBeInTheDocument();
  });

  it("is keyboard selectable (role=radio)", () => {
    const onSelect = jest.fn();
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={onSelect}
        index={0}
      />
    );
    const card = screen.getByRole("radio");
    expect(card).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("person-1");
  });

  it("calls onSelect when clicked", () => {
    const onSelect = jest.fn();
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={onSelect}
        index={0}
      />
    );
    fireEvent.click(screen.getByRole("radio"));
    expect(onSelect).toHaveBeenCalledWith("person-1");
  });

  it("shows aria-checked=true when selected", () => {
    render(
      <PersonCard
        person={mockPerson}
        selected={true}
        onSelect={jest.fn()}
        index={0}
      />
    );
    expect(screen.getByRole("radio")).toHaveAttribute("aria-checked", "true");
  });

  it("shows low confidence badge for low confidence persons", () => {
    const lowConfPerson: Person = { ...mockPerson, confidence: 0.5 };
    render(
      <PersonCard
        person={lowConfPerson}
        selected={false}
        onSelect={jest.fn()}
        index={0}
      />
    );
    // Low confidence badge is aria-hidden but the aria-label includes it
    const card = screen.getByRole("radio");
    expect(card).toHaveAttribute("aria-label", expect.stringContaining("low confidence"));
  });

  it("has descriptive aria-label", () => {
    render(
      <PersonCard
        person={mockPerson}
        selected={false}
        onSelect={jest.fn()}
        index={0}
      />
    );
    const card = screen.getByRole("radio");
    // Label must include meaningful info — confidence, clips
    expect(card).toHaveAttribute("aria-label", expect.stringContaining("85%"));
    expect(card).toHaveAttribute("aria-label", expect.stringContaining("2 clip"));
  });
});
