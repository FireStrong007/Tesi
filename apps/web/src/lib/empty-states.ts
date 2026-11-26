import { BRAND, capitalized } from "@/brand";

/** «Il tuo bracciale» / «Il tuo orologio» */
const YOUR = capitalized(BRAND.device.your);

/**
 * What the app says when a section has no data. Two different cases:
 *  - the band has never recorded that kind of data (not every band measures everything: in the
 *    study, sleep exists for 2 participants out of 7, SpO2 for 1, HRV for none);
 *  - it has, but not in the period shown.
 */
export const NEVER_RECORDED: Record<string, string> = {
  activity: `${YOUR} non ha ancora registrato attività.`,
  steps: `${YOUR} non ha ancora registrato passi.`,
  calories: `${YOUR} non ha ancora registrato calorie.`,
  sleep: `${YOUR} non ha ancora registrato dati sul sonno.`,
  hr: `${YOUR} non ha ancora registrato il battito.`,
  stress: `${YOUR} non ha ancora registrato lo stress.`,
  energy: `${YOUR} non ha ancora registrato la Body Battery.`,
  spo2: `${YOUR} non ha ancora registrato la saturazione dell'ossigeno (SpO₂).`,
  resp: `${YOUR} non ha ancora registrato la respirazione.`,
  hrv: `${YOUR} non ha ancora registrato la variabilità del battito (HRV).`,
  intensity: `${YOUR} non ha ancora registrato minuti di intensità.`,
  bp: `${YOUR} non ha ancora registrato la pressione.`,
  temp: `${YOUR} non ha ancora registrato temperature valide.`,
  ecg: `${YOUR} non ha ancora registrato elettrocardiogrammi.`,
};

export const NEVER_RECORDED_HINT =
  `I dati arrivano quando l'app del telefono li invia al server dello studio. Non tutti i dispositivi misurano tutto: se ${BRAND.device.your} non registra questo dato, la sezione resterà vuota.`;

export const NOTHING_IN_PERIOD = "Nessun dato per questo periodo. Il telefono invia i dati al server qualche volta al giorno: prova un altro giorno o premi Sincronizza.";

/** short form for the tiles of the Home */
export const NEVER_SHORT = "Mai registrato";

/** one query per section: does the copy have any data of that kind at all? */
export const AVAILABILITY_SQL: Record<string, string> = {
  steps: "SELECT 1 FROM activity_sample WHERE steps > 0 LIMIT 1",
  calories: "SELECT 1 FROM activity_sample WHERE active_calories > 0 LIMIT 1",
  hr: "SELECT 1 FROM activity_sample WHERE heart_rate > 0 LIMIT 1",
  sleep: "SELECT 1 FROM sleep_session LIMIT 1",
  stress: "SELECT 1 FROM stress_sample WHERE stress >= 1 LIMIT 1",
  energy: "SELECT 1 FROM body_energy_sample LIMIT 1",
  spo2: "SELECT 1 FROM spo2_sample LIMIT 1",
  resp: "SELECT 1 FROM respiratory_rate_sample LIMIT 1",
  hrv: "SELECT 1 FROM hrv_value_sample UNION ALL SELECT 1 FROM hrv_summary_sample LIMIT 1",
  intensity: "SELECT 1 FROM intensity_minutes_sample LIMIT 1",
  bp: "SELECT 1 FROM blood_pressure_sample LIMIT 1",
  temp: "SELECT 1 FROM body_temperature_sample LIMIT 1",
  ecg: "SELECT 1 FROM ecg_recording LIMIT 1",
};
