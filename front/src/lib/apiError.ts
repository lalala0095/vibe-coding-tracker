// The API answers a rejected write (400 / 404 / 409) with a `detail` string
// written for a person — e.g. "3 time entries on this task use Project X —
// move them to another project first." Show it verbatim; fall back to the
// caller's message for anything else (network failure, validation arrays).
import axios from 'axios';

export function errorDetail(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) {
    const data: unknown = e.response?.data;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
