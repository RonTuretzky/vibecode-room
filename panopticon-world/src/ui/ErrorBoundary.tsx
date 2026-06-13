import { Component, type ErrorInfo, type ReactNode } from "react";

// Catches render errors in a subtree. If `fallback` is given (e.g. null for use
// inside a <Canvas>), renders that; otherwise shows the error on screen so a
// crash never silently blanks to purple.
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[panopticon-world] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="crash">
          <div className="crash-box snes-panel">
            <h2>⚠ scene error{this.props.label ? ` · ${this.props.label}` : ""}</h2>
            <pre>{this.state.error.message}</pre>
            <p>Open the browser console for the full stack. (This panel replaces the blank screen.)</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
