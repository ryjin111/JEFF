const uint256Max = (1n << 256n) - 1n;
const decimalPrice = /^\d{1,78}(?:\.\d{1,18})?$/;

// Convert a positive USD-cent quote to token units without floating-point math.
// Round up so the smallest-unit amount covers the full quoted USD value.
export function usdCentsToTokenAmount({ usdCents, tokenDecimals, priceUsd } = {}) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0) throw new Error('JEFF_USD_CENTS_INVALID');
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error('JEFF_TOKEN_DECIMALS_INVALID');
  }
  if (typeof priceUsd !== 'string' || priceUsd.length > 97 || !decimalPrice.test(priceUsd)) {
    throw new Error('JEFF_TOKEN_PRICE_INVALID');
  }
  const [whole, fraction = ''] = priceUsd.split('.');
  const priceScale = 10n ** BigInt(fraction.length);
  const priceUnits = BigInt(whole + fraction);
  if (priceUnits <= 0n || priceUnits > uint256Max * priceScale) throw new Error('JEFF_TOKEN_PRICE_INVALID');
  const numerator = BigInt(usdCents) * priceScale * (10n ** BigInt(tokenDecimals));
  const denominator = 100n * priceUnits;
  const amount = (numerator + denominator - 1n) / denominator;
  if (amount > uint256Max) throw new Error('JEFF_TOKEN_AMOUNT_OVERFLOW');
  return amount.toString();
}
