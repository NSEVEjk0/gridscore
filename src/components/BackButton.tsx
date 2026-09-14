"use client";

/** A calm back button that returns to the previous app screen (or home). */
export function BackButton({ label = "Back" }: { label?: string }) {
  return (
    <button
      type="button"
      className="back-button"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          window.history.back();
        } else {
          window.location.href = "/";
        }
      }}
    >
      ← {label}
    </button>
  );
}
