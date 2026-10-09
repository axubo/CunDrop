/**
 * AWS Signature V4 预签名 URL(用于浏览器直传 R2)
 * R2 的 S3 兼容 endpoint: https://<accountId>.r2.cloudflarestorage.com
 * region 固定为 "auto", service 为 "s3"
 */

const enc = new TextEncoder();

async function sha256HexStr(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

async function getSignatureKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacBytes(enc.encode("AWS4" + secret).buffer as ArrayBuffer, dateStamp);
  const kRegion = await hmacBytes(kDate, region);
  const kService = await hmacBytes(kRegion, service);
  return hmacBytes(kService, "aws4_request");
}

function toAmzDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PresignOpts {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** 对象 key(仅允许 URL 安全字符, 调用方保证) */
  key: string;
  /** 有效期(秒) */
  expiresIn: number;
}

/** 生成一个 PUT 预签名 URL, 浏览器可直接 PUT 文件到 R2(单文件上限 5GB) */
export async function presignedPutUrl(o: PresignOpts): Promise<string> {
  const host = `${o.accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${o.accessKeyId}/${scope}`;

  const encodedKey = o.key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");

  // 参数名已按字典序排列
  const qp = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalQuery = qp.toString();

  const canonicalRequest = [
    "PUT",
    `/${o.bucket}/${encodedKey}`,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256HexStr(canonicalRequest)].join(
    "\n"
  );

  const signingKey = await getSignatureKey(o.secretAccessKey, dateStamp, region, service);
  const signature = bytesToHex(await hmacBytes(signingKey, stringToSign));

  return `https://${host}/${o.bucket}/${encodedKey}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
