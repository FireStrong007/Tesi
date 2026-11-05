/** Garmin/FIT epoch: 1989-12-31T00:00:00Z, expressed as unix seconds. */
export const GARMIN_EPOCH = 631065600;

export const garminToUnix = (ts: number) => ts + GARMIN_EPOCH;
export const unixToGarmin = (ts: number) => ts - GARMIN_EPOCH;
