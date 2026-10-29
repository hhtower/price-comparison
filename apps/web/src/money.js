export function formatMoney(value, currency = 'CNY') {
  if (value == null || value === '') return '暂无价格';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '暂无价格';
  const symbols = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[String(currency).toUpperCase()] || (currency ? `${currency} ` : '');
  return `${symbol}${amount.toFixed(2).replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')}`;
}
