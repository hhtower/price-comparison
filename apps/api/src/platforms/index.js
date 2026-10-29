import liandong from './liandong.js';
import platform16688 from './16688.js';
import publicProducts from './public-products-v1.js';
import acgFaka from './acg-faka.js';
import orionKey from './orion-key.js';
import dujiaoka from './dujiaoka.js';
import emshop from './emshop.js';
import catcard from './catcard.js';
import acgFakaV5 from './acg-faka-v5.js';
import prism from './prism.js';
import xingbao from './xingbao.js';
import { withSettlementEstimates } from './settlement-estimate.js';

const platforms = [liandong, platform16688, publicProducts, acgFaka, orionKey, dujiaoka, emshop, catcard, acgFakaV5, prism, xingbao].map(withSettlementEstimates);

export function platformForUrl(value, protocol) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid shop URL'); }
  if (url.protocol !== 'https:') throw new TypeError('Shop URL must use HTTPS');
  if (url.username || url.password || url.port) throw new TypeError('Invalid shop URL credentials or port');
  if (protocol) {
    const selected = platforms.find(item => item.id === protocol);
    if (!selected) throw new RangeError(`Unsupported shop protocol: ${protocol}`);
    return selected;
  }
  const platform = platforms.find(item => item.hosts.includes(url.hostname));
  if (!platform) throw new RangeError(`Unsupported shop host: ${url.hostname}`);
  return platform;
}

export { platforms };
export { FX_URL, latestCnyPerUsd } from './prism.js';
