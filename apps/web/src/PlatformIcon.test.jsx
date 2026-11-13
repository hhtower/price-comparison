import React from 'react';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import PlatformIcon from './PlatformIcon.jsx';

const assets = import.meta.glob('./assets/platform-icons/*.{svg,png,jpg}', { eager: true, query: '?url', import: 'default' });

afterEach(cleanup);

test.each([
  [' OpenAI ', 'openai'], ['open ai', 'openai'], ['ChatGPT', 'openai'], ['codex', 'openai'],
  ['anthropic', 'claude-color'], ['Claude', 'claude-color'],
  ['google', 'google-color'], ['gemini', 'gemini-color'], ['youtube', 'youtube'],
  ['xai', 'xai'], ['x.ai', 'xai'], ['grok', 'grok'], ['supergrok', 'grok'], ['cursor', 'cursor'],
  ['x', 'x'], ['twitter', 'x'], ['x.com', 'x'], ['x/twitter', 'x'], ['x／twitter', 'x'], ['推特', 'x'],
])('maps platform %s to its own local mark', (platform, name) => {
  const { container } = render(<PlatformIcon platform={platform} />);
  const icon = container.querySelector('img');
  expect(icon).toHaveAttribute('src', assets[`./assets/platform-icons/${name}.svg`]);
  expect(icon).toHaveAttribute('alt', '');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).toHaveAttribute('width', '22');
  expect(icon).toHaveAttribute('height', '22');
});

test.each([
  ...[
    'apple', 'microsoft', 'github', 'adobe', 'telegram', 'discord', 'facebook', 'instagram',
    'meta', 'linkedin', 'whatsapp', 'yahoo', 'netflix', 'spotify', 'steam', 'disney', 'hbo',
    'notion', 'figma', 'perplexity', 'suno', 'runway', 'bilibili', 'duolingo', 'paypal',
    'visa', 'binance', 'okx', 'ebay', 'azure', 'coursera', 'gcash', 'gopay',
    'giffgaff', 'upi', 'surfshark', '1password', 'tiktok',
    'deepseek', 'qwen', 'wechat', 'qq', 'windsurf', 'trae', 'kiro', 'manus', 'muse',
  ].map(platform => [platform, `${platform}.svg`]),
  ['xiaohongshu', 'xiaohongshu.png'], ['canva', 'canva.jpg'], ['tencent', 'tencent.png'],
  [' Microsoft ', 'microsoft.svg'], ['微软', 'microsoft.svg'], ['Outlook', 'microsoft.svg'],
  ['hotmail', 'microsoft.svg'], ['office', 'microsoft.svg'], ['microsoft 365', 'microsoft.svg'],
  ['苹果', 'apple.svg'], ['icloud', 'apple.svg'], ['Gmail', 'google-color.svg'],
  ['TG', 'telegram.svg'], ['电报', 'telegram.svg'], ['脸书', 'facebook.svg'],
  ['ins', 'instagram.svg'], ['领英', 'linkedin.svg'], ['小红书', 'xiaohongshu.png'],
  ['奈飞', 'netflix.svg'], ['网飞', 'netflix.svg'], ['Disney+', 'disney.svg'],
  ['disney plus', 'disney.svg'], ['迪士尼', 'disney.svg'], ['哔哩哔哩', 'bilibili.svg'],
  ['多邻国', 'duolingo.svg'], ['币安', 'binance.svg'], ['欧易', 'okx.svg'],
  ['腾讯', 'tencent.png'], ['microsoft azure', 'azure.svg'], ['perplexity ai', 'perplexity.svg'],
  ['国际版抖音', 'tiktok.svg'],
  [' DeepSeek ', 'deepseek.svg'], ['深度求索', 'deepseek.svg'],
  ['Qwen', 'qwen.svg'], ['qianwen', 'qwen.svg'], ['千问', 'qwen.svg'], ['通义千问', 'qwen.svg'],
  ['WeChat', 'wechat.svg'], ['weixin', 'wechat.svg'], ['微信', 'wechat.svg'],
  ['QQ', 'qq.svg'], ['腾讯QQ', 'qq.svg'], ['tencentqq', 'qq.svg'], ['tencent qq', 'qq.svg'],
  ['Windsurf', 'windsurf.svg'], ['codeium', 'windsurf.svg'], ['TRAE', 'trae.svg'],
  ['Kiro', 'kiro.svg'], [' KIRO ', 'kiro.svg'],
  ['Manus', 'manus.svg'], ['manus ai', 'manus.svg'],
  ['Muse', 'muse.svg'], ['meta-muse', 'muse.svg'], ['meta muse', 'muse.svg'],
  ['muse ai', 'muse.svg'], ['muse.ai', 'muse.svg'],
])('renders known brand %s using the local asset %s', (platform, filename) => {
  const { container } = render(<PlatformIcon platform={platform} />);
  const icon = container.querySelector('img');
  const src = assets[`./assets/platform-icons/${filename}`];
  expect(src).toBeTruthy();
  expect(icon).toHaveAttribute('src', src);
  expect(icon).toHaveAttribute('alt', '');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
});

test.each([
  undefined, null, '', 'unknown', 'constructor', '__proto__', 'toString', 'ip', 'email',
  '其它', 'software', 'service', 'generic', 'bundle', 'netflix-clone', 'microsoftish',
])('does not invent a brand for %s', platform => {
  const { container } = render(<PlatformIcon platform={platform} />);
  expect(container).toBeEmptyDOMElement();
});
