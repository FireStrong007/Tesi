/**
 * The app's configuration, chosen when it is built (VITE_APP=vitabridge|heartbridge): name, device,
 * the sections it has and what it does with the ones its device does not measure. Colours and icon
 * follow it too (index.css `:root[data-brand=…]`, vite.config.ts brandAssets). The server it talks to
 * must be the same app (App.tsx checks /api/auth/me).
 */
export type AppId = "vitabridge" | "heartbridge";

/**
 * A section the device does not measure: "hidden" (not in the menus nor on the Home) or
 * "unavailable" (shown, with «Non disponibile con questo dispositivo»).
 */
export type MissingSection = "hidden" | "unavailable";

/** sections of VitaBridge that a watch may not have (resting_hr: the resting line and tile of «Battito») */
export type OptionalSection = "stress" | "energy" | "intensity" | "resting_hr";

export interface Brand {
  id: AppId;
  name: string;
  /** under the name, on the login page */
  tagline: string;
  /** the device, in sentences: «Il tuo bracciale non ha ancora registrato…» */
  device: { noun: string; the: string; your: string };
  /** sections the device does not measure, and what the app does with them */
  missing: Partial<Record<OptionalSection, MissingSection>>;
  /** HeartBridge's own sections */
  ecg: boolean;
  bloodPressure: boolean;
  temperature: boolean;
  /** the device reports its battery (Garmin BATTERY_LEVEL) */
  battery: boolean;
  /** minutes with activity are known (Garmin, per minute); not with 30-minute blocks (Gima) */
  activeMinutes: boolean;
}

const BRANDS: Record<AppId, Brand> = {
  vitabridge: {
    id: "vitabridge",
    name: "VitaBridge",
    tagline: "I dati del tuo bracciale per lo studio",
    device: { noun: "bracciale", the: "il bracciale", your: "il tuo bracciale" },
    missing: {},
    ecg: false,
    bloodPressure: false,
    temperature: false,
    battery: true,
    activeMinutes: true,
  },
  heartbridge: {
    id: "heartbridge",
    name: "HeartBridge",
    tagline: "I dati del tuo orologio per lo studio",
    device: { noun: "orologio", the: "l'orologio", your: "il tuo orologio" },
    // the Gima watches do not measure them; "unavailable" shows them with a notice
    missing: { stress: "hidden", energy: "hidden", intensity: "hidden", resting_hr: "hidden" },
    ecg: true,
    bloodPressure: true,
    temperature: true,
    battery: false,
    activeMinutes: false,
  },
};

export const BRAND: Brand = BRANDS[import.meta.env.VITE_APP === "heartbridge" ? "heartbridge" : "vitabridge"];

/** what the app does with a section: shown, hidden, or shown as not available on this device */
export const sectionMode = (s: string): "shown" | MissingSection => BRAND.missing[s as OptionalSection] ?? "shown";

/** «Non disponibile con questo dispositivo» */
export const NOT_AVAILABLE = "Non disponibile con questo dispositivo";

/** «Il tuo orologio» at the start of a sentence */
export const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
