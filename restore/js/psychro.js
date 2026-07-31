/* Psychrometrics — the math behind every drying decision.
 *
 * Pure functions, no DOM. Also imported directly by restore/tests/*.test.mjs.
 *
 * Units: temperature in °F (what techs read off a thermo-hygrometer), pressure
 * in kPa internally, humidity ratio converted to grains per pound (GPP) because
 * that is the number that goes on the moisture log.
 */

export const STANDARD_PRESSURE_KPA = 101.325;
const GRAINS_PER_LB = 7000;
const MW_RATIO = 0.621945; // molecular weight water / dry air

export const f2c = (f) => (f - 32) * 5 / 9;
export const c2f = (c) => c * 9 / 5 + 32;

/** Barometric pressure (kPa) falling off with site elevation in feet. */
export function pressureAtElevation(feet = 0) {
  const meters = feet * 0.3048;
  return STANDARD_PRESSURE_KPA * Math.pow(1 - 2.25577e-5 * meters, 5.25588);
}

/** Saturation vapor pressure over liquid water, kPa. Buck (1996). */
export function satVaporPressure(tempF) {
  const t = f2c(tempF);
  return 0.61121 * Math.exp((18.678 - t / 234.5) * (t / (257.14 + t)));
}

/** Actual (partial) vapor pressure of the air, kPa. */
export function vaporPressure(tempF, rh) {
  return clampRh(rh) / 100 * satVaporPressure(tempF);
}

/** Humidity ratio W, lb moisture per lb dry air. */
export function humidityRatio(tempF, rh, pressureKpa = STANDARD_PRESSURE_KPA) {
  const pv = vaporPressure(tempF, rh);
  // Guard against a nonsense input driving pv to/past total pressure.
  const safePv = Math.min(pv, pressureKpa * 0.999);
  return MW_RATIO * safePv / (pressureKpa - safePv);
}

/** Grains of moisture per pound of dry air — the working unit on a drying log. */
export function gpp(tempF, rh, pressureKpa = STANDARD_PRESSURE_KPA) {
  return humidityRatio(tempF, rh, pressureKpa) * GRAINS_PER_LB;
}

/** Dew point °F. Magnus inversion; below the dew point you get condensation. */
export function dewPoint(tempF, rh) {
  const t = f2c(tempF);
  const r = clampRh(rh);
  if (r <= 0) return -Infinity;
  const a = 17.62, b = 243.12;
  const gamma = Math.log(r / 100) + (a * t) / (b + t);
  return c2f((b * gamma) / (a - gamma));
}

/** Specific enthalpy, BTU per lb of dry air. */
export function enthalpy(tempF, rh, pressureKpa = STANDARD_PRESSURE_KPA) {
  const w = humidityRatio(tempF, rh, pressureKpa);
  return 0.24 * tempF + w * (1061 + 0.444 * tempF);
}

/**
 * Relative humidity implied by a temperature and a known GPP. Used to answer
 * "if I heat this space to 90°F, what does my RH become?"
 */
export function rhFromGpp(tempF, grains, pressureKpa = STANDARD_PRESSURE_KPA) {
  const w = grains / GRAINS_PER_LB;
  const pv = (w * pressureKpa) / (MW_RATIO + w);
  return clampRh(pv / satVaporPressure(tempF) * 100);
}

/** Grain depression across a dehumidifier: inlet GPP minus outlet GPP. */
export function grainDepression(inlet, outlet) {
  if (!inlet || !outlet) return null;
  return gpp(inlet.temp, inlet.rh) - gpp(outlet.temp, outlet.rh);
}

/**
 * Is the dehu actually pulling water? Below ~10 grains of depression a
 * refrigerant unit is coasting; that is a call to change the setup, not to
 * keep billing equipment days.
 */
export function dehuVerdict(depression) {
  if (depression == null) return { level: 'unknown', text: 'Log an inlet and outlet reading.' };
  if (depression < 0) return { level: 'bad', text: 'Outlet is wetter than inlet — check the unit, it is not dehumidifying.' };
  if (depression < 10) return { level: 'warn', text: `${depression.toFixed(1)} gr depression — low. Space may be near dry, or the unit needs service.` };
  if (depression < 20) return { level: 'ok', text: `${depression.toFixed(1)} gr depression — working, moderate load.` };
  return { level: 'good', text: `${depression.toFixed(1)} gr depression — strong pull, heavy moisture load.` };
}

/**
 * Compare the affected space against an unaffected reference and the exterior.
 * "Is my drying chamber actually drier than what I started with?"
 */
export function chamberAnalysis({ affected, unaffected, exterior }) {
  const out = { affected: null, unaffected: null, exterior: null, notes: [] };
  if (affected) out.affected = readingSummary(affected);
  if (unaffected) out.unaffected = readingSummary(unaffected);
  if (exterior) out.exterior = readingSummary(exterior);

  if (out.affected && out.unaffected) {
    const diff = out.affected.gpp - out.unaffected.gpp;
    out.gppSpread = diff;
    if (diff > 5) {
      out.notes.push(`Affected air is ${diff.toFixed(1)} gr/lb wetter than the unaffected reference — evaporation is still happening.`);
    } else if (diff < -2) {
      out.notes.push(`Affected air is drier than the unaffected reference (${Math.abs(diff).toFixed(1)} gr/lb). Drying goal is likely met for the air; confirm with material readings.`);
    } else {
      out.notes.push('Affected and unaffected air are within a few grains — approaching equilibrium.');
    }
  }
  if (out.affected && out.exterior) {
    const diff = out.exterior.gpp - out.affected.gpp;
    if (diff < -5) {
      out.notes.push(`Exterior air is ${Math.abs(diff).toFixed(1)} gr/lb drier than inside — open-drying / ventilation is worth considering.`);
    } else if (diff > 5) {
      out.notes.push(`Exterior air is ${diff.toFixed(1)} gr/lb wetter than inside — keep the chamber closed.`);
    }
  }
  if (out.affected && out.affected.temp < 70) {
    out.notes.push('Below 70°F the evaporation rate drops off hard. Add heat before adding equipment.');
  }
  if (out.affected && out.affected.temp > 95) {
    out.notes.push('Above 95°F refrigerant dehus lose efficiency and secondary damage risk climbs.');
  }
  return out;
}

export function readingSummary(r, pressureKpa = STANDARD_PRESSURE_KPA) {
  if (!r || r.temp == null || r.rh == null) return null;
  return {
    temp: r.temp,
    rh: r.rh,
    gpp: gpp(r.temp, r.rh, pressureKpa),
    dewPoint: dewPoint(r.temp, r.rh),
    enthalpy: enthalpy(r.temp, r.rh, pressureKpa),
    vaporPressure: vaporPressure(r.temp, r.rh),
  };
}

/**
 * Condensation risk on a cold surface (window, exterior wall, slab). If the
 * surface sits below the dew point of the room air you are making new damage.
 */
export function condensationRisk(airTempF, rh, surfaceTempF) {
  const dp = dewPoint(airTempF, rh);
  const margin = surfaceTempF - dp;
  return {
    dewPoint: dp,
    margin,
    risk: margin <= 0 ? 'condensing' : margin < 5 ? 'marginal' : 'clear',
  };
}

function clampRh(rh) {
  const n = Number(rh);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
