import { afterEach, describe, expect, it, vi } from "vitest";
import { WebBluetoothTransport } from "../src/lib/garmin/transport";

/**
 * Minimal stand-in for a Web Bluetooth device. `dropAt` makes the band close the link
 * on the given attempt, at the given step, like a band still held by another app.
 */
function fakeDevice(dropAt: (attempt: number) => "service" | "notify" | null) {
  const listeners = new Set<() => void>();
  let attempt = 0;
  let connected = false;
  const drop = () => {
    connected = false;
    listeners.forEach((l) => l());
  };
  const gone = () => Promise.reject(Object.assign(new Error("GATT Server is disconnected. Cannot perform GATT operations."), { name: "NetworkError" }));
  const characteristic = {
    properties: { write: true, writeWithoutResponse: false },
    addEventListener: () => {},
    startNotifications: () => {
      if (dropAt(attempt) === "notify") {
        drop();
        return gone();
      }
      return Promise.resolve();
    },
  };
  const server = {
    get connected() {
      return connected;
    },
    getPrimaryService: () => {
      if (dropAt(attempt) === "service") {
        drop();
        return gone();
      }
      return Promise.resolve({ getCharacteristic: () => Promise.resolve(characteristic) });
    },
  };
  const device = {
    id: "band",
    name: "vívosmart 5",
    gatt: {
      get connected() {
        return connected;
      },
      connect: () => {
        attempt++;
        connected = true;
        return Promise.resolve(server);
      },
      disconnect: () => {
        if (connected) drop();
      },
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  return { device: device as unknown as BluetoothDevice, attempts: () => attempt, listeners, drop };
}

describe("Web Bluetooth transport setup", () => {
  afterEach(() => vi.useRealTimers());

  it("retries when the band drops the link during setup", async () => {
    vi.useFakeTimers();
    const f = fakeDevice((n) => (n === 1 ? "service" : null));
    const logs: string[] = [];
    const p = WebBluetoothTransport.connect(f.device, (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(5000);
    const t = await p;
    expect(f.attempts()).toBe(2);
    expect(logs.some((l) => l.includes("nuovo tentativo"))).toBe(true);
    // only the live connection's listener is left, and it reports a later disconnect once
    expect(f.listeners.size).toBe(1);
    let gone = 0;
    t.onDisconnect(() => gone++);
    f.drop();
    f.drop();
    expect(gone).toBe(1);
  });

  it("gives up with an explanation after repeated drops", async () => {
    vi.useFakeTimers();
    const f = fakeDevice(() => "notify");
    const p = WebBluetoothTransport.connect(f.device, () => {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10000);
    const err = (await p) as Error;
    expect(f.attempts()).toBe(3);
    expect(err.message).toContain("abbinamento");
    expect(err.message).toContain("Gadgetbridge");
    expect(f.listeners.size).toBe(0);
  });
});
