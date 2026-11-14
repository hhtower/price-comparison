import type { TagValue } from '@price-comparison/catalog/purchase-attributes';
import type { JsonValue } from '../../src/database/types.js';

// Synthetic semantic reference labels for model evaluation, not program-derived judgments.
export const tagReviewSemanticControls: ReadonlyArray<{
  id: string; input: JsonValue; tags: Array<{ name: string; value: TagValue }>; expectedAccepted: boolean[];
}> = [
  {"id":"negation-1","input":{"name":"商品","sourceData":{"evidence":"账号尚未完成短信验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-3","input":{"name":"商品","sourceData":{"evidence":"并非已完成短信验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-4","input":{"name":"商品","sourceData":{"evidence":"建议买家完成短信验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-5","input":{"name":"商品","sourceData":{"evidence":"买家必须完成短信验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-6","input":{"name":"商品","sourceData":{"evidence":"如果已完成短信验证即可使用。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-7","input":{"name":"商品","sourceData":{"evidence":"建议购买已完成短信验证的账号。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-8","input":{"name":"商品","sourceData":{"evidence":"不要求已完成短信验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-9","input":{"name":"商品","sourceData":{"evidence":"需要提供已完成短信验证的账号。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-10","input":{"name":"商品","sourceData":{"evidence":"仅限已完成短信验证的用户购买。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-11","input":{"name":"商品","sourceData":{"evidence":"以已完成短信验证为前提。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-12","input":{"name":"商品","sourceData":{"evidence":"已完成短信验证的用户才能购买。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-13","input":{"name":"商品","sourceData":{"evidence":"无需完成短信验证。"}},"tags":[{"name":"sms_verification","value":"unverified"}],"expectedAccepted":[false]},
  {"id":"negation-14","input":{"name":"商品","sourceData":{"evidence":"已完成KYC实名认证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"negation-15","input":{"name":"商品","sourceData":{"evidence":"Token有效期7天。"}},"tags":[{"name":"duration","value":7}],"expectedAccepted":[false]},
  {"id":"completed-with-vpn","input":{"name":"商品","sourceData":{"evidence":"账号已完成短信验证。登录时需要使用VPN。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[true]},
  {"id":"completed-without-reverification","input":{"name":"商品","sourceData":{"evidence":"账号已完成短信验证，不需要买家再次验证。"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[true]},
  {"id":"actual-use-period","input":{"name":"商品","sourceData":{"evidence":"Token有效期7天，订阅使用期30天，账号号龄2年。"}},"tags":[{"name":"duration","value":30}],"expectedAccepted":[true]},
  {"id":"warranty-qualification","input":{"name":"商品","spec":"1个月，首登质保24小时，封号不保"},"tags":[{"name":"duration","value":30},{"name":"warranty","value":"首登质保24小时"}],"expectedAccepted":[true,false]},
  {"id":"multiline-prohibition","input":{"name":"商品","sourceData":{"evidence":"不提供以下入口：\nAPI"}},"tags":[{"name":"access_channel","value":"api"}],"expectedAccepted":[false]},
  {"id":"multiline-optional","input":{"name":"商品","sourceData":{"evidence":"如果购买附加服务：\nAPI"}},"tags":[{"name":"access_channel","value":"api"}],"expectedAccepted":[false]},
  {"id":"multiline-required","input":{"name":"商品","sourceData":{"evidence":"买家必须\n账号已完成短信验证"}},"tags":[{"name":"sms_verification","value":"verified"}],"expectedAccepted":[false]},
  {"id":"multiline-client","input":{"name":"商品","sourceData":{"evidence":"支持\nSub2API。支持API。"}},"tags":[{"name":"supported_client","value":"sub2api"},{"name":"access_channel","value":"api"}],"expectedAccepted":[true,true]},
  {"id":"scope-linked-promotion","input":{"name":"Free账号 已接码","sourceData":{"evidence":"plus代充链接：https://example.invalid/offer\n\n30天质保，美区账号。"}},"tags":[{"name":"sms_verification","value":"verified"},{"name":"region","value":"us"},{"name":"warranty","value":"30天质保"}],"expectedAccepted":[true,false,false]},
  {"id":"scope-own-warranty-1","input":{"name":"Free账号 已接码","sourceData":{"evidence":"本商品质保7天。\nplus代充链接：https://example.invalid/offer\n\n30天质保，美区账号。"}},"tags":[{"name":"warranty","value":"质保7天"},{"name":"region","value":"us"},{"name":"warranty","value":"30天质保"}],"expectedAccepted":[true,false,false]},
  {"id":"scope-own-warranty-2","input":{"name":"Free账号 已接码","sourceData":{"evidence":"plus代充链接：https://example.invalid/offer\n\n30天质保，美区账号。\n本商品质保7天。"}},"tags":[{"name":"warranty","value":"质保7天"},{"name":"region","value":"us"},{"name":"warranty","value":"30天质保"}],"expectedAccepted":[true,false,false]},
  {"id":"scope-own-warranty-3","input":{"name":"Free账号 已接码","sourceData":{"evidence":"本商品质保7天。推荐商品：Plus代充，30天质保，封号不保。"}},"tags":[{"name":"warranty","value":"质保7天"},{"name":"region","value":"us"},{"name":"warranty","value":"30天质保"}],"expectedAccepted":[true,false,false]},
  {"id":"scope-inline-promotion","input":{"name":"Free账号 已接码","sourceData":{"evidence":"本商品为Free账号，另售美区账号，30天质保。"}},"tags":[{"name":"region","value":"us"},{"name":"warranty","value":"30天质保"}],"expectedAccepted":[false,false]},
  {"id":"scope-exclusion-1","input":{"name":"Free账号 已接码","sourceData":{"evidence":"本商品质保7天。封号不保，其他商品请联系。"}},"tags":[{"name":"warranty","value":"质保7天"}],"expectedAccepted":[false]},
  {"id":"scope-exclusion-2","input":{"name":"Free账号 已接码","sourceData":{"evidence":"本商品质保7天。修改密码不保，其他商品请联系。"}},"tags":[{"name":"warranty","value":"质保7天"}],"expectedAccepted":[false]},
  {"id":"scope-own-link-1","input":{"name":"Plus代充","sourceData":{"evidence":"本商品为Plus代充，30天质保。\n本商品代充链接：https://example.invalid/"}},"tags":[{"name":"warranty","value":"本商品为Plus代充，30天质保"}],"expectedAccepted":[true]},
  {"id":"scope-own-link-2","input":{"name":"Plus代充","sourceData":{"evidence":"Plus代充链接：https://example.invalid/\n30天质保。"}},"tags":[{"name":"warranty","value":"30天质保"}],"expectedAccepted":[true]},
  {"id":"scope-own-link-3","input":{"name":"Plus代充","sourceData":{"evidence":"购买链接：https://example.invalid/\nPlus代充，30天质保。"}},"tags":[{"name":"warranty","value":"Plus代充，30天质保"}],"expectedAccepted":[true]},
  {"id":"scope-own-link-4","input":{"name":"Plus代充","sourceData":{"evidence":"使用教程：https://example.invalid/\nPlus代充，30天质保。"}},"tags":[{"name":"warranty","value":"Plus代充，30天质保"}],"expectedAccepted":[true]},
];
