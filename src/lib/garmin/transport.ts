/**
 * BLE transport abstraction. The real implementation uses Web Bluetooth; tests
 * and the demo mode use an in-memory fake.
 */

export interface BleTransport {
  /** Writes one GATT packet to the Multi-Link TX characteristic */
  write(packet: Uint8Array): Promise<void>;
  /** Registers the handler for notifications from the Multi-Link RX characteristic */
  onNotification(handler: (packet: Uint8Array) => void): void;
  onDisconnect(handler: () => void): void;
  disconnect(): Promise<void>;
  readonly id: string;
  readonly name: string;
}

export const GARMIN_ML_SERVICE = "6a4e2800-667b-11e3-949a-0800200c9a66";
const RX = [0x2810, 0x2811, 0x2812, 0x2813, 0x2814];
const TX = [0x2820, 0x2821, 0x2822, 0x2823, 0x2824];
const uuid = (short: number) => `6a4e${short.toString(16)}-667b-11e3-949a-0800200c9a66`;

/** 16-bit "Garmin International" service UUID that Garmin devices advertise */
const GARMIN_ADV_SERVICE = 0xfe1f;

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export async function isBluetoothAdapterAvailable(): Promise<boolean> {
  if (!isWebBluetoothAvailable()) return false;
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return true;
  }
}

/** Opens the browser's device chooser. Must be called from a user gesture. */
export async function requestGarminDevice(showAll = false): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) throw new Error("Web Bluetooth non è disponibile in questo browser");
  const optionalServices = [GARMIN_ML_SERVICE, GARMIN_ADV_SERVICE, "battery_service", "device_information"];
  if (showAll) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  return navigator.bluetooth.requestDevice({
    filters: [
      { services: [GARMIN_ADV_SERVICE] },
      { services: [GARMIN_ML_SERVICE] },
      { namePrefix: "vívosmart" },
      { namePrefix: "vivosmart" },
      { namePrefix: "vívo" },
      { namePrefix: "Forerunner" },
      { namePrefix: "Venu" },
      { namePrefix: "Instinct" },
      { namePrefix: "fēnix" },
    ],
    optionalServices,
  });
}

/** Devices this origin already has permission for (Chrome only, may be unsupported). */
export async function getPermittedDevices(): Promise<BluetoothDevice[]> {
  try {
    const bt = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    return bt.getDevices ? await bt.getDevices() : [];
  } catch {
    return [];
  }
}

export class WebBluetoothTransport implements BleTransport {
  private tx!: BluetoothRemoteGATTCharacteristic;
  private rx!: BluetoothRemoteGATTCharacteristic;
  private notifyHandler: (p: Uint8Array) => void = () => {};
  private disconnectHandlers: (() => void)[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private useWithoutResponse = false;

  private constructor(private device: BluetoothDevice) {}

  get id() {
    return this.device.id;
  }
  get name() {
    return this.device.name ?? "Garmin";
  }

  static async connect(device: BluetoothDevice, log: (m: string) => void): Promise<WebBluetoothTransport> {
    const t = new WebBluetoothTransport(device);
    device.addEventListener("gattserverdisconnected", () => t.disconnectHandlers.forEach((h) => h()));
    log(`Connessione GATT a ${device.name ?? device.id}…`);
    const server = await withTimeout(device.gatt!.connect(), 20_000, "Timeout connessione GATT");
    const service = await server.getPrimaryService(GARMIN_ML_SERVICE);
    for (let i = 0; i < RX.length; i++) {
      try {
        const rx = await service.getCharacteristic(uuid(RX[i]));
        const tx = await service.getCharacteristic(uuid(TX[i]));
        t.rx = rx;
        t.tx = tx;
        log(`Caratteristiche Multi-Link trovate: ${RX[i].toString(16)} / ${TX[i].toString(16)}`);
        break;
      } catch {
        /* try next pair */
      }
    }
    if (!t.rx || !t.tx) throw new Error("Caratteristiche Garmin Multi-Link non trovate: è un dispositivo Garmin compatibile?");
    t.useWithoutResponse = !!t.tx.properties.writeWithoutResponse && !t.tx.properties.write;
    t.rx.addEventListener("characteristicvaluechanged", (ev) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value!;
      t.notifyHandler(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await t.rx.startNotifications();
    return t;
  }

  write(packet: Uint8Array): Promise<void> {
    const p = this.writeChain.then(async () => {
      const data = new Uint8Array(packet); // ensure ArrayBuffer-backed copy
      if (this.useWithoutResponse) await this.tx.writeValueWithoutResponse(data);
      else await this.tx.writeValueWithResponse(data);
    });
    this.writeChain = p.catch(() => {});
    return p;
  }

  onNotification(handler: (packet: Uint8Array) => void) {
    this.notifyHandler = handler;
  }

  onDisconnect(handler: () => void) {
    this.disconnectHandlers.push(handler);
  }

  async disconnect() {
    try {
      await this.rx?.stopNotifications();
    } catch {
      /* ignore */
    }
    this.device.gatt?.disconnect();
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
