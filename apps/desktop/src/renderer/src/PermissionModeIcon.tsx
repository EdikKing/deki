import type { PermissionMode } from "./permissionModes";

export function PermissionModeIcon({ mode }: {
  mode: PermissionMode | "custom";
}) {
  return <span className={`permission-mode-icon ${mode}`} aria-hidden="true">
    {mode === "request" && <svg viewBox="0 0 24 24">
      <path d="M7 11V7.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M10 10V5.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M13 10V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M16 11V9a1.5 1.5 0 0 1 3 0v5c0 4.4-2.8 7-7 7h-1c-2.3 0-4.2-1-5.5-2.9l-2.2-3.2a1.6 1.6 0 0 1 2.4-2.1L7 14" />
    </svg>}
    {mode === "agent" && <svg viewBox="0 0 24 24">
      <path d="M12 2.8 20 7v10l-8 4.2L4 17V7l8-4.2Z" />
      <path d="m8.3 9.2 2.2 2-2.2 2" />
      <path d="M12.5 13.2h3.2" />
    </svg>}
    {mode === "full" && <svg viewBox="0 0 24 24">
      <path d="M12 2.7 20 6v6.1c0 4.8-3 7.7-8 9.2-5-1.5-8-4.4-8-9.2V6l8-3.3Z" />
      <path d="M12 7.5v5.7" />
      <path d="M12 16.8h.01" />
    </svg>}
    {mode === "custom" && <svg viewBox="0 0 24 24">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>}
  </span>;
}
