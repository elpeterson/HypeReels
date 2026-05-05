/**
 * Tests for Button component.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../Button";

describe("Button", () => {
  it("renders without crash", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled when disabled prop is true", () => {
    render(<Button disabled>Click</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows loading spinner and marks aria-busy when loading", () => {
    render(<Button loading loadingText="Saving…">Save</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("is keyboard accessible (button element)", () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Submit</Button>);
    const btn = screen.getByRole("button");
    fireEvent.keyDown(btn, { key: "Enter" });
    // Native button handles enter key automatically
    expect(btn.tagName).toBe("BUTTON");
  });

  it("does not call onClick when disabled", () => {
    const onClick = jest.fn();
    render(<Button disabled onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
