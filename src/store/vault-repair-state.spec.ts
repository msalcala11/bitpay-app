import {
  conversionEstablished,
  parseVaultRecord,
  parseCleanup,
  validReceipt,
} from './vault-repair-state';
const receipt = 'a'.repeat(32);
const binding = {origin: 'converted-source', digest: 'b'.repeat(64)};
const started = {status: 'started', wipeDone: false, conversionComplete: true};
it('keeps conversion independent of optional cleanup validity', () => {
  for (const cleanup of [
    null,
    false,
    'unknown',
    {v: 2},
    {v: 1, primaryReceipt: 'invalid'},
    {v: 1, async: {...binding, extra: true}},
  ]) {
    const r = parseVaultRecord(JSON.stringify({...started, cleanup}));
    expect(conversionEstablished(r)).toBe(true);
    expect(r.cleanup === undefined).toBe(true);
  }
});
it('rejects mandatory conversion history and plan errors without guessing completion', () => {
  for (const conversionComplete of [false, 1, 'true', null])
    expect(() =>
      parseVaultRecord(JSON.stringify({...started, conversionComplete})),
    ).toThrow('PRESERVATION_FAILURE');
  for (const conversionPlan of [null, {v: 2}, {v: 1, source: 'arbitrary-path'}])
    expect(() =>
      parseVaultRecord(
        JSON.stringify({status: 'started', wipeDone: false, conversionPlan}),
      ),
    ).toThrow('PRESERVATION_FAILURE');
  expect(
    conversionEstablished(
      parseVaultRecord(JSON.stringify({status: 'started', wipeDone: true})),
    ),
  ).toBe(false);
});
it('ignores all retired extension contents but validates the original enclosing record', () => {
  const r = parseVaultRecord(
    JSON.stringify({
      status: 'complete',
      wipeDone: true,
      conversionComplete: 'retired',
      conversionPlan: false,
      cleanup: {v: 900},
    }),
  );
  expect(conversionEstablished(r)).toBe(true);
  expect(() =>
    parseVaultRecord(JSON.stringify({...r, wipeDone: false})),
  ).toThrow();
  expect(() =>
    parseVaultRecord(JSON.stringify({...r, refresh: {path: 'unknown'}})),
  ).toThrow();
});
it('parses independent fixed slots and current-coverage without treating it as consumption', () => {
  const cleanup = {
    v: 1,
    primaryReceipt: receipt,
    async: binding,
    main: {origin: 'optional-refresh', digest: 'c'.repeat(64)},
    bak: {origin: 'current-coverage', digest: 'd'.repeat(64)},
  };
  expect(
    JSON.stringify(parseCleanup(cleanup)) === JSON.stringify(cleanup),
  ).toBe(true);
  expect(
    parseCleanup({
      ...cleanup,
      async: {origin: 'optional-refresh', digest: binding.digest},
    }) === undefined,
  ).toBe(true);
});
it.each([
  {label: 'absent', value: undefined},
  {label: 'null', value: null},
  {label: 'number', value: 1},
  {label: 'empty', value: ''},
  {label: 'short', value: 'a'.repeat(31)},
  {label: 'uppercase', value: 'A'.repeat(32)},
  {label: 'nonhex', value: 'x'.repeat(32)},
  {label: 'long', value: 'a'.repeat(33)},
])('rejects malformed receipt: $label', ({value}) => {
  expect(validReceipt(value)).toBe(false);
});
it('accepts exactly 128 bits in lower-case hex', () =>
  expect(validReceipt(receipt)).toBe(true));
