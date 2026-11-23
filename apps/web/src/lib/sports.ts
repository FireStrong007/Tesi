/** FIT sport codes -> Italian labels */
export const SPORT_NAMES: Record<number, string> = {
  0: "Attività", 1: "Corsa", 2: "Ciclismo", 3: "Transizione", 4: "Attrezzi", 5: "Nuoto", 6: "Basket", 7: "Calcio",
  8: "Tennis", 10: "Allenamento", 11: "Camminata", 12: "Sci di fondo", 13: "Sci alpino", 14: "Snowboard", 15: "Canottaggio",
  16: "Alpinismo", 17: "Escursionismo", 19: "Paddle", 21: "E-bike", 26: "Yoga", 30: "Pattinaggio in linea", 31: "Arrampicata",
  37: "Stand up paddle", 41: "Kayak", 43: "Kitesurf", 48: "Cardio", 53: "Ballo", 62: "HIIT", 64: "Racchetta",
};
export const sportName = (sport: number | null, name?: string | null) => name || SPORT_NAMES[sport ?? 0] || "Attività";
