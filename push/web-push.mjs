const text = new TextEncoder();

export function encode64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decode64(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

function join(...arrays) {
  const combined = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    combined.set(array, offset);
    offset += array.length;
  }
  return combined;
}

async function hkdf(secret, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// RFC 8291. A single aes128gcm record uses delimiter 0x02 and no extra padding.
export async function encryptPush(payload, subscription) {
  const receiver = decode64(subscription.keys.p256dh);
  const receiverKey = await crypto.subtle.importKey("raw", receiver, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sender = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, ephemeral.privateKey, 256);
  const info = join(text.encode("WebPush: info\0"), receiver, sender);
  const ikm = await hkdf(shared, decode64(subscription.keys.auth), info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(ikm, salt, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = join(text.encode(JSON.stringify(payload)), Uint8Array.of(2));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
  return join(salt, Uint8Array.of(0, 0, 16, 0, sender.length), sender, encrypted);
}

export async function createVapidKey() {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: encode64(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", key.privateKey),
  };
}

export async function deliverPush(subscription, payload, vapid, appOrigin) {
  const endpoint = new URL(subscription.endpoint);
  const key = await crypto.subtle.importKey("jwk", vapid.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const encode = value => encode64(text.encode(JSON.stringify(value)));
  const unsigned = [
    encode({ alg: "ES256", typ: "JWT" }),
    encode({ aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 6 * 3600, sub: appOrigin }),
  ].join(".");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(unsigned));
  return fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: "vapid t=" + unsigned + "." + encode64(new Uint8Array(signature)) + ", k=" + vapid.publicKey,
      TTL: "3600",
      Urgency: "normal",
    },
    body: await encryptPush(payload, subscription),
  });
}

export async function digest(value) {
  return encode64(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value))));
}
