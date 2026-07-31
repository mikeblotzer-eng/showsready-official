import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gpp, dewPoint, satVaporPressure, humidityRatio, rhFromGpp, grainDepression,
  dehuVerdict, condensationRisk, chamberAnalysis, pressureAtElevation, f2c, c2f,
} from '../js/psychro.js';

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ±${tol}, got ${actual}`);

test('temperature conversion round-trips', () => {
  close(f2c(32), 0, 1e-9);
  close(f2c(212), 100, 1e-9);
  close(c2f(f2c(78.4)), 78.4, 1e-9);
});

test('saturation vapor pressure matches known values', () => {
  // At 32°F (0°C) saturation pressure is ~0.611 kPa.
  close(satVaporPressure(32), 0.6112, 0.002);
  // At 68°F (20°C) it is ~2.339 kPa.
  close(satVaporPressure(68), 2.339, 0.01);
  // At 104°F (40°C) it is ~7.384 kPa.
  close(satVaporPressure(104), 7.384, 0.02);
});

test('saturated air is monotonic in temperature', () => {
  let prev = -Infinity;
  for (let t = 20; t <= 120; t += 5) {
    const v = satVaporPressure(t);
    assert.ok(v > prev, `expected sat pressure to increase at ${t}°F`);
    prev = v;
  }
});

test('GPP matches standard psychrometric chart points', () => {
  // 70°F / 50% RH is very close to 55 grains per pound at sea level.
  close(gpp(70, 50), 55, 1.5, '70F/50%');
  // 80°F / 60% RH is roughly 92 gr/lb.
  close(gpp(80, 60), 92, 2.5, '80F/60%');
  // 90°F / 90% RH is roughly 194 gr/lb.
  close(gpp(90, 90), 194, 5, '90F/90%');
});

test('GPP is zero at 0% RH and rises with humidity', () => {
  assert.equal(gpp(75, 0), 0);
  assert.ok(gpp(75, 80) > gpp(75, 40));
  assert.ok(gpp(95, 50) > gpp(70, 50), 'warmer air at equal RH holds more moisture');
});

test('humidity ratio stays finite at saturation', () => {
  const w = humidityRatio(120, 100);
  assert.ok(Number.isFinite(w) && w > 0);
});

test('dew point equals dry bulb at saturation', () => {
  close(dewPoint(75, 100), 75, 0.5);
  close(dewPoint(40, 100), 40, 0.5);
});

test('dew point is below dry bulb elsewhere and matches known values', () => {
  assert.ok(dewPoint(70, 50) < 70);
  // 70°F / 50% RH gives a dew point near 50.5°F.
  close(dewPoint(70, 50), 50.5, 1);
  // 80°F / 60% RH gives a dew point near 65.3°F.
  close(dewPoint(80, 60), 65.3, 1);
});

test('rhFromGpp inverts gpp', () => {
  for (const [t, rh] of [[70, 50], [85, 35], [95, 70], [60, 80]]) {
    close(rhFromGpp(t, gpp(t, rh)), rh, 0.5, `${t}F/${rh}%`);
  }
});

test('heating air at constant moisture lowers RH', () => {
  const grains = gpp(70, 60);
  assert.ok(rhFromGpp(90, grains) < 60, 'heating should drop RH');
  assert.ok(rhFromGpp(55, grains) > 60, 'cooling should raise RH');
});

test('elevation lowers barometric pressure and raises GPP for the same RH', () => {
  assert.ok(pressureAtElevation(5280) < pressureAtElevation(0));
  const sea = gpp(70, 50, pressureAtElevation(0));
  const denver = gpp(70, 50, pressureAtElevation(5280));
  assert.ok(denver > sea, 'thinner air holds more grains per pound of dry air');
});

test('grain depression measures what the dehu removed', () => {
  const inlet = { temp: 80, rh: 60 };
  const outlet = { temp: 95, rh: 25 };
  const depression = grainDepression(inlet, outlet);
  assert.ok(depression > 0, 'a working dehu leaves the outlet drier in grains');
  close(depression, gpp(80, 60) - gpp(95, 25), 1e-9);
  assert.equal(grainDepression(null, outlet), null);
});

test('dehu verdict flags a unit that is not pulling water', () => {
  assert.equal(dehuVerdict(-3).level, 'bad');
  assert.equal(dehuVerdict(4).level, 'warn');
  assert.equal(dehuVerdict(14).level, 'ok');
  assert.equal(dehuVerdict(28).level, 'good');
  assert.equal(dehuVerdict(null).level, 'unknown');
});

test('condensation risk triggers below the dew point', () => {
  const risk = condensationRisk(75, 60, 55);
  assert.equal(risk.risk, 'condensing');
  assert.ok(risk.margin < 0);
  assert.equal(condensationRisk(75, 60, 80).risk, 'clear');
  assert.equal(condensationRisk(75, 60, 63).risk, 'marginal');
});

test('chamber analysis compares affected air to the baseline', () => {
  const wet = chamberAnalysis({
    affected: { temp: 80, rh: 70 },
    unaffected: { temp: 72, rh: 40 },
  });
  assert.ok(wet.gppSpread > 5);
  assert.ok(wet.notes.some((n) => /evaporation is still happening/i.test(n)));

  const done = chamberAnalysis({
    affected: { temp: 78, rh: 38 },
    unaffected: { temp: 78, rh: 40 },
  });
  assert.ok(done.notes.some((n) => /equilibrium|goal is likely met/i.test(n)));
});

test('chamber analysis warns about a cold chamber', () => {
  const cold = chamberAnalysis({ affected: { temp: 62, rh: 55 } });
  assert.ok(cold.notes.some((n) => /70°F/.test(n)));
});

test('bad input does not produce NaN', () => {
  assert.equal(gpp(70, 'abc'), 0);
  assert.ok(Number.isFinite(gpp(70, 150)), 'RH above 100 is clamped');
  assert.equal(gpp(70, 150), gpp(70, 100));
  assert.equal(gpp(70, -20), 0);
});
