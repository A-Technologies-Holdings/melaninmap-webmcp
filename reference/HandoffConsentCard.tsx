/**
 * On-page human confirmation card for agent-initiated hand-offs.
 *
 * Deliberately plain product voice — a confirmation prompt is not the place
 * for personality. Styling follows the host site's existing consent banner
 * (surface #17110D, gold #C9963B, rounded-2xl, uppercase tracking buttons);
 * restyle freely, the behavior below is the part to keep.
 *
 * The consent token constant lives ONLY in this module and leaves it only
 * through resolvePendingConsentRequest() when the person clicks Confirm —
 * tool execute code cannot fabricate a confirmation.
 *
 * Mounted by the registrar into its own React root (sonner-style dedicated
 * container) via ensureHandoffConsentCardMounted(), so the card exists only
 * when a WebMCP-capable browser is present and App.tsx stays untouched.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  getPendingConsentRequest,
  resolvePendingConsentRequest,
  subscribeToConsentRequests,
} from "./consentBridge";

/** Never export this. See module docblock. */
const CONSENT_TOKEN = "user_confirmed_v1";

const CONTAINER_ID = "mm-webmcp-consent-root";

function getServerSnapshot() {
  return null;
}

function decline() {
  resolvePendingConsentRequest({ status: "declined" });
}

function confirm() {
  resolvePendingConsentRequest({
    status: "confirmed",
    consentToken: CONSENT_TOKEN,
  });
}

export default function HandoffConsentCard() {
  const request = useSyncExternalStore(
    subscribeToConsentRequests,
    getPendingConsentRequest,
    getServerSnapshot,
  );

  const declineRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request) {
      // Focus starts on Decline so Enter cannot be an accidental consent.
      declineRef.current?.focus();
    }
  }, [request]);

  if (!request) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      decline();
      return;
    }
    if (event.key === "Tab") {
      // Simple two-stop focus trap between Decline and Confirm.
      event.preventDefault();
      if (document.activeElement === declineRef.current) {
        confirmRef.current?.focus();
      } else {
        declineRef.current?.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
      onClick={decline}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-webmcp-consent-title"
        aria-describedby="mm-webmcp-consent-body"
        className="w-full max-w-md rounded-2xl border px-5 py-5"
        style={{
          backgroundColor: "#17110D",
          borderColor: "rgba(201, 150, 59, 0.2)",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2
          id="mm-webmcp-consent-title"
          className="text-base font-semibold"
          style={{ color: "#C9963B" }}
        >
          Confirm assistant hand-off
        </h2>
        <p
          id="mm-webmcp-consent-body"
          className="mt-2 text-sm leading-relaxed"
          style={{ color: "#B8A08A" }}
        >
          An assistant in your browser wants to start a tracked hand-off for:{" "}
          <span className="font-semibold" style={{ color: "#C9963B" }}>
            {request.targetName}
          </span>
          . This shares an anonymous attribution token with the destination. No
          account, name, or contact info is shared.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={declineRef}
            type="button"
            onClick={decline}
            className="px-4 py-2 rounded-full text-xs font-semibold uppercase tracking-[0.08em]"
            style={{
              color: "#8B7355",
              border: "1px solid rgba(139, 115, 85, 0.3)",
            }}
          >
            Decline
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={confirm}
            className="px-4 py-2 rounded-full text-xs font-semibold uppercase tracking-[0.08em]"
            style={{ backgroundColor: "#C9963B", color: "#0D0907" }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

let mounted = false;

/**
 * Mounts the card into a dedicated container div with its own React root
 * (the sonner-toast precedent for out-of-tree UI). Idempotent; safe to call
 * from non-React code. Renders null until a consent request is pending.
 */
export function ensureHandoffConsentCardMounted(): void {
  if (mounted || typeof document === "undefined") return;
  if (document.getElementById(CONTAINER_ID)) {
    mounted = true;
    return;
  }
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  document.body.appendChild(container);
  createRoot(container).render(<HandoffConsentCard />);
  mounted = true;
}
