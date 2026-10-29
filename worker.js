// ===== 竞赛副本闯关 · 搜索后端（Cloudflare Worker 版）=====
// 职责：接收比赛名 → 联网调百度 AI 搜索 → 返回搜索结果
// key 放在 Worker 的「环境变量/密钥」里（BAIDU_API_KEY），绝不写进代码

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return json({ ok: true });
    }

    // 健康检查
    if (pathname === '/api/health') {
      return json({ ok: true, configured: Boolean(env.BAIDU_API_KEY || env.SERPER_API_KEY) });
    }

    // 搜索接口
    if (pathname === '/api/search') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: '只支持 POST' }, 405);
      }

      const baiduKey = env.BAIDU_API_KEY || '';
      const serperKey = env.SERPER_API_KEY || '';

      if (!baiduKey && !serperKey) {
        return json({
          ok: false,
          error: 'not_configured',
          message: '搜索服务尚未配置 API key，暂时无法联网搜索。',
        }, 503);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: '请求体格式错误' }, 400);
      }

      const query = (body.query || '').trim();
      if (!query) {
        return json({ ok: false, error: '缺少 query 参数' }, 400);
      }

      try {
        let results = [];
        if (baiduKey) {
          results = await baiduSearch(query, baiduKey);
        } else if (serperKey) {
          results = await serperSearch(query, serperKey);
        }
        return json({ ok: true, query, results });
      } catch (e) {
        return json({
          ok: false,
          error: 'search_failed',
          message: '搜索请求失败：' + (e.message || '未知错误'),
        }, 502);
      }
    }

    // 其余请求：走静态资源（网站页面），由 Cloudflare 的 assets 绑定自动提供
    // env.ASSETS 是 assets 目录的绑定，用它来服务 index.html、图片等
    try {
      const asset = await env.ASSETS.fetch(request);
      if (asset && asset.status !== 404) {
        return asset;
      }
    } catch (e) {
      // 忽略，继续走下面的兜底
    }

    // 兜底：SPA 回退到 index.html（如果 assets 里有）
    try {
      const fallback = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      if (fallback && fallback.status !== 404) {
        return fallback;
      }
    } catch (e) {
      // 忽略
    }

    return json({ ok: false, error: 'not_found', message: '页面不存在' }, 404);
  },
};

// ===== 工具 =====
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function postJSON(apiUrl, headers, body) {
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  if (!resp.ok) {
    const err = new Error('search api error ' + resp.status);
    err.detail = text.slice(0, 500);
    throw err;
  }
  return parsed;
}

// 调百度 AI 搜索
async function baiduSearch(query, apiKey) {
  const body = {
    messages: [{ role: 'user', content: query }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: 10 }],
  };
  const headers = { Authorization: 'Bearer ' + apiKey };
  const result = await postJSON('https://qianfan.baidubce.com/v2/ai_search/web_search', headers, body);

  const refs = (result && result.references) || (result && result.data && result.data.references) || [];
  return refs.map((r) => ({
    title: r.title || r.name || '',
    url: r.url || r.link || '',
    snippet: r.summary || r.snippet || r.content || r.abstract || '',
    date: r.publish_time || r.date || '',
    source: r.site || r.domain || '',
  })).filter((r) => r.title || r.snippet);
}

// 调 Serper（备用）
async function serperSearch(query, apiKey) {
  const headers = { 'X-API-KEY': apiKey };
  const result = await postJSON('https://google.serper.dev/search', headers, { q: query, num: 10 });
  const organic = (result && result.organic) || [];
  return organic.map((r) => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
    date: r.date || '',
    source: r.displayLink || '',
  })).filter((r) => r.title || r.snippet);
}
