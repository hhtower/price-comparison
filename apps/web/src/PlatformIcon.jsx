import React from 'react';
import { CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';

const assets = import.meta.glob('./assets/platform-icons/*.{svg,png,jpg}', { eager: true, query: '?url', import: 'default' });
const groupIcons = { openai: 'openai', anthropic: 'claude-color', google: 'google-color', xai: 'xai' };
const iconNames = {
  ...Object.fromEntries(CATALOG_PLATFORMS.flatMap(group => group.aliases.map(alias => [alias, groupIcons[group.id]]))),
  gemini: 'gemini-color', youtube: 'youtube', grok: 'grok', supergrok: 'grok', cursor: 'cursor',
  x: 'x', twitter: 'x', 'x.com': 'x', 'x/twitter': 'x', 'x／twitter': 'x', '推特': 'x',
  '微软': 'microsoft', outlook: 'microsoft', hotmail: 'microsoft', office: 'microsoft', 'microsoft 365': 'microsoft',
  '苹果': 'apple', icloud: 'apple', gmail: 'google-color',
  tg: 'telegram', '电报': 'telegram', fb: 'facebook', '脸书': 'facebook', ins: 'instagram', '领英': 'linkedin',
  '小红书': 'xiaohongshu', '奈飞': 'netflix', '网飞': 'netflix',
  'disney+': 'disney', 'disney plus': 'disney', '迪士尼': 'disney',
  '哔哩哔哩': 'bilibili', '多邻国': 'duolingo', '币安': 'binance', '欧易': 'okx', '腾讯': 'tencent',
  'microsoft azure': 'azure', 'perplexity ai': 'perplexity', '国际版抖音': 'tiktok',
  '深度求索': 'deepseek', qianwen: 'qwen', '千问': 'qwen', '通义千问': 'qwen',
  weixin: 'wechat', '微信': 'wechat', '腾讯qq': 'qq', tencentqq: 'qq', 'tencent qq': 'qq',
  codeium: 'windsurf',
  'manus ai': 'manus', 'meta-muse': 'muse', 'meta muse': 'muse', 'muse ai': 'muse', 'muse.ai': 'muse',
};

export default function PlatformIcon({ platform }) {
  const normalized = String(platform || '').trim().toLowerCase();
  const name = iconNames[normalized] || normalized;
  const src = assets[`./assets/platform-icons/${name}.svg`]
    || assets[`./assets/platform-icons/${name}.png`]
    || assets[`./assets/platform-icons/${name}.jpg`];
  return src ? <img className="product-platform-icon" src={src} width="22" height="22" alt="" aria-hidden="true" draggable="false" /> : null;
}
