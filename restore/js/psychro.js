// Psychrometrics for structural drying.
// Vapor pressure via the Buck equation; humidity ratio at standard sea-level
// pressure unless an altitude-corrected barometric pressure is supplied.

const STD_PRESSURE_PSI = 14.696;
const HPA_TO_PSI = 0.0145037738;

export const fToC = (f) => (f - 32) / 1.8;
export const cToF = (c) => c * 1.8 + 32;

/** Saturation vapor pressure over water, hPa, for °C (Buck 1981). */
export function satVaporPressureHpa(tC) {
  return 6.1121 * Math.exp((18.678 - tC / 234.5) * (tC / (257.14 + tC)));
}

/** Actual vapor pressure in inches of mercury — the number that drives drying. */
export function vaporPressureInHg(tempF, rh) {
  const es = satVaporPressureHpa(fToC(tempF));
  return (es * (rh / 100)) * 0.02952998;
}

/** Dew point °F from temp °F + RH%. */
export function dewPointF(tempF, rh) {
  if (!Number.isFinite(tempF) || !Number.isFinite(rh) || rh <= 0) return null;
  const tC = fToC(tempF);
  const gamma = Math.log(rh / 100) + (18.678 - tC / 234.5) * (tC / (257.14 + tC));
  return cToF((257.14 * gamma) / (18.678 - gamma));
}

/** Humidity ratio in grains of moisture per pound of dry air (GPP). */
export function gpp(tempF, rh, barometricPsi = STD_PRESSURE_PSI) {
  if (!Number.isFinite(tempF) || !Number.isFinite(rh)) return null;
  const pw = satVaporPressureHpa(fToC(tempF)) * (rh / 100) * HPA_TO_PSI;
  const p = Math.max(pw + 0.001, barometricPsi);
  return 7000 * (0.62198 * pw) / (p - pw);
}

/** RH% implied by a temperature and a known grain load — used to sanity-check logs. */
export function rhFromGpp(tempF, grains, barometricPsi = STD_PRESSURE_PSI) {
  if (!Number.isFinite(tempF) || !Number.isFinite(grains)) return null;
  const w = grains / 7000;
  const pw = (w * barometricPsi) / (0.62198 + w);
  const es = satVaporPressureHpa(fToC(tempF)) * HPA_TO_PSI;
  return es > 0 ? Math.min(100, (pw / es) * 100) : null;
}

/** Barometric pressure (psi) corrected for site elevation in feet. */
export function pressureAtElevation(feet = 0) {
  return STD_PRESSURE_PSI * Math.pow(1 - 6.8753e-6 * (Number(feet) || 0), 5.2559);
}

/** Everything derived from one temp/RH pair. */
export function psychro(tempF, rh, elevationFt = 0) {
  const p = pressureAtElevation(elevationFt);
  return {
    tempF, rh,
    dewPointF: dewPointF(tempF, rh),
    gpp: gpp(tempF, rh, p),
    vpInHg: vaporPressureInHg(tempF, rh),
  };
}

/**
 * Evaluate a dehumidifier from inlet/outlet readings.
 * Grain depression is the working number in the field: an LGR pulling fewer
 * than ~15 grains at a normal inlet is either saturated, iced, or done.
 */
export function dehuPerformance(inlet, outlet, elevationFt = 0) {
  const i = psychro(inlet.tempF, inlet.rh, elevationFt);
  const o = psychro(outlet.tempF, outlet.rh, elevationFt);
  if (i.gpp === null || o.gpp === null) return null;
  const depression = i.gpp - o.gpp;
  let verdict = 'ok', note = '';
  if (depression < 5) {
    verdict = 'bad';
    note = 'Almost no grain depression — check for icing, a saturated coil, wrong ducting, or a failed unit.';
  } else if (depression < 15) {
    verdict = 'watch';
    note = 'Low grain depression. Normal near the end of drying; otherwise check placement and airflow.';
  } else {
    note = 'Unit is pulling water.';
  }
  const tempRise = o.tempF - i.tempF;
  if (tempRise < 5 && verdict === 'ok') {
    verdict = 'watch';
    note += ' Outlet temperature rise is low for a refrigerant unit — verify the compressor is running.';
  }
  return { inlet: i, outlet: o, depression, tempRise, verdict, note };
}

/**
 * Is the dehumidifier or an open window the better move right now?
 * Compares interior grain load to exterior; open-drying only makes sense when
 * the outside air is meaningfully drier.
 */
export function ventilationAdvice(inside, outside, elevationFt = 0) {
  const i = psychro(inside.tempF, inside.rh, elevationFt);
  const o = psychro(outside.tempF, outside.rh, elevationFt);
  if (i.gpp === null || o.gpp === null) return null;
  const delta = i.gpp - o.gpp;
  if (delta > 10) {
    return { mode: 'open', delta, text: `Outside air is ${Math.round(delta)} gpp drier — open drying / ventilation is viable if the weather holds.` };
  }
  if (delta < -5) {
    return { mode: 'closed', delta, text: `Outside air is ${Math.round(-delta)} gpp wetter — keep the structure closed and stay on dehumidification.` };
  }
  return { mode: 'closed', delta, text: 'Little difference between inside and outside grain loads — run a closed drying system.' };
}

/** Class-appropriate humidity target inside the drying chamber. */
export function targetGpp(cls) {
  return { 1: 40, 2: 40, 3: 35, 4: 30 }[cls] ?? 40;
}
