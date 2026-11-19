import { createVapidKey, decode64, deliverPush, digest } from "./web-push.mjs";

const GROUPS_API = "https://script.google.com/macros/s/AKfycbxwZ3znGm_yQVV8YFCoSb_hPn8iz_GqYBt2N4OuBk6oSUd4wFTQgXPCXKVr3JQsZ8AFYg/exec";
const EVENT_TYPES = ["added", "edited", "removed", "note"];
const money = new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK" });

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedJson(request) {
  if (!request.body) throw new Error("Body missing");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return JSON.parse(raw + decoder.decode());
    bytes += next.value.length;
    if (bytes > 8192) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    raw += decoder.decode(next.value, { stream: true });
  }
}

export function validSubscription(subscription) {
  try {
    const endpoint = new URL(subscription.endpoint);
    const allowed = /^(?:[a-z0-9-]+\.)*push\.apple\.com$/.test(endpoint.hostname)
      || ["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(endpoint.hostname)
      || /^[a-z0-9-]+\.notify\.windows\.com$/.test(endpoint.hostname);
    const publicKey = decode64(subscription.keys.p256dh);
    return allowed && endpoint.protocol === "https:" && !endpoint.port && !endpoint.username && !endpoint.password
      && !endpoint.hash && endpoint.href.length <= 2048 && publicKey.length === 65 && publicKey[0] === 4
      && decode64(subscription.keys.auth).length === 16;
  } catch {
    return false;
  }
}

async function readGroup(token) {
  const url = new URL(GROUPS_API);
  url.search = new URLSearchParams({ action: "read", token, callback: "groupData" });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Group data unavailable");
  const match = /^groupData\(([\s\S]*)\);?\s*$/.exec((await response.text()).trim());
  if (!match) throw new Error("Unexpected group response");
  const result = JSON.parse(match[1]);
  return result.ok && result.group ? result.group.data || {} : null;
}

async function expenseRecord(expense) {
  return {
    fingerprint: await digest(JSON.stringify([
      expense.description, Number(expense.amount), expense.payer, expense.date,
      [...(expense.participants || [])].sort(), Object.entries(expense.shares || {}).sort(),
    ])),
    amount: Number(expense.amount),
    author: String(expense.addedByName || "").slice(0, 80),
  };
}

async function snapshot(group) {
  return {
    expenses: Object.fromEntries(await Promise.all((Array.isArray(group.expenses) ? group.expenses : [])
      .filter(expense => expense && typeof expense.id === "string")
      .map(async expense => [expense.id, await expenseRecord(expense)]))),
    notes: (Array.isArray(group.notes) ? group.notes : [])
      .filter(note => note && typeof note.id === "string").map(note => note.id),
  };
}

export function classifyChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const [id, entry] of Object.entries(current.expenses)) {
    const before = Object.hasOwn(previous.expenses, id) ? previous.expenses[id] : null;
    if (!before) changes.push({ type: "added", entry });
    else if (before.fingerprint !== entry.fingerprint) changes.push({ type: "edited", entry });
  }
  for (const [id, entry] of Object.entries(previous.expenses)) {
    if (!Object.hasOwn(current.expenses, id)) changes.push({ type: "removed", entry });
  }
  const knownNotes = new Set(previous.notes);
  for (const id of current.notes) {
    if (!knownNotes.has(id)) changes.push({ type: "note" });
  }
  return changes;
}

function notificationFor(changes, subscription) {
  const related = changes.filter(change => subscription.types.includes(change.type));
  if (!related.length) return null;
  const newest = related.find(change => change.type === "added") || related[0];
  const title = { added: "Nový výdaj", edited: "Upravený výdaj", removed: "Smazaný výdaj", note: "Nová poznámka" }[newest.type];
  const amount = Number.isFinite(newest.entry?.amount) ? money.format(newest.entry.amount) : "";
  const singleBody = newest.type === "added"
    ? [newest.entry.author ? "Zapsal(a) " + newest.entry.author : "", amount].filter(Boolean).join(" · ")
    : amount || "Ve sdílené skupině je nová poznámka.";
  const others = related.length > 1 ? " (+ další změny: " + (related.length - 1) + ")" : "";
  return { title, body: singleBody + others, groupId: subscription.groupId };
}

export class PushStore {
  constructor(context, env) {
    this.storage = context.storage;
    this.env = env;
    this.pending = Promise.resolve();
  }

  fetch(request) {
    const queued = this.pending.then(() => this.handle(request));
    this.pending = queued.catch(() => {});
    return queued;
  }

  alarm() {
    const queued = this.pending.then(() => this.sendTests());
    this.pending = queued.catch(() => {});
    return queued;
  }

  async sendTests() {
    const pending = await this.storage.list({prefix: "test:"});
    const now = Date.now();
    let next = Infinity;
    for (const [key, due] of pending) {
      if (due > now) { next = Math.min(next, due); continue; }
      const device = await this.storage.get(key.slice(5));
      if (device) {
        const resultKey = "result:" + key.slice(5);
        try {
          const response = await deliverPush(device, {title: "Test upozornění", body: "Oznámení na tomto zařízení fungují.", groupId: device.groupId}, await getKey(this.env), this.env.APP_ORIGIN);
          await this.storage.put(resultKey, {state: response.ok ? "accepted" : "rejected", code: response.status});
          if (response.status === 429 || response.status >= 500) throw new Error("Retry");
        } catch (error) {
          if (error.message !== "Retry") await this.storage.put(resultKey, {state: "failed"});
          throw error;
        }
      }
      await this.storage.delete(key);
    }
    if (Number.isFinite(next)) await this.storage.setAlarm(next);
  }

  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === "/key") {
      let key = await this.storage.get("vapid");
      if (!key) {
        key = await createVapidKey();
        await this.storage.put("vapid", key);
      }
      return json(key);
    }
    const data = await request.json();
    if (path === "/test-status") {
      return json(await this.storage.get("result:sub:" + await digest(data.endpoint)) || {state: "unknown"});
    }
    if (path === "/test") {
      const id = "sub:" + await digest(data.endpoint);
      if (!await this.storage.get(id)) return json({error: "Device not subscribed"}, 404);
      const key = "test:" + id;
      const due = Date.now() + 20000;
      if (!await this.storage.get(key)) {
        await this.storage.put(key, due);
        await this.storage.put("result:" + id, {state: "pending"});
      }
      const alarm = await this.storage.getAlarm();
      if (alarm === null || alarm > due) await this.storage.setAlarm(due);
      return json({ok: true});
    }
    if (path === "/unsubscribe") {
      await this.storage.delete("sub:" + await digest(data.endpoint));
      return json({ ok: true });
    }
    const subscriptions = await this.storage.list({ prefix: "sub:", limit: 40 });
    if (path === "/sync" && !subscriptions.size) return json({ ok: true, delivered: 0 });
    const group = await readGroup(data.token);
    if (!group) return json({ error: "Group not found" }, 404);
    const previous = await this.storage.get("snapshot");
    const current = await snapshot(group);
    if (path === "/subscribe") {
      const key = "sub:" + await digest(data.subscription.endpoint);
      if (subscriptions.size >= 40 && !subscriptions.has(key)) return json({ error: "Group device limit reached" }, 409);
      await this.storage.put(key, { ...data.subscription, types: data.types, groupId: data.groupId });
      if (!previous || !subscriptions.size) await this.storage.put("snapshot", current);
      return json({ ok: true });
    }
    const changes = classifyChanges(previous, current);
    if (!changes.length) return json({ ok: true, delivered: 0 });
    await this.storage.put("snapshot", current);
    const vapid = await getKey(this.env);
    const results = await Promise.allSettled([...subscriptions].map(async ([id, subscription]) => {
      if (id === data.sender) return false;
      const notification = notificationFor(changes, subscription);
      if (!notification) return false;
      const response = await deliverPush(subscription, notification, vapid, this.env.APP_ORIGIN);
      if (response.status === 404 || response.status === 410) await this.storage.delete(id);
      return response.ok;
    }));
    return json({ ok: true, delivered: results.filter(result => result.status === "fulfilled" && result.value).length });
  }
}

async function getKey(env) {
  const store = env.PUSH_STORE.get(env.PUSH_STORE.idFromName("vapid-v1"));
  return (await store.fetch("https://internal/key")).json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const path = new URL(request.url).pathname;
    const cors = {
      "Access-Control-Allow-Origin": env.APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const reply = (value, status = 200) => Response.json(value, { status, headers: { ...cors, "Cache-Control": "no-store" } });
    if (path === "/health" && request.method === "GET") return reply({ ok: true });
    if (origin !== env.APP_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (path === "/config" && request.method === "GET") return reply({ publicKey: (await getKey(env)).publicKey });
      if (request.method !== "POST" || !["/subscribe", "/unsubscribe", "/test", "/test-status", "/sync"].includes(path)) return reply({ error: "Not found" }, 404);
      let data;
      try { data = await boundedJson(request); }
      catch { return reply({ error: "Invalid body" }, 400); }
      if (!data || typeof data.token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(data.token)) return reply({ error: "Invalid group" }, 400);
      if (path === "/subscribe" && (
        !validSubscription(data.subscription) || typeof data.groupId !== "string" || !/^[\w-]{1,80}$/.test(data.groupId)
        || !Array.isArray(data.types) || data.types.length > EVENT_TYPES.length || data.types.some(type => !EVENT_TYPES.includes(type))
      )) return reply({ error: "Invalid subscription" }, 400);
      if (["/unsubscribe", "/test", "/test-status"].includes(path) && (typeof data.endpoint !== "string" || data.endpoint.length > 2048)) return reply({ error: "Invalid endpoint" }, 400);
      const id = env.PUSH_STORE.idFromName("group:" + await digest(data.token));
      const result = await env.PUSH_STORE.get(id).fetch("https://internal" + path, {
        method: "POST", body: JSON.stringify(data),
      });
      return reply(await result.json(), result.status);
    } catch {
      return reply({ error: "Notification service unavailable" }, 502);
    }
  },
};
