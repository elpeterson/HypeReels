import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../Modal";

describe("Modal", () => {
  const defaultProps = {
    open: true,
    title: "Confirm action",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    render(
      <Modal {...defaultProps} open={false}>
        <p>Dialog content</p>
      </Modal>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders when open", () => {
    render(
      <Modal {...defaultProps}>
        <p>Dialog content</p>
      </Modal>
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Confirm action")).toBeInTheDocument();
    expect(screen.getByText("Dialog content")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button clicked", () => {
    render(
      <Modal {...defaultProps}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked", () => {
    render(
      <Modal {...defaultProps}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape key pressed", () => {
    render(
      <Modal {...defaultProps}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("has aria-modal and aria-labelledby for accessibility", () => {
    render(
      <Modal {...defaultProps}>
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "modal-title");
  });

  it("shows loading state on confirm button", () => {
    render(
      <Modal {...defaultProps} confirmLoading confirmLoadingText="Deleting…">
        <p>Content</p>
      </Modal>
    );
    const confirmBtn = screen.getByRole("button", { name: /Deleting…/ });
    expect(confirmBtn).toHaveAttribute("aria-busy", "true");
  });
});
