/**
 * Garmin file types as they appear in the device directory (data type / sub type).
 * "pull" marks the files Gadgetbridge downloads by default. Subset of GB's FileType (AGPL-3.0).
 */
export interface FileTypeInfo {
  name: string;
  dataType: number;
  subType: number;
  pull: boolean;
}

const LIST: FileTypeInfo[] = [
  { name: "DIRECTORY", dataType: 0, subType: 0, pull: false },
  { name: "DEVICE_XML", dataType: 8, subType: 255, pull: false },
  { name: "SETTINGS", dataType: 128, subType: 2, pull: false },
  { name: "SPORTS", dataType: 128, subType: 3, pull: false },
  { name: "ACTIVITY", dataType: 128, subType: 4, pull: true },
  { name: "WORKOUTS", dataType: 128, subType: 5, pull: false },
  { name: "WEIGHT", dataType: 128, subType: 9, pull: true },
  { name: "TOTALS", dataType: 128, subType: 10, pull: false },
  { name: "GOALS", dataType: 128, subType: 11, pull: false },
  { name: "MONITOR_A", dataType: 128, subType: 15, pull: true },
  { name: "SUMMARY", dataType: 128, subType: 20, pull: false },
  { name: "MONITOR_DAILY", dataType: 128, subType: 28, pull: true },
  { name: "MONITOR", dataType: 128, subType: 32, pull: true },
  { name: "SEGMENT_LIST", dataType: 128, subType: 35, pull: true },
  { name: "CHANGELOG", dataType: 128, subType: 41, pull: true },
  { name: "METRICS", dataType: 128, subType: 44, pull: true },
  { name: "SLEEP", dataType: 128, subType: 49, pull: true },
  { name: "USER_BEHAVIOR_LOG", dataType: 128, subType: 52, pull: true },
  { name: "DEVICE_58", dataType: 128, subType: 58, pull: true },
  { name: "ECG", dataType: 128, subType: 61, pull: true },
  { name: "FIT_TYPE_66", dataType: 128, subType: 66, pull: true },
  { name: "HRV_STATUS", dataType: 128, subType: 68, pull: true },
  { name: "HSA", dataType: 128, subType: 70, pull: true },
  { name: "COM_ACT", dataType: 128, subType: 71, pull: true },
  { name: "SKIN_TEMP", dataType: 128, subType: 73, pull: true },
  { name: "SCHEDULE", dataType: 128, subType: 77, pull: true },
  { name: "SLP_DISR", dataType: 128, subType: 79, pull: true },
  { name: "ERROR_SHUTDOWN_REPORTS", dataType: 255, subType: 245, pull: true },
  { name: "IQ_ERROR_REPORTS", dataType: 255, subType: 244, pull: true },
  { name: "ULF_LOGS", dataType: 255, subType: 247, pull: true },
  { name: "KPI", dataType: 255, subType: 248, pull: true },
];

export function fileTypeOf(dataType: number, subType: number): FileTypeInfo | null {
  const found = LIST.find((f) => f.dataType === dataType && f.subType === subType);
  if (found) return found;
  if (dataType === 128) return { name: `FIT_TYPE_${subType}`, dataType, subType, pull: false };
  return null;
}

export function isFitFile(dataType: number): boolean {
  return dataType === 128;
}

/** Only FIT files carry data this app can import; other pullable files are downloaded only if requested. */
export function shouldDownload(dataType: number, subType: number, fetchUnknown = false): boolean {
  const ft = fileTypeOf(dataType, subType);
  if (!ft || ft.name === "DIRECTORY") return false;
  if (!isFitFile(dataType)) return false;
  return ft.pull || fetchUnknown;
}
