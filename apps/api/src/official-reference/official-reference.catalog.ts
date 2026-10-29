// App IDs and publisher identities verified against Apple's public lookup on 2026-09-27.
// These are navigation metadata, never hardcoded prices.
export const REFERENCE_APPS = [
  { id: '6448311069', name: 'ChatGPT', developer: 'OpenAI', website: 'https://chatgpt.com/pricing/', category: 'AI 助手' },
  { id: '6473753684', name: 'Claude', developer: 'Anthropic', website: 'https://claude.com/pricing', category: 'AI 助手' },
  { id: '6477489729', name: 'Gemini', developer: 'Google', website: 'https://one.google.com/about/google-ai-plans/', category: 'AI 助手' },
  { id: '1232780281', name: 'Notion', developer: 'Notion Labs', website: 'https://www.notion.com/pricing', category: '效率工具' },
  { id: '897446215', name: 'Canva', developer: 'Canva', website: 'https://www.canva.com/pricing/', category: '设计工具' },
  { id: '544007664', name: 'YouTube', developer: 'Google', website: 'https://www.youtube.com/premium', category: '视频音乐' },
  { id: '324684580', name: 'Spotify', developer: 'Spotify', website: 'https://www.spotify.com/premium/', category: '视频音乐' },
  { id: '570060128', name: 'Duolingo', developer: 'Duolingo', website: 'https://www.duolingo.com/super', category: '语言学习' },
] as const;

export const REFERENCE_REGIONS = [
  ['us', '美国', 'USD'], ['hk', '中国香港', 'HKD'], ['jp', '日本', 'JPY'], ['cn', '中国大陆', 'CNY'],
  ['tw', '中国台湾', 'TWD'], ['kr', '韩国', 'KRW'], ['sg', '新加坡', 'SGD'], ['gb', '英国', 'GBP'],
  ['de', '德国', 'EUR'], ['fr', '法国', 'EUR'], ['tr', '土耳其', 'TRY'], ['in', '印度', 'INR'],
  ['id', '印度尼西亚', 'IDR'], ['my', '马来西亚', 'MYR'], ['th', '泰国', 'THB'], ['vn', '越南', 'VND'],
  ['ph', '菲律宾', 'PHP'], ['au', '澳大利亚', 'AUD'], ['ca', '加拿大', 'CAD'], ['br', '巴西', 'BRL'],
  ['mx', '墨西哥', 'MXN'], ['ae', '阿联酋', 'AED'], ['za', '南非', 'ZAR'],
  ['ng', '尼日利亚', 'NGN'], ['pk', '巴基斯坦', 'PKR'], ['eg', '埃及', 'EGP'],
  // Billing currencies verified against Apple's public catalog on 2026-10-02.
  // Some storefronts bill in USD rather than the country's domestic currency.
  ['cl', '智利', 'CLP'], ['ar', '阿根廷', 'USD'], ['co', '哥伦比亚', 'COP'], ['pe', '秘鲁', 'PEN'],
  ['ec', '厄瓜多尔', 'USD'], ['uy', '乌拉圭', 'USD'], ['cr', '哥斯达黎加', 'USD'], ['pa', '巴拿马', 'USD'],
  ['nz', '新西兰', 'NZD'], ['ch', '瑞士', 'CHF'], ['at', '奥地利', 'EUR'], ['be', '比利时', 'EUR'],
  ['nl', '荷兰', 'EUR'], ['es', '西班牙', 'EUR'], ['it', '意大利', 'EUR'], ['pt', '葡萄牙', 'EUR'],
  ['ie', '爱尔兰', 'EUR'], ['fi', '芬兰', 'EUR'], ['gr', '希腊', 'EUR'], ['pl', '波兰', 'PLN'],
  ['cz', '捷克', 'CZK'], ['dk', '丹麦', 'DKK'], ['se', '瑞典', 'SEK'], ['no', '挪威', 'NOK'],
  ['ro', '罗马尼亚', 'RON'], ['hu', '匈牙利', 'HUF'], ['ua', '乌克兰', 'USD'], ['sa', '沙特阿拉伯', 'SAR'],
  ['qa', '卡塔尔', 'QAR'], ['il', '以色列', 'ILS'], ['kw', '科威特', 'USD'], ['ke', '肯尼亚', 'USD'],
  ['ma', '摩洛哥', 'USD'], ['gh', '加纳', 'USD'],
] as const;
