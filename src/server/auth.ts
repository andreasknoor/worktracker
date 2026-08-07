import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dashboardPassword, dashboardSessionSecret } from "./config.js";

const API_KEY_PREFIX = "wtk_live_";
export const DASHBOARD_SESSION_COOKIE = "wtk_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Generates a new raw device API key. Only ever returned to the caller once, at creation time. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("hex");
}

/**
 * API keys are high-entropy random tokens (not user-chosen passwords), so a
 * fast, unsalted hash is standard practice here — the same approach GitHub
 * and Stripe use for their token verification lookups.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Vercel's Hobby plan has no way to password-protect a production domain
 * (Password Protection is a Pro/Enterprise-only add-on, and Hobby's built-in
 * Vercel Authentication never covers production — see the D3 investigation).
 * So the dashboard implements its own gate: a single shared secret compared
 * in constant time, backed by a stateless HMAC-signed session cookie.
 */
export function verifyDashboardPassword(submitted: string): boolean {
  const expected = dashboardPassword();
  if (!expected) return false;

  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac("sha256", dashboardSessionSecret()).update(payload).digest("hex");
}

/** Issues a signed, stateless session token (no server-side session storage needed). */
export function createSessionToken(nowMs: number = Date.now()): string {
  const expiresAt = nowMs + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined, nowMs: number = Date.now()): boolean {
  if (!token) return false;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && nowMs < expiresAt;
}
