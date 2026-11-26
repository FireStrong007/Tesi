/**
 * The ECG recordings of the Gima watches (ECG_MEASUREMENTS): what is known about their samples, in
 * one place, and how the app reads them. Nothing here is a diagnosis: the assessment is the
 * device's own (diagnose_type, is_afib), shown as it is with prudent words.
 *
 * What the samples are, from the Gima Android app (SynchronizationActivity.scaleSamples,
 * Cardiograph3View): the watch's samples are filtered, then every 3 are averaged and divided by 40,
 * and the result is clipped to ±500. The comment in Cardiograph3View says «采样率250 … 3个数据取平均值
 * 为一个» (sampling rate 250, 3 values averaged into one): 250 / 3 = 83.33 samples per second.
 * Checked on the real recordings with a heart rate (25 November 2026): the R peaks give the device's
 * heart rate within 1.6 bpm on average at 83.33 Hz, 7.8 bpm at 75 Hz, 10.1 bpm with
 * sample_count / duration_ms (duration_ms is start-to-send time, not the recording's length).
 */

/** TODO: da confermare con il gestore del server (250 Hz del dispositivo, media di 3 campioni) */
export const ECG_SAMPLE_RATE_HZ = 250 / 3;
/** false until the server's maintainer confirms it: the viewer warns that the time scale may be off */
export const ECG_SAMPLE_RATE_CONFIRMED = false;
/**
 * TODO: da confermare con il gestore del server. The Gima viewer draws 1000 units as 1 mV
 * (Cardiograph3View: «1mv == 10mm»), which would make them µV; until confirmed: device units.
 */
export const ECG_UNIT = "unità del dispositivo";
/** the Gima app clips the samples here: a higher peak shows as a flat top */
export const ECG_CLIP = 500;

/**
 * The device's assessment, with prudent words: never the app's own. The labels are short; every
 * box that shows them says once that they are the device's (NOT_A_DIAGNOSIS).
 */
export function ecgAssessment(isAfib: number | null, diagnoseType: number | null): string {
  if (isAfib === 1) return "Possibile fibrillazione atriale";
  switch (diagnoseType) {
    case 1:
      return ECG_NORMAL;
    case 5:
      return "Possibili battiti prematuri ventricolari";
    case 9:
      return "Possibili battiti prematuri atriali";
    default:
      return "Non classificato";
  }
}
export const ECG_NORMAL = "Ritmo normale";
/** once per box that shows assessments (summary, values, list) */
export const NOT_A_DIAGNOSIS = "Valutazioni automatiche del dispositivo, non sono diagnosi mediche";
/** the assessments in the order the summaries list them */
export const ECG_ASSESSMENTS = [ECG_NORMAL, "Possibile fibrillazione atriale", "Possibili battiti prematuri ventricolari", "Possibili battiti prematuri atriali", "Non classificato"] as const;

/** ecg_data: signed 32-bit little-endian integers */
export function decodeEcg(blob: Uint8Array): Int32Array {
  const n = Math.floor(blob.byteLength / 4);
  const view = new DataView(blob.buffer, blob.byteOffset, n * 4);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt32(i * 4, true);
  return out;
}
