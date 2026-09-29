const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hash(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export interface Sealed {
  kid: string;
  iv: string;
  ciphertext: string;
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(keys: string, kid: string): Promise<CryptoKey> {
  const raw = (JSON.parse(keys) as Record<string, string>)[kid];
  if (!raw || decode(raw).length !== 32)
    throw new Error("Invalid encryption key configuration");
  return crypto.subtle.importKey("raw", decode(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  value: string,
  aad: string,
  keys: string,
  kid: string,
): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    await key(keys, kid),
    encoder.encode(value),
  );
  return {
    kid,
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
}
export async function unseal(
  value: Sealed,
  aad: string,
  keys: string,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(value.iv),
      additionalData: encoder.encode(aad),
    },
    await key(keys, value.kid),
    decode(value.ciphertext),
  );
  return new TextDecoder().decode(plain);
}
