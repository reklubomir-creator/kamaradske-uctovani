(() => {
  const BASE = 'https://kamaradske-uctovani-push.rek-lubomir.workers.dev';
  const encoder = new TextEncoder();
  let lazyConfiguration;
  let nextHealthCheck = 0;
  let healthy = false;

  async function request(path, content) {
    const response = await fetch(BASE + path, {
      method: content ? 'POST' : 'GET',
      headers: content ? {'Content-Type':'application/json'} : {},
      body: content ? JSON.stringify(content) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Služba pro upozornění neodpověděla.');
    return response.json();
  }

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function configuration() {
    if (!lazyConfiguration) {
      lazyConfiguration = Promise.all([
        navigator.serviceWorker.register('./push-sw.js'),
        request('/config'),
      ]).then(async ([, { publicKey }]) => {
        const registration = await navigator.serviceWorker.ready;
        const decoded = atob(publicKey.replaceAll('-', '+').replaceAll('_', '/'));
        return {registration, applicationServerKey: Uint8Array.from(decoded, char => char.charCodeAt(0))};
      }).catch(error => {
        lazyConfiguration = null;
        throw error;
      });
    }
    return lazyConfiguration;
  }

  async function currentSubscription() {
    if (!supported()) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.pushManager.getSubscription() || null;
  }

  function enroll(setup) {
    return setup.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: setup.applicationServerKey });
  }

  async function apply(subscription, groups, types) {
    const records = Object.entries(groups).filter(([, token]) => Boolean(token));
    for (const [groupId, token] of records) {
      await request('/subscribe', { groupId, token, types, subscription: subscription.toJSON() });
    }
    return records.length;
  }

  async function stop(subscription, groups) {
    await subscription.unsubscribe();
    await Promise.allSettled(Object.values(groups).filter(Boolean).map(token =>
      request('/unsubscribe', { token, endpoint: subscription.endpoint })));
  }

  async function publish(token) {
    if (Date.now() >= nextHealthCheck) {
      nextHealthCheck = Date.now() + 60000;
      try { healthy = (await request('/health')).ok === true; }
      catch { healthy = false; }
    }
    if (!healthy) return;
    const subscription = await currentSubscription();
    let sender = null;
    if (subscription) {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(subscription.endpoint)));
      sender = 'sub:' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }
    await request('/sync', { token, sender });
  }

  async function test(token, subscription) {
    await request('/test', { token, endpoint: subscription.endpoint });
  }

  window.financePush = { test, supported, configuration, currentSubscription, enroll, apply, stop, publish };
})();
