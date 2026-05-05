"use client";

import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Top-level error boundary. Catches uncaught render errors.
 * Never shows raw error objects or stack traces to the user.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred. Please refresh and try again.";
    return { hasError: true, errorMessage };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // Log to console for debugging — never shown to user
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          className="min-h-screen flex items-center justify-center bg-gray-950 p-6"
        >
          <div className="max-w-md w-full bg-gray-900 rounded-xl border border-red-800 p-8 text-center">
            <div className="text-red-400 text-4xl mb-4" aria-hidden="true">
              ⚠
            </div>
            <h1 className="text-xl font-semibold text-white mb-3">
              Something went wrong
            </h1>
            <p className="text-gray-400 mb-6 text-sm leading-relaxed">
              {this.state.errorMessage}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-900"
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
