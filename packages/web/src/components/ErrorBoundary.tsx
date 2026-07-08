import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defense: without a boundary, a single render-time throw
 * unmounts the whole React tree to a blank page with no recovery path.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render error:', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: '48px 32px', maxWidth: 640, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18, marginBottom: 12 }}>something broke in the UI</h1>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8, marginBottom: 20 }}>
          {this.state.error.message}
        </pre>
        <button style={{ padding: '6px 14px', cursor: 'pointer' }} onClick={() => window.location.reload()}>
          ↻ reload
        </button>
      </div>
    );
  }
}
