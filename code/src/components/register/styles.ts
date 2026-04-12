// Static style constants — extracted from inline JSX to avoid new object creation on every render.
// React skips re-renders when props are referentially equal; inline `style={{}}` creates a new object each time.

export const S = {
  textPrimary: { color: "var(--text-primary)" },
  textSecondary: { color: "var(--text-secondary)" },
  surfaceAccent: { color: "var(--surface-accent)" },
  surfacePanel: { background: "var(--surface-panel)" },
  surfacePanelMuted: { background: "var(--surface-panel-muted)" },
  borderSubtle: { borderColor: "var(--border-subtle)" },
  borderBSubtle: { borderBottom: "1px solid var(--border-subtle)" },
  borderTopSubtle: { borderTop: "1px solid var(--border-subtle)" },
  panelWithBorder: { borderColor: "var(--border-subtle)", background: "var(--surface-panel)" },
  panelMutedWithBorder: { borderColor: "var(--border-subtle)", background: "var(--surface-panel-muted)", color: "var(--text-primary)" },
  panelMutedWithSecondary: { background: "var(--surface-panel-muted)", color: "var(--text-secondary)" },
  panelWithBorderSecondary: { borderColor: "var(--border-subtle)", background: "var(--surface-panel)", color: "var(--text-secondary)" },
  panelWithBorderPrimary: { borderColor: "var(--border-subtle)", background: "var(--surface-panel)", color: "var(--text-primary)" },
  scrollbarThin: { scrollbarWidth: "thin" },
  aspect4x3: { aspectRatio: "4/3" },
} as const;
