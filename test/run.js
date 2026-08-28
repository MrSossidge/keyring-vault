'use strict';
/* Runs every suite. Exits non-zero if anything failed. */
(async () => {
  const suites = ['./local.test.js', './sync.test.js'];
  let failures = 0;
  for (const s of suites) failures += await require(s)();
  console.log(failures
    ? '\n\x1b[31m' + failures + ' failing check(s)\x1b[0m\n'
    : '\n\x1b[32mAll checks passed.\x1b[0m\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
