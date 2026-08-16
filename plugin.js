// wiki_to_ima — DSH dynamic Cordis plugin (Host half)
// Wiki 网站页面 → 腾讯 IMA 知识库 批量导入/更新通道
//
// 加载方式(DSH 内):
//   1. cordis_define: code.host = 本文件从 `return {` 开始到文件末尾的全部内容(即函数体)
//   2. cordis_run 运行插件后,会话内即可调用工具 wiki_to_ima
// 依赖服务(Host): web, fs, shell, tools, timer
//
// 注意: 本文件不含任何凭据。IMA OpenAPI 的 client_id/api_key 与浏览器 cookie
// (IMA-UID/IMA-TOKEN/IMA-REFRESH-TOKEN)一律作为工具调用参数传入,请勿硬编码。
//
// 版本: v17
//  - v14: 知识库列表分页上限 20→400 页(2 万条),修复万页级知识库更新漏匹配
//  - v15: urls_file 参数,从工作区 JSON 文件读取大 URL 列表分块导入
//  - v16: 220021(每日列表配额用尽)优雅处理:导入不受影响,列表依赖阶段明确跳过
//  - v17: skip_builtin_filter 参数,关闭内置过滤以导入标题带扩展名的内容页

// ========== Wiki → IMA 知识库导入通道 (imakb, v17: skip builtin filter) ==========

function parseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (!host) return null;
  const path = m[3] === '' || m[3] === undefined ? '/' : m[3];
  return { scheme: scheme, host: host, path: path, query: m[4] || '' };
}

function normalizeSegments(p) {
  const out = [];
  const segs = p.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

function canonicalUrl(parsed) {
  if (!parsed) return '';
  return parsed.scheme + '://' + parsed.host + parsed.path + (parsed.query ? '?' + parsed.query : '');
}

function resolveHref(raw, base) {
  if (typeof raw !== 'string') return null;
  let href = raw.trim();
  href = href.replace(/&amp;/gi, '&').replace(/&#38;/gi, '&');
  if (href === '' || href.charAt(0) === '#') return null;
  if (/^(javascript:|mailto:|tel:|data:|file:|about:|blob:)/i.test(href)) return null;
  if (href.startsWith('//') && base) href = base.scheme + ':' + href;
  let absolute;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    absolute = href;
  } else {
    if (!base) return null;
    if (href.charAt(0) === '?') {
      absolute = base.scheme + '://' + base.host + base.path + href;
    } else {
      let path;
      if (href.charAt(0) === '/') path = href;
      else {
        const baseDir = base.path.slice(0, base.path.lastIndexOf('/') + 1);
        path = baseDir + href;
      }
      const hashIdx = path.indexOf('#');
      if (hashIdx !== -1) path = path.slice(0, hashIdx);
      const qIdx = path.indexOf('?');
      let query = '';
      if (qIdx !== -1) { query = path.slice(qIdx + 1); path = path.slice(0, qIdx); }
      absolute = base.scheme + '://' + base.host + normalizeSegments(path) + (query ? '?' + query : '');
    }
  }
  const hashIdx = absolute.indexOf('#');
  if (hashIdx !== -1) absolute = absolute.slice(0, hashIdx);
  const parsed = parseUrl(absolute);
  if (!parsed) return null;
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return null;
  return canonicalUrl(parsed);
}

const BUILTIN_EXCLUDE = [
  /[?&](action|do|diff|oldid|redlink|printable|feed|format|returnto|redirect|veaction|uselang|useskin|rev|offset|limit|search|sort|order|sitemap|xmlmime)=/i,
  /\/(Special|User|User_talk|Talk|File|Image|MediaWiki|Template|Module|Category|Help|Portal|Project)(:|%3A)/i,
  /[?&]title=(Special|User|User_talk|Talk|File|Image|MediaWiki|Template|Module|Category|Help|Portal|Project):/i,
  /\/(api\.php|rest\.php|opensearch_desc\.php|load\.php|thumb\.php|api|rest|graphql|releases|downloads)(\/|$|\?)/i,
  /\.(css|js|json|xml|rss|atom|pdf|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|otf|zip|tar|gz|bz2|7z|rar|mp3|mp4|webm|ogv|mov|avi|exe|msi|dmg)([?#]|$)/i,
  /(\/|%2f)(login|logout|signin|signup|signout|register|auth|account|profile|preferences|admin|manage|settings|search|sitemap|feed|rss|random|recentchanges|recent_changes|history|contributions|watchlist|robots\.txt)(\/|$|\?|%2f)/i,
  /\/_assets\//i
];

const CJK_NAMESPACE_RE = /(\/|:|title=)(特殊|模板|分类|用户|文件|讨论|帮助|媒体|模块|主题|项目)(:|%3A|\/|$|&)/;

function isExcludedUrl(url, includeRe, excludeRe, skipBuiltin) {
  if (includeRe && !includeRe.test(url)) return true;
  if (!skipBuiltin) {
    for (let i = 0; i < BUILTIN_EXCLUDE.length; i++) {
      if (BUILTIN_EXCLUDE[i].test(url)) return true;
    }
    let decoded = null;
    try { decoded = decodeURIComponent(url); } catch (e) { decoded = null; }
    if (decoded && decoded !== url && CJK_NAMESPACE_RE.test(decoded)) return true;
  }
  if (excludeRe && excludeRe.test(url)) return true;
  return false;
}

function extractLinks(html, pageUrl) {
  const links = [];
  const re = /<\s*a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`<>]+))[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    const abs = resolveHref(href, pageUrl);
    if (abs) {
      links.push(abs);
      if (links.length >= 800) break;
    }
  }
  return links;
}

function looksChallengedBody(content, statusCode) {
  const c = String(content || '');
  if (statusCode === 403 || statusCode === 429 || statusCode === 503 || statusCode === 567 || statusCode === 401) {
    if (c.length < 60000) return true;
  }
  if (c.length > 0 && c.length < 60000) {
    return /(just a moment|challenge|cf-chl|enable javascript|client challenge|couldn\S*\s*t load|browser\s+extension|ddos|\u8bf7\u6c42\u5df2\u88ab\u62e6\u622a|\u5b89\u5168\u9632\u62a4|\u8bbf\u95ee\u5df2\u88ab\u9650\u5236|EdgeOne)/i.test(c.slice(0, 8000));
  }
  return false;
}

function pageTitleOfUrl(url) {
  const u = parseUrl(url);
  if (!u) return '';
  if (u.query) {
    const pairs = u.query.split('&');
    for (let i = 0; i < pairs.length; i++) {
      const eq = pairs[i].indexOf('=');
      const key = (eq === -1 ? pairs[i] : pairs[i].slice(0, eq)).toLowerCase();
      const val = eq === -1 ? '' : pairs[i].slice(eq + 1);
      if (key === 'title' && val) {
        try { return decodeURIComponent(val.replace(/\+/g, ' ')); } catch (e) { return val; }
      }
    }
  }
  const segs = u.path.split('/').filter(Boolean);
  if (!segs.length) return '';
  let last = segs[segs.length - 1];
  try { last = decodeURIComponent(last); } catch (e) {}
  return last;
}

function titleMatchesEntry(pageTitle, entryTitle) {
  if (!entryTitle || !pageTitle) return false;
  if (entryTitle === pageTitle) return true;
  if (entryTitle.indexOf(pageTitle + ' - ') === 0) return true;
  if (entryTitle.indexOf(pageTitle + ' \u2013 ') === 0) return true;
  if (entryTitle.indexOf(pageTitle + ' \u2014 ') === 0) return true;
  return false;
}

// entry title may still be the raw URL while IMA parsing is pending; treat it as a match for that page
function entryMatchesPage(entryTitle, pageUrl) {
  if (!entryTitle || !pageUrl) return false;
  if (entryTitle === pageUrl) return true;
  if (entryTitle.indexOf(pageUrl + '&ima_') === 0) return true;
  if (entryTitle.indexOf(pageUrl + '?ima_') === 0) return true;
  return false;
}

async function runShell(ctx, request) {
  const spec = ctx.shell.resolve(request);
  return await ctx.shell.run(spec);
}

async function curlFetch(ctx, url, sessionCwd, standingPolicy, signal) {
  const safeUrl = String(url).replace(/'/g, "''");
  const cmd = "curl.exe -sS -L --max-time 45 --connect-timeout 15 --retry 2 --retry-delay 1 --compressed -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' -w '\n__DSH_HTTP_STATUS__:%{http_code}' -o - '" + safeUrl + "'";
  const request = { command: cmd, timeoutMs: 60000, stdoutMaxBytes: 4000000 };
  if (sessionCwd) request.workdir = sessionCwd;
  if (standingPolicy) request.sandboxPolicy = standingPolicy;
  if (signal) request.signal = signal;
  const res = await runShell(ctx, request);
  if (!res) throw new Error('curl 失败');
  const outText = res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : '';
  const markerIdx = outText.lastIndexOf('__DSH_HTTP_STATUS__');
  if (markerIdx === -1) {
    const errText = String(res.stderr && res.stderr.text || '').slice(0, 300);
    throw new Error('curl 失败(exit ' + res.exitCode + '): ' + errText);
  }
  const statusMatch = outText.slice(markerIdx).match(/(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const bodyText = outText.slice(0, markerIdx);
  return { statusCode: status, body: bodyText, truncated: !!(res.stdout && res.stdout.truncated) };
}

async function imaPost(ctx, endpoint, payload, clientId, apiKey, sessionCwd, standingPolicy, signal) {
  const bodyTarget = await ctx.fs.resolve('.wikikb-ima-body.json', sessionCwd ? { cwd: sessionCwd } : {});
  await ctx.fs.writeText(bodyTarget, JSON.stringify(payload), undefined, undefined, standingPolicy);
  const cmd = "$b='.wikikb-ima-body.json'; curl.exe -sS --max-time 60 -X POST -H \"Content-Type: application/json\" -H \"ima-openapi-clientid: " + clientId + "\" -H \"ima-openapi-apikey: " + apiKey + "\" --data-binary \"@$b\" \"https://ima.qq.com/openapi/wiki/v1/" + endpoint + "\"";
  const request = { command: cmd, timeoutMs: 70000, stdoutMaxBytes: 4000000 };
  if (sessionCwd) request.workdir = sessionCwd;
  if (standingPolicy) request.sandboxPolicy = standingPolicy;
  if (signal) request.signal = signal;
  const res = await runShell(ctx, request);
  if (!res) throw new Error('IMA 请求失败');
  const outText = res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : '';
  if (outText.trim().length === 0) {
    throw new Error('IMA 请求无输出(exit ' + res.exitCode + ') stderr=' + String(res.stderr && res.stderr.text || '').slice(0, 300));
  }
  let parsed = null;
  try { parsed = JSON.parse(outText); } catch (e) { throw new Error('IMA 响应解析失败: ' + outText.slice(0, 200)); }
  return parsed;
}

function bknHash(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) {
    h += ((h << 5) + token.charCodeAt(i)) >>> 0;
    h = h & 0x7fffffff;
  }
  return h;
}

function buildImaCookie(uid, token, refresh) {
  const parts = ['PLATFORM=H5', 'CLIENT-TYPE=256053', 'WEB-VERSION=999.999.999'];
  if (uid) parts.push('IMA-UID=' + uid);
  parts.push('IMA-TOKEN=' + token);
  if (refresh) parts.push('IMA-REFRESH-TOKEN=' + refresh);
  parts.push('UID-TYPE=2', 'TOKEN-TYPE=14');
  return parts.join('; ');
}

async function cgiPost(ctx, endpoint, payload, uid, token, refresh, sessionCwd, standingPolicy, signal) {
  const cookie = buildImaCookie(uid, token, refresh);
  const bkn = String(bknHash(token));
  const bodyTarget = await ctx.fs.resolve('.wikikb-ima-body.json', sessionCwd ? { cwd: sessionCwd } : {});
  await ctx.fs.writeText(bodyTarget, JSON.stringify(payload), undefined, undefined, standingPolicy);
  const cmd = "$b='.wikikb-ima-body.json'; curl.exe -sS --max-time 40 -X POST -H \"Content-Type: application/json\" -H \"x-ima-cookie: " + cookie + "\" -H \"x-ima-bkn: " + bkn + "\" -H \"from_browser_ima: 1\" --data-binary \"@$b\" \"https://ima.qq.com/cgi-bin/" + endpoint + "\"";
  const request = { command: cmd, timeoutMs: 50000, stdoutMaxBytes: 8000000 };
  if (sessionCwd) request.workdir = sessionCwd;
  if (standingPolicy) request.sandboxPolicy = standingPolicy;
  if (signal) request.signal = signal;
  const res = await runShell(ctx, request);
  if (!res) throw new Error('cgi 请求失败');
  const outText = res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : '';
  let parsed = null;
  try { parsed = JSON.parse(outText); } catch (e) { throw new Error('cgi 响应解析失败: ' + outText.slice(0, 200)); }
  return parsed;
}

async function cgiRefreshToken(ctx, uid, refresh, sessionCwd, standingPolicy, signal) {
  const res = await cgiPost(ctx, 'auth_login/refresh', { user_id: uid, refresh_token: refresh }, uid, '', refresh, sessionCwd, standingPolicy, signal);
  if (!res || res.code !== 0) throw new Error('token 刷新失败 code=' + (res && res.code) + ' msg=' + (res && res.msg));
  const tok = (typeof res.token === 'string' && res.token) || (res.data && typeof res.data.token === 'string' && res.data.token);
  return tok || '';
}

const AUTH_EXPIRED_CODES = [41, 100001, 100002, 600001, 600002];

async function cgiDelKnowledge(ctx, mediaIds, uid, token, refresh, sessionCwd, standingPolicy, signal) {
  let curToken = token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await cgiPost(ctx, 'knowledge/del_knowledge', { media_ids: mediaIds }, uid, curToken, refresh, sessionCwd, standingPolicy, signal);
    if (res && res.code === 0) return res;
    if (res && AUTH_EXPIRED_CODES.indexOf(res.code) !== -1 && refresh && attempt === 0) {
      try {
        const nt = await cgiRefreshToken(ctx, uid, refresh, sessionCwd, standingPolicy, signal);
        if (nt) { curToken = nt; continue; }
      } catch (e) { /* keep old token, fail */ }
    }
    return res;
  }
  return null;
}

function findAllpagesJson(node, depth) {
  if (depth > 6 || node === null || node === undefined) return null;
  if (typeof node === 'string') {
    if (node.indexOf('"allpages"') !== -1) return node;
    return null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = findAllpagesJson(node[i], depth + 1);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const r = findAllpagesJson(node[k], depth + 1);
        if (r !== null) return r;
      }
    }
  }
  return null;
}

// ========== plugin ==========
return {
  name: 'wiki-to-ima',
  inject: ['web', 'fs', 'shell', 'tools', 'timer'],
  apply(ctx) {
    const tool = harness.defineTool({
      name: 'wiki_to_ima',
      description: '把 Wiki 网站页面批量导入或更新到腾讯 IMA 知识库(经 IMA 服务端爬虫,可绕过本机 IP 被目标站点反爬限制的场景)。流程:发现页面(本机可访问时 BFS;被反爬拦截且提供 ima_token 时经 IMA 导入 allpages JSON 回读全站清单;也可直接传 urls 显式列表或 urls_file 文件列表)→ 分类页过滤 → 每批 10 个 URL 调 import_urls。知识库:传 kb_id 直接使用;或传 kb_name,自动按名字查找已有知识库,没有则自动创建(个人知识库)。文件夹:传 folder_name 自动创建(或复用同名)文件夹并把全部页面导入其中;传 folder_id 直接导入指定文件夹;不传则导入根目录。update=true 时进入更新模式(需 ima_uid/ima_token):对每个 URL 追加无害参数 ima_refresh 破 IMA 服务端 URL 缓存、真正重新抓取;轮询确认新条目在知识库中出现后才删除旧条目(旧条目识别兼容"已解析标题"与"未解析 URL 标题"两种形态,含同标题去重,按文件夹作用域;token 过期自动用 refresh_token 刷新),失败或校验超时则保留旧内容(kept),不丢数据。复查:导入结束后在 review_ms 窗口内轮询核对每个被受理页面的 media_id 是否真正出现在知识库中,缺失的自动换新 URL 参数重导一轮(review_retry),并报告 reviewed/missing。遇到 IMA 每日列表读取配额用尽(220021)时明确报告并跳过依赖列表的阶段(导入本身不受影响)。skip_builtin_filter=true 时关闭内置过滤(仅按 include/exclude 过滤),用于导入标题带扩展名等被误过滤的内容页。参数:kb_id 与 kb_name 至少传一个(显式 urls 列表模式下 url 可省略);client_id、api_key 必填;folder_id/folder_name 可选;max_pages 默认 100;verify_ms 默认 300000;bust_cache 默认 true;review_ms 默认 180000(设 0 关闭复查);ima_uid/ima_token/ima_refresh_token 可选;include/exclude 为 URL 正则过滤。',
      parameters: {
        url: { type: 'string', description: 'Wiki 网站首页(或任意内容页)URL;提供了 urls 列表或 urls_file 时可省略' },
        urls: { type: 'array', items: { type: 'string' }, description: '可选:显式指定要导入/更新的 URL 列表(跳过自动发现)' },
        urls_file: { type: 'string', description: '可选:从会话工作区内的 JSON 文件读取 URL 列表(文件内容为字符串数组),与 urls 参数合并去重;适合大列表分块导入' },
        kb_id: { type: 'string', description: 'IMA 知识库 ID(knowledge_base_id);与 kb_name 至少传一个,kb_id 优先' },
        kb_name: { type: 'string', description: 'IMA 知识库名称;按名字查找已有知识库,找不到则自动创建同名个人知识库' },
        client_id: { type: 'string', required: true, description: 'IMA OpenAPI Client ID(ima-openapi-clientid)' },
        api_key: { type: 'string', required: true, description: 'IMA OpenAPI API Key(ima-openapi-apikey)' },
        folder_id: { type: 'string', description: '可选:导入到的文件夹 ID,省略则导入知识库根目录' },
        folder_name: { type: 'string', description: '可选:目标文件夹名称;知识库根目录无同名文件夹时自动创建,页面全部导入该文件夹(优先于 folder_id)' },
        max_pages: { type: 'integer', description: '单次调用最多处理的页数(1-1000,默认 100)' },
        delay_ms: { type: 'integer', description: '每批 import_urls 之间的间隔毫秒(默认 500,避免频控)' },
        update: { type: 'boolean', description: '为 true 时进入更新模式:知识库中已存在的页面重新导入,确认新条目可见后再删除旧条目(需要 ima_uid/ima_token)' },
        verify_ms: { type: 'integer', description: '更新模式下等待新条目出现在知识库的校验窗口毫秒(默认 300000,每 20 秒轮询;设 0 表示不校验直接删旧)' },
        bust_cache: { type: 'boolean', description: '更新模式下给 URL 追加 ima_refresh=<时间戳> 无害参数,破 IMA 服务端同 URL 缓存,确保真正重新抓取(默认 true;个别严格路由站点可设 false)' },
        review_ms: { type: 'integer', description: '复查窗口毫秒:导入结束后核对每个页面的条目是否已出现在知识库(默认 180000,每 20 秒轮询;设 0 关闭复查)' },
        review_retry: { type: 'boolean', description: '复查发现缺失时,自动用带新参数的 URL 重导缺失页面一轮(默认 true;更新模式下重导成功还会补删对应旧条目)' },
        skip_builtin_filter: { type: 'boolean', description: '为 true 时跳过内置 URL 过滤(命名空间/扩展名/登录页等),仅按 include/exclude 正则过滤;用于导入标题带扩展名等被误过滤的内容页' },
        include: { type: 'string', description: '可选:仅导入 URL 匹配该正则的页面' },
        exclude: { type: 'string', description: '可选:跳过 URL 匹配该正则的页面' },
        ima_uid: { type: 'string', description: 'IMA 用户 ID(浏览器 cookie 中的 IMA-UID);更新模式必填' },
        ima_token: { type: 'string', description: 'IMA 会话 token(浏览器 cookie 中的 IMA-TOKEN);更新模式必填,过期会自动用 ima_refresh_token 刷新' },
        ima_refresh_token: { type: 'string', description: 'IMA 刷新 token(浏览器 cookie 中的 IMA-REFRESH-TOKEN),token 过期时自动刷新' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            kb_id: { type: 'string' },
            created_kb: { type: 'boolean' },
            discovered: { type: 'integer', required: true },
            imported: { type: 'integer', required: true },
            updated: { type: 'integer', required: true },
            added: { type: 'integer', required: true },
            kept: { type: 'integer', required: true },
            failed: { type: 'integer', required: true },
            deleted_old: { type: 'integer', required: true },
            reviewed: { type: 'integer', required: true },
            missing: { type: 'integer', required: true },
            folder_id: { type: 'string' },
            batches: { type: 'integer', required: true },
            mediaIds: { type: 'array', items: { type: 'string' } },
            errors: { type: 'array', items: { type: 'string' } }
          }
        },
        render(args, value) {
          const lines = [];
          lines.push('\uD83D\uDCE5 Wiki → IMA ' + (value.mode.indexOf('update') === 0 ? '更新' : '导入') + '完成 [' + value.mode + ']');
          if (value.kb_id) lines.push('- 知识库: ' + value.kb_id + (value.created_kb ? '(本次新建)' : ''));
          lines.push('- 发现页面: ' + value.discovered + ',成功导入: ' + value.imported + '(新增 ' + value.added + ',更新 ' + value.updated + ',保留旧版 ' + value.kept + '),失败: ' + value.failed);
          if (value.folder_id) lines.push('- 目标文件夹: ' + value.folder_id);
          if (value.reviewed >= 0) lines.push('- 复查: 已入库 ' + value.reviewed + ' / ' + value.imported + ',缺失 ' + value.missing);
          lines.push('- 删除旧条目: ' + value.deleted_old + ' 个;import_urls 批次: ' + value.batches + ' 批(每批最多 10 个 URL)');
          if (value.errors && value.errors.length) lines.push('- 错误: ' + value.errors.join('; '));
          return [{ type: 'text', text: lines.join('\n') }];
        }
      },
      timeoutMs: 60 * 60 * 1000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const signal = exec && exec.signal ? exec.signal : undefined;
        const aborted = () => signal && signal.aborted;
        const hasUrls = Array.isArray(args.urls) && args.urls.length > 0;
        const hasUrlsFile = typeof args.urls_file === 'string' && args.urls_file.trim().length > 0;
        const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
        const start = parseUrl(rawUrl);
        if (!hasUrls && !hasUrlsFile && (!start || (start.scheme !== 'http' && start.scheme !== 'https'))) throw new Error('url 必须是完整的 http(s) URL(或提供 urls 列表 / urls_file)');
        const startUrl = start ? canonicalUrl(start) : '';
        const origin = start ? start.scheme + '://' + start.host : '';
        if (typeof args.client_id !== 'string' || !args.client_id || typeof args.api_key !== 'string' || !args.api_key) {
          throw new Error('client_id、api_key 均为必填');
        }
        const updateMode = args.update === true;
        const bustCache = args.bust_cache !== false;
        const skipBuiltin = args.skip_builtin_filter === true;
        const hasTokens = typeof args.ima_token === 'string' && args.ima_token.trim().length > 0;
        if (updateMode && (!hasTokens || typeof args.ima_uid !== 'string' || !args.ima_uid)) {
          throw new Error('更新模式需要 ima_uid 与 ima_token(浏览器 cookie 中的 IMA-UID / IMA-TOKEN),用于删除旧条目');
        }
        let maxPages = args.max_pages === undefined ? 100 : Number(args.max_pages);
        if (!Number.isFinite(maxPages)) maxPages = 100;
        maxPages = Math.max(1, Math.min(1000, Math.floor(maxPages)));
        let delayMs = args.delay_ms === undefined ? 500 : Number(args.delay_ms);
        if (!Number.isFinite(delayMs)) delayMs = 500;
        delayMs = Math.max(0, Math.min(5000, Math.floor(delayMs)));
        let verifyMs = args.verify_ms === undefined ? 300000 : Number(args.verify_ms);
        if (!Number.isFinite(verifyMs)) verifyMs = 300000;
        verifyMs = Math.max(0, Math.min(900000, Math.floor(verifyMs)));
        let reviewMs = args.review_ms === undefined ? 180000 : Number(args.review_ms);
        if (!Number.isFinite(reviewMs)) reviewMs = 180000;
        reviewMs = Math.max(0, Math.min(900000, Math.floor(reviewMs)));
        const reviewRetry = args.review_retry !== false;
        let includeRe = null;
        if (typeof args.include === 'string' && args.include.trim()) {
          try { includeRe = new RegExp(args.include, 'i'); } catch (e) { throw new Error('include 不是合法正则'); }
        }
        let excludeRe = null;
        if (typeof args.exclude === 'string' && args.exclude.trim()) {
          try { excludeRe = new RegExp(args.exclude, 'i'); } catch (e) { throw new Error('exclude 不是合法正则'); }
        }

        const agent = exec && exec.agent ? exec.agent : null;
        let sessionCwd;
        try { sessionCwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined; } catch (e) { sessionCwd = undefined; }
        const policySvc = ctx.get('sandboxPolicy');
        let standingPolicy;
        try {
          standingPolicy = policySvc && typeof policySvc.resolve === 'function'
            ? policySvc.resolve(agent && agent.session ? { session: agent.session } : {})
            : undefined;
        } catch (e) { standingPolicy = undefined; }

        const result = { mode: updateMode ? 'update' : 'explicit', discovered: 0, imported: 0, updated: 0, added: 0, kept: 0, failed: 0, deleted_old: 0, reviewed: -1, missing: 0, batches: 0, mediaIds: [], errors: [] };

        const QUOTA_MSG = 'IMA 每日列表读取配额已用尽(220021,明天恢复):导入受理不受影响,但依赖列表的阶段(文件夹定位/更新匹配/校验/复查)暂不可用';
        function quotaError() { const e = new Error(QUOTA_MSG); e.quota = true; return e; }

        // resolve target knowledge base: kb_id > kb_name (search exact name → create if missing)
        let targetKbId = typeof args.kb_id === 'string' ? args.kb_id.trim() : '';
        const kbName = typeof args.kb_name === 'string' ? args.kb_name.trim() : '';
        if (!targetKbId && kbName) {
          const s = await imaPost(ctx, 'search_knowledge_base', { query: kbName, cursor: '', limit: 20 }, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
          if (s && s.code === 0 && s.data && Array.isArray(s.data.info_list)) {
            for (let i = 0; i < s.data.info_list.length; i++) {
              const k = s.data.info_list[i];
              const id = k.kb_id || k.id;
              const nm = k.kb_name || k.name;
              if (nm === kbName && id) { targetKbId = id; break; }
            }
          }
          if (!targetKbId) {
            const c = await imaPost(ctx, 'create_knowledge_base', { name: kbName, type: 'KBT_MINE_KB' }, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
            if (!c || c.code !== 0) throw new Error('创建知识库失败 code=' + (c && c.code) + ' msg=' + (c && c.msg));
            targetKbId = (c.data && (c.data.id || c.data.kb_id)) || '';
            if (!targetKbId) throw new Error('创建知识库响应缺少 id');
            result.created_kb = true;
          }
        }
        if (!targetKbId) throw new Error('需要 kb_id 或 kb_name 之一');
        result.kb_id = targetKbId;

        // load KB entries; folderId '' = root. includeFolders keeps media_type 99 folder entries.
        async function loadKbEntries(folderId, includeFolders) {
          const entries = [];
          let cursor = '';
          for (let i = 0; i < 400; i++) {
            const payload = { knowledge_base_id: targetKbId, cursor: cursor, limit: 50 };
            if (folderId) payload.folder_id = folderId;
            const r = await imaPost(ctx, 'get_knowledge_list', payload, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
            if (r && r.code === 220021) throw quotaError();
            if (!r || r.code !== 0 || !r.data) break;
            const items = r.data.knowledge_list || [];
            for (let j = 0; j < items.length; j++) {
              const it = items[j];
              if (!it || !it.media_id || !it.title) continue;
              if (it.media_type === 99 && !includeFolders) continue;
              entries.push({ id: it.media_id, title: it.title, isFolder: it.media_type === 99 });
            }
            if (r.data.is_end) break;
            cursor = r.data.next_cursor || '';
            if (!cursor) break;
          }
          return entries;
        }

        // resolve target folder: explicit folder_id wins; else folder_name (reuse or create); else root ('')
        let targetFolderId = typeof args.folder_id === 'string' ? args.folder_id.trim() : '';
        const folderName = typeof args.folder_name === 'string' ? args.folder_name.trim() : '';
        if (!targetFolderId && folderName) {
          let rootEntries = null;
          try {
            rootEntries = await loadKbEntries('', true);
          } catch (e) {
            if (e && e.quota) throw new Error(QUOTA_MSG + '(本次请改用 folder_id 参数)' );
            throw e;
          }
          let found = '';
          for (let i = 0; i < rootEntries.length; i++) {
            if (rootEntries[i].isFolder && rootEntries[i].title === folderName) { found = rootEntries[i].id; break; }
          }
          if (found) {
            targetFolderId = found;
          } else {
            const cf = await imaPost(ctx, 'create_folder', { knowledge_base_id: targetKbId, name: folderName }, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
            if (!cf || cf.code !== 0) {
              let hint = '';
              if (cf && cf.code === 222001) hint = '(该知识库可能已被删除或在回收站,请先在 IMA 中恢复或新建知识库)';
              throw new Error('创建文件夹失败 code=' + (cf && cf.code) + ' msg=' + (cf && cf.msg) + hint);
            }
            const mid = cf.data && cf.data.media_id;
            if (!mid) throw new Error('创建文件夹响应缺少 media_id');
            targetFolderId = mid;
          }
        }
        if (targetFolderId) result.folder_id = targetFolderId;

        const urls = [];
        const seen = new Set();
        const pushUrl = function (u) {
          if (!u || seen.has(u)) return;
          seen.add(u);
          if (isExcludedUrl(u, includeRe, excludeRe, skipBuiltin)) return;
          urls.push(u);
        };

        // urls_file: read JSON array from workspace file, merge with urls param
        if (hasUrlsFile) {
          let fileText = null;
          try {
            const ft = await ctx.fs.resolve(args.urls_file.trim(), sessionCwd ? { cwd: sessionCwd } : {});
            fileText = await ctx.fs.readText(ft);
          } catch (e) {
            throw new Error('读取 urls_file 失败: ' + (e && e.message ? e.message : String(e)));
          }
          let arr = null;
          try { arr = JSON.parse(fileText); } catch (e) { throw new Error('urls_file 不是合法 JSON'); }
          if (!Array.isArray(arr)) throw new Error('urls_file 内容必须是字符串数组');
          for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'string' && arr[i].trim()) pushUrl(arr[i].trim());
          }
        }

        if (hasUrls) {
          result.mode = updateMode ? 'update' : 'explicit';
          for (let i = 0; i < args.urls.length; i++) {
            if (typeof args.urls[i] === 'string' && args.urls[i].trim()) pushUrl(args.urls[i].trim());
          }
        } else if (hasUrlsFile) {
          result.mode = updateMode ? 'update' : 'explicit-file';
        } else {
          result.mode = updateMode ? 'update-bfs' : 'sandbox';
          let sandboxReachable = false;
          try {
            const first = await curlFetch(ctx, startUrl, sessionCwd, standingPolicy, signal);
            if (!looksChallengedBody(first.body, first.statusCode) && first.statusCode === 200) {
              sandboxReachable = true;
              const queue = [startUrl];
              const visited = new Set();
              while (queue.length > 0 && urls.length < maxPages && !aborted()) {
                const u = queue.shift();
                if (visited.has(u)) continue;
                visited.add(u);
                let page;
                try {
                  const r = await curlFetch(ctx, u, sessionCwd, standingPolicy, signal);
                  if (r.statusCode !== 200 || looksChallengedBody(r.body, r.statusCode)) continue;
                  page = { html: r.body };
                } catch (e) { continue; }
                pushUrl(u);
                const lu = parseUrl(u);
                const links = extractLinks(page.html, lu);
                for (let i = 0; i < links.length; i++) {
                  const lp = parseUrl(links[i]);
                  if (!lp) continue;
                  if (lp.scheme + '://' + lp.host !== origin) continue;
                  if (isExcludedUrl(links[i], includeRe, excludeRe, skipBuiltin)) continue;
                  if (!visited.has(links[i]) && !seen.has(links[i]) && urls.length < maxPages) queue.push(links[i]);
                }
                if (delayMs > 0 && !aborted()) await ctx.timeout(delayMs);
              }
            }
          } catch (e) { /* blocked */ }

          if (!sandboxReachable) {
            if (hasTokens) {
              result.mode = updateMode ? 'update-discovery' : 'ima-discovery';
              let apcontinue = '';
              let rounds = 0;
              try {
                while (rounds < 20 && urls.length < maxPages && !aborted()) {
                  rounds += 1;
                  let apiUrl = origin + '/api.php?action=query&list=allpages&apnamespace=0&aplimit=500&apfilterredir=nonredirects&format=json&formatversion=2';
                  if (apcontinue) apiUrl += '&apcontinue=' + encodeURIComponent(apcontinue);
                  const imp = await imaPost(ctx, 'import_urls', { knowledge_base_id: targetKbId, urls: [apiUrl] }, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
                  if (!imp || imp.code !== 0 || !imp.data || !imp.data.results) throw new Error('IMA 导入 allpages 失败: ' + (imp && imp.msg ? imp.msg : '?'));
                  const entry = imp.data.results[apiUrl];
                  if (!entry || entry.ret_code !== 0 || !entry.media_id) throw new Error('allpages URL 导入失败 ret_code=' + (entry && entry.ret_code));
                  let jsonText = null;
                  for (let poll = 0; poll < 60; poll++) {
                    if (aborted()) break;
                    const fetched = await cgiPost(ctx, 'knowledge/get_knowledge', { media_id: entry.media_id }, args.ima_uid, args.ima_token, args.ima_refresh_token || '', sessionCwd, standingPolicy, signal);
                    if (fetched && fetched.code === 0) {
                      const found = findAllpagesJson(fetched.data !== undefined ? fetched.data : fetched, 0);
                      if (found) { jsonText = found; break; }
                      const msg = fetched.msg || '';
                      if (/Parsing not completed|not completed|parsing/i.test(msg)) { await ctx.timeout(5000); continue; }
                      throw new Error('fetch 响应中未找到 allpages JSON: ' + JSON.stringify(fetched).slice(0, 300));
                    } else {
                      const msg = fetched && fetched.msg ? fetched.msg : '?';
                      if (/parsing|not completed/i.test(msg)) { await ctx.timeout(5000); continue; }
                      throw new Error('cgi fetch 失败 code=' + (fetched && fetched.code) + ' msg=' + msg);
                    }
                  }
                  if (!jsonText) throw new Error('allpages 解析等待超时');
                  let parsed;
                  try { parsed = JSON.parse(jsonText); } catch (e) { throw new Error('allpages JSON 解析失败'); }
                  const q = parsed.query || {};
                  const pages = q.allpages || [];
                  for (let i = 0; i < pages.length; i++) {
                    const title = pages[i] && pages[i].title;
                    if (!title) continue;
                    pushUrl(origin + '/index.php?title=' + encodeURIComponent(title));
                  }
                  const cont = q['continue'] || {};
                  apcontinue = cont.apcontinue || '';
                  if (!apcontinue) break;
                  await ctx.timeout(1000);
                }
              } catch (e) {
                result.errors.push('IMA 页面清单发现失败: ' + (e && e.message ? e.message : String(e)));
              }
            } else {
              result.mode = 'single-url';
              result.errors.push('本机无法访问该站点(被反爬拦截),且未提供 ima_token,只能导入起始 URL');
            }
          }
          if (startUrl) pushUrl(startUrl);
        }

        result.discovered = urls.length;
        const total = Math.min(urls.length, maxPages);

        // update mode: load existing KB entries (folder-scoped) → title map
        const titleToIds = {};
        if (updateMode) {
          try {
            const entries = await loadKbEntries(targetFolderId, false);
            for (let i = 0; i < entries.length; i++) {
              if (!titleToIds[entries[i].title]) titleToIds[entries[i].title] = [];
              titleToIds[entries[i].title].push(entries[i].id);
            }
          } catch (e) {
            if (e && e.quota) {
              result.errors.push(QUOTA_MSG + '(本次更新将按新增处理,可能产生重复条目,建议明天再跑一次 update 整理)');
            } else {
              throw e;
            }
          }
        }

        const toImport = []; // {url, importUrl, oldIds, ok, newMediaId, cleaned, dedupCount}
        const nowSec = Math.floor(Date.now() / 1000);
        for (let i = 0; i < total; i++) {
          const u = urls[i];
          const item = { url: u, importUrl: u, oldIds: [], ok: false, newMediaId: '', cleaned: false, dedupCount: 0 };
          if (updateMode) {
            if (bustCache) {
              item.importUrl = u + (u.indexOf('?') === -1 ? '?' : '&') + 'ima_refresh=' + (nowSec + i);
            }
            const title = pageTitleOfUrl(u);
            if (title) {
              for (const entryTitle in titleToIds) {
                if (!Object.prototype.hasOwnProperty.call(titleToIds, entryTitle)) continue;
                const matches = titleMatchesEntry(title, entryTitle) || entryMatchesPage(entryTitle, u);
                if (matches) {
                  item.oldIds = item.oldIds.concat(titleToIds[entryTitle]);
                }
              }
            }
          }
          toImport.push(item);
        }

        // import one chunk of items; returns {apiError, retryable, msg, results:[{item, ok, mediaId, retCode}]}
        async function importChunk(chunkItems) {
          const chunkUrls = chunkItems.map(function (x) { return x.importUrl; });
          try {
            const payload = { knowledge_base_id: targetKbId, urls: chunkUrls };
            if (targetFolderId) payload.folder_id = targetFolderId;
            const imp = await imaPost(ctx, 'import_urls', payload, args.client_id, args.api_key, sessionCwd, standingPolicy, signal);
            if (!imp || imp.code !== 0 || !imp.data || !imp.data.results) {
              const apiErr = !!(imp && imp.code === 110021);
              return { apiError: true, retryable: apiErr, msg: 'import_urls 返回异常 code=' + (imp && imp.code) + ' msg=' + (imp && imp.msg), results: chunkItems.map(function (x) { return { item: x, ok: false, retCode: imp && imp.code }; }) };
            }
            const results = imp.data.results;
            const out = [];
            for (let j = 0; j < chunkItems.length; j++) {
              const entry = results[chunkItems[j].importUrl];
              out.push({ item: chunkItems[j], ok: !!(entry && entry.ret_code === 0), mediaId: entry ? entry.media_id : '', retCode: entry ? entry.ret_code : undefined });
            }
            return { apiError: false, results: out };
          } catch (e) {
            return { apiError: false, msg: e && e.message ? e.message : String(e), results: chunkItems.map(function (x) { return { item: x, ok: false }; }) };
          }
        }

        // run import over items; returns items that still failed
        async function importAll(items, isRetry) {
          const toRetry = [];
          for (let i = 0; i < items.length; i += 10) {
            if (aborted()) break;
            const chunk = items.slice(i, i + 10);
            let out = null;
            let retryable = false;
            let apiMsg = '';
            for (let attempt = 0; attempt < 3; attempt++) {
              const r = await importChunk(chunk);
              if (r.apiError) {
                retryable = r.retryable;
                apiMsg = r.msg;
                if (retryable && attempt < 2) { await ctx.timeout(3000); continue; }
                out = r.results;
                break;
              }
              out = r.results;
              break;
            }
            result.batches += 1;
            if (!out) { toRetry.push.apply(toRetry, chunk); continue; }
            for (let j = 0; j < out.length; j++) {
              const o = out[j];
              if (o.ok) {
                o.item.ok = true;
                o.item.newMediaId = o.mediaId || '';
                if (o.mediaId) result.mediaIds.push(o.mediaId);
              } else {
                if (isRetry && result.errors.length < 20) result.errors.push('import ' + o.item.url + ': ret_code=' + o.retCode + (apiMsg ? ' (' + apiMsg + ')' : ''));
                toRetry.push(o.item);
              }
            }
            if (delayMs > 0 && !aborted()) await ctx.timeout(delayMs);
          }
          return toRetry;
        }

        const firstFail = await importAll(toImport, false);
        const stillFailed = firstFail.length ? await importAll(firstFail, true) : [];

        // update mode: verify new entries visible, then collect deletions
        const delIds = [];
        const delSeen = new Set();
        const expectedNewIds = new Set();
        const pending = []; // {item, mediaId}
        for (let i = 0; i < toImport.length; i++) {
          const item = toImport[i];
          if (item.ok && item.newMediaId) {
            expectedNewIds.add(item.newMediaId);
            pending.push({ item: item, mediaId: item.newMediaId });
          }
        }
        const addDel = function (id) {
          if (!id || delSeen.has(id) || expectedNewIds.has(id)) return;
          delSeen.add(id);
          delIds.push(id);
        };
        if (updateMode) {
          if (verifyMs > 0) {
            const deadline = Date.now() + verifyMs;
            const unresolved = new Map();
            for (let i = 0; i < pending.length; i++) unresolved.set(pending[i].mediaId, pending[i].item);
            let quotaHit = false;
            while (unresolved.size > 0 && Date.now() < deadline && !aborted() && !quotaHit) {
              let entries;
              try {
                entries = await loadKbEntries(targetFolderId, true);
              } catch (e) {
                if (e && e.quota) { quotaHit = true; break; }
                throw e;
              }
              const byId = {};
              for (let i = 0; i < entries.length; i++) byId[entries[i].id] = entries[i].title;
              const current = Array.from(unresolved.entries());
              for (let i = 0; i < current.length; i++) {
                const mid = current[i][0];
                const item = current[i][1];
                if (!byId[mid]) continue; // not visible yet
                const newTitle = byId[mid];
                for (let j = 0; j < item.oldIds.length; j++) addDel(item.oldIds[j]);
                for (let j = 0; j < entries.length; j++) {
                  if (entries[j].id !== mid && entries[j].title === newTitle && !entries[j].isFolder && item.oldIds.indexOf(entries[j].id) === -1) {
                    addDel(entries[j].id);
                    item.dedupCount += 1;
                  }
                }
                item.cleaned = true;
                unresolved.delete(mid);
              }
              if (unresolved.size > 0 && Date.now() < deadline && !aborted()) await ctx.timeout(20000);
            }
            if (quotaHit) {
              result.errors.push(QUOTA_MSG + '(校验阶段跳过,旧条目全部保留)');
            } else {
              for (const [mid, item] of unresolved) {
                if (result.errors.length < 20) result.errors.push('校验超时(新条目未出现,保留旧版): ' + item.url);
              }
            }
          } else {
            for (let i = 0; i < pending.length; i++) {
              const item = pending[i].item;
              for (let j = 0; j < item.oldIds.length; j++) addDel(item.oldIds[j]);
              item.cleaned = true;
            }
          }

          // delete collected old/duplicate entries
          for (let i = 0; i < delIds.length; i += 10) {
            if (aborted()) break;
            const chunk = delIds.slice(i, i + 10);
            const del = await cgiDelKnowledge(ctx, chunk, args.ima_uid, args.ima_token, args.ima_refresh_token || '', sessionCwd, standingPolicy, signal);
            if (del && del.code === 0) {
              const results = del.results || (del.data && del.data.results) || {};
              for (let j = 0; j < chunk.length; j++) {
                const r = results[chunk[j]];
                if (r && r.ret_code === 0) result.deleted_old += 1;
              }
            } else {
              result.errors.push('删除旧条目失败 code=' + (del && del.code) + ' msg=' + (del && del.msg) + ' ids=' + chunk.slice(0, 3).join(','));
            }
            await ctx.timeout(500);
          }
        }

        // account results
        for (let i = 0; i < toImport.length; i++) {
          const item = toImport[i];
          if (!item.ok) {
            result.failed += 1;
            if (updateMode && item.oldIds.length > 0) result.kept += 1;
            continue;
          }
          result.imported += 1;
          if (updateMode) {
            if (item.cleaned && (item.oldIds.length > 0 || item.dedupCount > 0)) result.updated += 1;
            else if (item.cleaned) result.added += 1;
            else {
              if (item.oldIds.length > 0) result.kept += 1;
              else result.added += 1;
            }
          } else {
            result.added += 1;
          }
        }

        // ===== review phase: confirm accepted imports actually materialized; retry missing =====
        if (reviewMs > 0) {
          const expected = [];
          for (let i = 0; i < toImport.length; i++) {
            if (toImport[i].ok && toImport[i].newMediaId) expected.push(toImport[i]);
          }
          const visibleIds = new Set();
          let quotaHit = false;
          const pollReview = async function () {
            const entries = await loadKbEntries(targetFolderId, true);
            for (let i = 0; i < entries.length; i++) visibleIds.add(entries[i].id);
          };
          const deadline = Date.now() + reviewMs;
          try {
            await pollReview();
          } catch (e) {
            if (e && e.quota) { quotaHit = true; } else { throw e; }
          }
          while (!quotaHit && expected.some(function (x) { return !visibleIds.has(x.newMediaId); }) && Date.now() < deadline && !aborted()) {
            await ctx.timeout(20000);
            try {
              await pollReview();
            } catch (e) {
              if (e && e.quota) { quotaHit = true; break; }
              throw e;
            }
          }
          if (quotaHit) {
            result.errors.push(QUOTA_MSG + '(复查阶段跳过)');
            result.reviewed = -2;
          } else {
            let missing = expected.filter(function (x) { return !visibleIds.has(x.newMediaId); });
            if (missing.length > 0 && reviewRetry && !aborted()) {
              const now2 = Math.floor(Date.now() / 1000);
              for (let i = 0; i < missing.length; i++) {
                const m = missing[i];
                m.importUrl = m.url + (m.url.indexOf('?') === -1 ? '?' : '&') + 'ima_review=' + (now2 + i);
              }
              await importAll(missing, true);
              const rDeadline = Date.now() + Math.min(reviewMs, 180000);
              while (missing.some(function (x) { return !x.ok || !visibleIds.has(x.newMediaId); }) && Date.now() < rDeadline && !aborted()) {
                await ctx.timeout(20000);
                await pollReview();
              }
              // update mode: for retry items now visible, delete their kept old entries
              if (updateMode) {
                const delIds2 = [];
                const delSeen2 = new Set();
                const retryDel = [];
                for (let i = 0; i < missing.length; i++) {
                  const m = missing[i];
                  if (m.ok && visibleIds.has(m.newMediaId)) {
                    retryDel.push(m);
                    for (let j = 0; j < m.oldIds.length; j++) {
                      const oid = m.oldIds[j];
                      if (!delSeen2.has(oid)) { delSeen2.add(oid); delIds2.push(oid); }
                    }
                  }
                }
                for (let i = 0; i < delIds2.length; i += 10) {
                  if (aborted()) break;
                  const chunk = delIds2.slice(i, i + 10);
                  const del = await cgiDelKnowledge(ctx, chunk, args.ima_uid, args.ima_token, args.ima_refresh_token || '', sessionCwd, standingPolicy, signal);
                  if (del && del.code === 0) {
                    const results = del.results || (del.data && del.data.results) || {};
                    for (let j = 0; j < chunk.length; j++) {
                      const r = results[chunk[j]];
                      if (r && r.ret_code === 0) result.deleted_old += 1;
                    }
                  }
                  await ctx.timeout(500);
                }
                for (let i = 0; i < retryDel.length; i++) {
                  if (retryDel[i].oldIds.length > 0) {
                    result.updated += 1;
                    if (result.kept > 0) result.kept -= 1;
                  }
                }
              }
              missing = missing.filter(function (x) { return !x.ok || !visibleIds.has(x.newMediaId); });
            }
            result.reviewed = expected.length - missing.length;
            result.missing = missing.length;
            for (let i = 0; i < missing.length; i++) {
              if (result.errors.length < 20) result.errors.push('复查缺失: ' + missing[i].url);
            }
          }
        }

        if (result.errors.length > 20) result.errors = result.errors.slice(0, 20);
        return result;
      }
    });

    harness.registerTool(ctx, tool);
  }
};
