import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeOfflineStatus } from '@/utils/pwa';

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer!: TestPort;
  closed = false;
  close() {
    this.closed = true;
  }
  postMessage(value: unknown) {
    if (!this.peer.closed) this.peer.onmessage?.({ data: value } as MessageEvent);
  }
}
class TestChannel {
  port1 = new TestPort();
  port2 = new TestPort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
class TestWorker extends EventTarget {
  state: ServiceWorkerState = 'activated';
  messages: { data: { type: string }; port: TestPort }[] = [];
  postMessage(data: { type: string }, ports: TestPort[]) {
    this.messages.push({ data, port: ports[0] });
  }
  reply(ready: boolean) {
    this.messages.at(-1)!.port.postMessage({ type: 'OFFLINE_STATUS', ready });
  }
  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}
class TestRegistration extends EventTarget {
  installing: TestWorker | null = null;
  waiting: TestWorker | null = null;
}
class TestContainer extends EventTarget {
  controller: TestWorker | null = new TestWorker();
  registration = new TestRegistration();
  register = vi.fn(async () => this.registration);
}

describe('offline status subscription', () => {
  let container: TestContainer;
  let stop: (() => void) | undefined;
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MessageChannel', TestChannel);
    container = new TestContainer();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    if (originalServiceWorker)
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    else Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('waits for complete-cache confirmation from the controlling worker', async () => {
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith('checking', false);
    container.controller!.reply(true);
    expect(report).toHaveBeenLastCalledWith('ready', false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports missing cached assets as an error, and rechecks on focus', async () => {
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    await Promise.resolve();
    container.controller!.reply(false);
    expect(report).toHaveBeenLastCalledWith('error', false);
    window.dispatchEvent(new Event('focus'));
    container.controller!.reply(true);
    expect(report).toHaveBeenLastCalledWith('ready', false);
  });

  it('keeps only one pending check and disposes timers, ports, and listeners', async () => {
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    await Promise.resolve();
    for (let i = 0; i < 30; i += 1) window.dispatchEvent(new Event('focus'));
    expect(vi.getTimerCount()).toBe(1);
    container.controller!.reply(true);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    const count = container.controller!.messages.length;
    window.dispatchEvent(new Event('focus'));
    expect(container.controller!.messages).toHaveLength(count);
    expect(
      container.controller!.messages.every(({ port }) => port.closed && port.peer.closed),
    ).toBe(true);
  });

  it('announces an installed update even before registration.waiting is observable', async () => {
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    await Promise.resolve();
    container.controller!.reply(true);
    const oldController = container.controller;
    const update = new TestWorker();
    update.state = 'installing';
    container.registration.installing = update;
    container.registration.dispatchEvent(new Event('updatefound'));
    update.transition('installed');
    expect(container.registration.waiting).toBeNull();
    oldController!.reply(true);
    expect(report).toHaveBeenLastCalledWith('ready', true);
    expect(container.controller).toBe(oldController);
    expect(update.messages).toHaveLength(0);
    expect(oldController!.messages.every(({ data }) => data.type === 'CHECK_OFFLINE')).toBe(true);
  });

  it('times out without falsely indicating readiness', async () => {
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    await Promise.resolve();
    vi.advanceTimersByTime(8000);
    expect(report).toHaveBeenLastCalledWith('error', false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register an offline worker in development mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const report = vi.fn();
    stop = subscribeOfflineStatus(report);
    expect(report).toHaveBeenCalledWith('unavailable', false);
    expect(container.register).not.toHaveBeenCalled();
  });
});
