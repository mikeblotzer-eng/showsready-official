/**
 * Psychrometrics for restoration drying.
 *
 * Everything the tech types is in field units (°F, %RH, grains per pound).
 * Internally we work in °C / kPa because the vapour-pressure correlations are
 * published that way, then convert back at the edges.
 *
 * Vapour pressure uses the Buck (1981/1996) equation, which is accurate to
 * better than 0.1% over the -40..+50 °C range a drying job ever sees — well
 * inside the error of a field hygrometer.
 */

const KPA_PER_PSI = 6.894757;
const STD_PRESSURE_KPA = 101.325;

export const F_to_C = (f) => (f - 32) * 5 / 9;
export const C_to_F = (c) => c * 9 / 5 + 32;

/** Atmospheric pressure (kPa) at a given elevation in feet (ISA model). */
export function pressureAtElevation(feet = 0) {
  const meters = feet * 0.3048;
  return STD_PRESSURE_KPA * Math.pow(1 - 2.25577e-5 * meters, 5.25588);
}

/** Saturation vapour pressure over liquid water, kPa, for °C. */
export function satVaporPressure(tempC) {
  return 0.61121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
}

/** Actual vapour pressure, kPa. */
export function vaporPressure(tempF, rh) {
  return clampRH(rh) / 100 * satVaporPressure(F_to_C(tempF));
}

function clampRH(rh) {
  if (!isFinite(rh)) return 0;
  return Math.min(100, Math.max(0, rh));
}

/**
 * Humidity ratio (lb moisture / lb dry air).
 * elevationFt shifts the result by roughly 4% per 1000 ft, which matters on
 * mountain jobs — a Denver dehu reading looks "wrong" at sea-level pressure.
 */
export function humidityRatio(tempF, rh, elevationFt = 0) {
  const p = pressureAtElevation(elevationFt);
  const pv = Math.min(vaporPressure(tempF, rh), p * 0.999);
  return 0.621945 * pv / (p - pv);
}

/** Grains of moisture per pound of dry air — the number techs actually log. */
export function gpp(tempF, rh, elevationFt = 0) {
  return 7000 * humidityRatio(tempF, rh, elevationFt);
}

/** Inverse: the RH that would produce a given GPP at a given temperature. */
export function rhFromGpp(tempF, grains, elevationFt = 0) {
  const p = pressureAtElevation(elevationFt);
  const w = grains / 7000;
  const pv = p * w / (0.621945 + w);
  const psat = satVaporPressure(F_to_C(tempF));
  if (psat <= 0) return 0;
  return Math.min(100, Math.max(0, pv / psat * 100));
}

/**
 * Dew point °F.
 *
 * Buck's equation has no exact algebraic inverse — the usual closed-form
 * "inversion" reuses the dry-bulb temperature inside the coefficient term and
 * lands about a quarter degree off at saturation. Here we solve
 * satVaporPressure(Td) = Pv numerically instead, which is exact at saturation
 * and costs nothing at this scale.
 */
export function dewPointF(tempF, rh) {
  const r = clampRH(rh);
  if (r <= 0) return -Infinity;
  const t = F_to_C(tempF);
  const pv = (r / 100) * satVaporPressure(t);
  return C_to_F(dewPointCFromVaporPressure(pv, t));
}

/** Dew point in °C for a vapour pressure in kPa, by bisection. */
export function dewPointCFromVaporPressure(pv, upperC = 60) {
  if (!(pv > 0)) return -Infinity;
  let lo = -100, hi = upperC + 1e-6;
  if (satVaporPressure(lo) >= pv) return lo;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (satVaporPressure(mid) < pv) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Moist-air enthalpy, BTU per pound of dry air. */
export function enthalpy(tempF, rh, elevationFt = 0) {
  const w = humidityRatio(tempF, rh, elevationFt);
  return 0.24 * tempF + w * (1061 + 0.444 * tempF);
}

/** Specific volume, cubic feet per pound of dry air. */
export function specificVolume(tempF, rh, elevationFt = 0) {
  const w = humidityRatio(tempF, rh, elevationFt);
  const p = pressureAtElevation(elevationFt) / KPA_PER_PSI; // psia
  return 0.370486 * (tempF + 459.67) * (1 + 1.607858 * w) / p;
}

/** Everything at once, for a reading card. */
export function psychroSet(tempF, rh, elevationFt = 0) {
  return {
    tempF,
    rh: clampRH(rh),
    gpp: gpp(tempF, rh, elevationFt),
    dewPointF: dewPointF(tempF, rh),
    enthalpy: enthalpy(tempF, rh, elevationFt),
    specificVolume: specificVolume(tempF, rh, elevationFt),
    vaporPressureKpa: vaporPressure(tempF, rh),
  };
}

/**
 * Vapour pressure differential between the air and a wet material's surface,
 * expressed in grains. Positive means the air can still pull moisture out;
 * near zero means drying has stalled and the tech needs to change something.
 */
export function dryingGradient(airTempF, airRh, materialTempF, materialRhSurface = 100, elevationFt = 0) {
  const air = gpp(airTempF, airRh, elevationFt);
  const surface = gpp(materialTempF, materialRhSurface, elevationFt);
  return surface - air;
}

/**
 * Dehumidifier performance check. A working refrigerant/LGR unit should show a
 * meaningful grain depression between intake and outlet; a small delta means
 * the unit is iced, the coil is dirty, or the air is already too dry for it.
 */
export function dehuPerformance(inletTempF, inletRh, outletTempF, outletRh, elevationFt = 0) {
  const inlet = psychroSet(inletTempF, inletRh, elevationFt);
  const outlet = psychroSet(outletTempF, outletRh, elevationFt);
  const depression = inlet.gpp - outlet.gpp;
  let verdict, detail;
  if (depression >= 30) {
    verdict = 'good';
    detail = 'Unit is pulling well.';
  } else if (depression >= 15) {
    verdict = 'fair';
    detail = 'Moderate depression — normal late in the dry-down, suspect if the space is still wet.';
  } else if (depression >= 5) {
    verdict = 'poor';
    detail = 'Low depression. Check filter, coil and refrigerant, or the space may be at equilibrium.';
  } else {
    verdict = 'check';
    detail = 'Little or no depression. Verify the unit is running, not iced, and ducted correctly.';
  }
  return { inlet, outlet, depression, tempRise: outlet.tempF - inlet.tempF, verdict, detail };
}

/**
 * Is the drying environment actually productive?
 * Compares the affected space to the outside/unaffected reference and against
 * the usual field targets: warm air, GPP well below the unaffected reading.
 */
export function evaluateEnvironment({ insideTempF, insideRh, outsideTempF, outsideRh, unaffectedTempF, unaffectedRh, elevationFt = 0 }) {
  const inside = psychroSet(insideTempF, insideRh, elevationFt);
  const flags = [];
  let outside = null, unaffected = null;

  if (isFinite(outsideTempF) && isFinite(outsideRh)) outside = psychroSet(outsideTempF, outsideRh, elevationFt);
  if (isFinite(unaffectedTempF) && isFinite(unaffectedRh)) unaffected = psychroSet(unaffectedTempF, unaffectedRh, elevationFt);

  if (inside.tempF < 70) flags.push({ level: 'warn', text: 'Chamber below 70 °F — evaporation rate drops sharply. Add heat or restrict cold make-up air.' });
  if (inside.tempF > 95) flags.push({ level: 'warn', text: 'Chamber above 95 °F — most refrigerant dehus lose capacity and secondary damage risk rises.' });
  if (inside.rh > 60) flags.push({ level: 'warn', text: 'Chamber RH above 60% — microbial amplification risk within 48–72 hours.' });

  const reference = unaffected || outside;
  if (reference) {
    const delta = reference.gpp - inside.gpp;
    if (delta < 0) {
      flags.push({ level: 'bad', text: `Chamber is wetter than the reference by ${Math.abs(delta).toFixed(0)} gpp — dehumidification is losing to the load.` });
    } else if (delta < 10) {
      flags.push({ level: 'warn', text: `Only ${delta.toFixed(0)} gpp below reference — add or resize dehumidification.` });
    }
  }
  if (outside && outside.gpp + 5 < inside.gpp && inside.tempF > 60) {
    flags.push({ level: 'info', text: 'Outside air is drier than the chamber — open drying may be viable if the weather holds.' });
  }
  if (!flags.length) flags.push({ level: 'good', text: 'Drying environment is within normal targets.' });
  return { inside, outside, unaffected, flags };
}
