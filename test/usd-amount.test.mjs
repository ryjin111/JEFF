import test from 'node:test';
import assert from 'node:assert/strict';
import { usdCentsToTokenAmount } from '../src/usd-amount.mjs';

const convert = (overrides = {}) => usdCentsToTokenAmount({ usdCents: 1000, tokenDecimals: 18, priceUsd: '0.0025', ...overrides });
const uint256Max = (1n << 256n) - 1n;

test('USD cents convert to exact token units and round fractional units upward', () => {
  assert.equal(convert(), '4000000000000000000000');
  assert.equal(convert({ priceUsd: '0.3' }), '33333333333333333334');
  assert.equal(convert({ priceUsd: '3', tokenDecimals: 0 }), '4');
  assert.equal(convert({ usdCents: 1, priceUsd: '0.333333333333333333', tokenDecimals: 6 }), '30001');
  assert.equal(convert({ priceUsd: '1.000000000000000001' }), '9999999999999999991');
});

test('exact quotients retain their value and positive subunit amounts round up to one', () => {
  assert.equal(convert({ priceUsd: '0.25', tokenDecimals: 0 }), '40');
  assert.equal(convert({ usdCents: 1, priceUsd: '0.01', tokenDecimals: 0 }), '1');
  assert.equal(convert({ usdCents: 1, priceUsd: '1', tokenDecimals: 0 }), '1');
  assert.equal(convert({ priceUsd: '1', tokenDecimals: 6 }), '10000000');
});

test('plain decimal prices preserve leading zeros and trailing fractional zeros', () => {
  assert.equal(convert({ priceUsd: '0000.0025000' }), convert());
  assert.equal(convert({ priceUsd: '0000.3000' }), '33333333333333333334');
  assert.equal(convert({ priceUsd: '0003', tokenDecimals: 0 }), '4');
  assert.equal(convert({ priceUsd: '0'.repeat(77) + '1', tokenDecimals: 0 }), '10');
});

test('smallest supported price and largest supported cents use exact integer arithmetic', () => {
  assert.equal(convert({ priceUsd: '0.000000000000000001', tokenDecimals: 36 }), '1' + '0'.repeat(55));
  assert.equal(convert({ usdCents: Number.MAX_SAFE_INTEGER, priceUsd: '0.000000000000000001', tokenDecimals: 36 }),
    '9007199254740991' + '0'.repeat(52));
  assert.equal(convert({ usdCents: Number.MAX_SAFE_INTEGER, priceUsd: '1', tokenDecimals: 0 }), '90071992547410');
});

test('uint256 price maximum is accepted and the next integer is rejected', () => {
  assert.equal(convert({ priceUsd: uint256Max.toString() }), '1');
  assert.equal(convert({ priceUsd: `${uint256Max}.0` }), '1');
  assert.throws(() => convert({ priceUsd: (uint256Max + 1n).toString() }));
  assert.throws(() => convert({ priceUsd: `${uint256Max}.000000000000000001` }));
});

test('cents must be positive safe integer Numbers', () => {
  for (const usdCents of [undefined, null, false, true, '1000', 1000n, 0, -1, 0.1, 1.5,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => convert({ usdCents }), `invalid cents: ${String(usdCents)}`);
  }
});

test('token decimals must be integer Numbers from zero through thirty-six', () => {
  for (const tokenDecimals of [undefined, null, false, true, '18', 18n, -1, 37, 1.5,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => convert({ tokenDecimals }), `invalid decimals: ${String(tokenDecimals)}`);
  }
});

test('price must be a positive strict plain decimal string within the digit limits', () => {
  for (const priceUsd of [undefined, null, false, 1, 1n, {}, '', '0', '00', '0.0', '000.000',
    '-1', '+1', ' 1', '1 ', '\t1', '1\n', '1e-18', '1E3', 'NaN', 'Infinity', '0x1',
    '.3', '3.', '1,000', '1.2.3', '１', '1' + '0'.repeat(78), '0'.repeat(78) + '1',
    '0.0000000000000000001', '1.1234567890123456789']) {
    assert.throws(() => convert({ priceUsd }), `invalid price: ${String(priceUsd)}`);
  }
});
