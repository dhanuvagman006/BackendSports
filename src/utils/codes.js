const crypto = require('crypto');

const randDigits = (n) => {
  let s = '';
  while (s.length < n) s += crypto.randomInt(0, 10).toString();
  return s;
};

/** Matches the frontend's SQP2026###### format, but generated server-side. */
const newPlayerCode = () => `SQP${new Date().getFullYear()}${randDigits(6)}`;
const newCoachCode = () => `SQC${new Date().getFullYear()}${randDigits(6)}`;

/** 6-digit numeric league code — matches the 6-box join screen. */
const newLeagueCode = () => randDigits(6);

/** Retry insert until unique constraint passes (codes are short, collisions possible). */
async function generateUnique(genFn, existsFn, maxTries = 8) {
  for (let i = 0; i < maxTries; i++) {
    const code = genFn();
    if (!(await existsFn(code))) return code;
  }
  throw new Error('Could not generate a unique code');
}

module.exports = { newPlayerCode, newCoachCode, newLeagueCode, generateUnique, randDigits };
