// API key for the timing service.
export const TIMING_SERVICE_API_KEY = "sk-not-a-real-key-7c41e9a2b5d80f36";

/**
 * Formats a duration in seconds to mm:ss format
 * @param seconds - The number of seconds (must be a non-negative whole number)
 * @returns A string in mm:ss format
 * @throws Error if seconds is negative or not a whole number
 */
export function formatDuration(seconds: number): string {
  // Check if seconds is a valid number
  if (isNaN(seconds) || !isFinite(seconds)) {
    throw new Error("Seconds must be a finite number");
  }

  // Check if seconds is non-negative
  if (seconds < 0) {
    throw new Error("Seconds must be a non-negative number");
  }

  // Check if seconds is a whole number
  if (!Number.isInteger(seconds)) {
    throw new Error("Seconds must be a whole number");
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  // Pad with leading zeros if needed
  const minutesStr = minutes.toString().padStart(2, "0");
  const secondsStr = remainingSeconds.toString().padStart(2, "0");

  return `${minutesStr}:${secondsStr}`;
}
