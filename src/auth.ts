import type { Env } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key: string, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 常量时间字符串比较, 防时序攻击 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return m ? m[1] : null;
}

// ---------------- 会话 ----------------

export async function createSession(env: Env): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ exp: Date.now() + 7 * 86400_000 })));
  const sig = b64urlEncode(await hmacSha256(env.SESSION_SECRET, payload));
  return `${payload}.${sig}`;
}

export async function verifySession(env: Env, cookieHeader: string | null): Promise<boolean> {
  const token = getCookie(cookieHeader, "pan_session");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = b64urlEncode(await hmacSha256(env.SESSION_SECRET, payload));
  if (!safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(dec.decode(b64urlDecode(payload))) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(value: string, maxAge: number): string {
  return `pan_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `pan_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---------------- 分享密码 ----------------

export async function hashSharePassword(env: Env, password: string): Promise<string> {
  return sha256Hex(`share:${env.SESSION_SECRET}:${password}`);
}

/** 分享页通过密码校验后写入的 cookie(按分享 id 区分) */
export async function createShareToken(env: Env, shareId: string): Promise<string> {
  return b64urlEncode(await hmacSha256(env.SESSION_SECRET, `share-access:${shareId}`));
}

export async function verifyShareToken(
  env: Env,
  shareId: string,
  cookieHeader: string | null
): Promise<boolean> {
  const token = getCookie(cookieHeader, `share_${shareId}`);
  if (!token) return false;
  const expected = b64urlEncode(await hmacSha256(env.SESSION_SECRET, `share-access:${shareId}`));
  return safeEqual(token, expected);
}

export function shareCookie(shareId: string, value: string): string {
  return `share_${shareId}=${value}; HttpOnly; SameSite=Lax; Path=/s/${shareId}; Max-Age=86400`;
}
