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
        // 记录用量：搜索 1 次
        await recordUsage(env, { search: 1, inTokens: 0, outTokens: 0 });
        return json({ ok: true, query, results });
      } catch (e) {
        return json({
          ok: false,
          error: 'search_failed',
          message: '搜索请求失败：' + (e.message || '未知错误'),
        }, 502);
      }
    }

    // AI 整理接口：接收「比赛名 + 任务类型 + 参考文本」，用百度 ERNIE 对话模型整理成结构化内容
    if (pathname === '/api/summarize') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: '只支持 POST' }, 405);
      }

      const baiduKey = env.BAIDU_API_KEY || '';
      if (!baiduKey) {
        return json({ ok: false, error: 'not_configured', message: 'AI 服务尚未配置，暂时无法整理。' }, 503);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: '请求体格式错误' }, 400);
      }

      const { task, name, context } = body;
      if (!task || !name) {
        return json({ ok: false, error: '缺少 task 或 name 参数' }, 400);
      }

      try {
        const prompt = buildSummarizePrompt(task, name, context || '');
        const result = await ernieChat(baiduKey, prompt);
        // 记录用量：AI 整理 1 次 + 估算 token（中文约 1 字 ≈ 1 token 的粗略估算）
        const inTokens = Math.ceil(prompt.length / 2);       // 粗略：中文约 2 字符 1 token，保守按 2 字符算
        const outTokens = Math.ceil(String(result||'').length / 1.5);
        await recordUsage(env, { search: 0, inTokens, outTokens });
        return json({ ok: true, result });
      } catch (e) {
        return json({
          ok: false,
          error: 'summarize_failed',
          message: 'AI 整理失败：' + (e.message || '未知错误'),
        }, 502);
      }
    }

    // 图片/文件识别接口：接收 base64 图片，用视觉模型提取文字
    if (pathname === '/api/ocr') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: '只支持 POST' }, 405);
      }

      const baiduKey = env.BAIDU_API_KEY || '';
      if (!baiduKey) {
        return json({ ok: false, error: 'not_configured', message: 'AI 服务尚未配置。' }, 503);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: '请求体格式错误' }, 400);
      }

      const image = body.image || '';   // base64（不含 data: 前缀也行）
      const text = body.text || '';     // 文件直接读取的文本内容（兜底）

      try {
        let extracted = '';
        if (image) {
          extracted = await visionChat(baiduKey, image);
        } else if (text) {
          extracted = text;
        }

        if (!extracted || !extracted.trim()) {
          return json({ ok: false, error: 'empty', message: '没能从这张图里识别出文字，请换一张更清晰的截图，或改用「文字」方式手动描述。' }, 422);
        }

        // 记录用量：当作一次 AI 整理
        await recordUsage(env, { search: 0, inTokens: Math.ceil((image ? image.length / 3 : text.length) / 2), outTokens: Math.ceil(extracted.length / 1.5) });
        return json({ ok: true, text: extracted });
      } catch (e) {
        return json({
          ok: false,
          error: 'ocr_failed',
          message: '识别失败：' + (e.message || '未知错误'),
        }, 502);
      }
    }

    // 管理后台接口：查看用量（需密码）
    if (pathname === '/api/admin') {
      return handleAdmin(request, env);
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

// ===== 用量统计 =====
// 价格常量（用于后台估算费用，单位：元）
const PRICE = {
  searchPerCall: 0.036,          // 百度 AI 搜索：0.036 元/次（超免费额度后）
  ernieInPerK: 0.004,            // ERNIE-5.1 输入：0.004 元/千token
  ernieOutPerK: 0.018,           // ERNIE-5.1 输出：0.018 元/千token
  searchFreeDaily: 100,          // 百度搜索每日免费额度
};

// 记录一次用量（累加到当天的记录）
async function recordUsage(env, { search = 0, inTokens = 0, outTokens = 0 }) {
  try {
    if (!env.DB) return;
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC）
    await env.DB.prepare(
      `INSERT INTO usage_daily (day, search_count, summarize_count, input_tokens, output_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         search_count = search_count + excluded.search_count,
         summarize_count = summarize_count + excluded.summarize_count,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         updated_at = excluded.updated_at`
    ).bind(day, search, search > 0 ? 0 : 1, inTokens, outTokens, new Date().toISOString()).run();
  } catch (e) {
    console.error('recordUsage error:', e && e.message);
  }
}

// 管理后台：校验密码后返回用量汇总
async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const pwd = url.searchParams.get('pwd') || '';

  if (pwd !== (env.ADMIN_PASSWORD || '')) {
    return new Response('密码错误', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  let rows = [];
  try {
    if (env.DB) {
      const res = await env.DB.prepare('SELECT * FROM usage_daily ORDER BY day DESC LIMIT 90').all();
      rows = res.results || [];
    }
  } catch (e) {
    console.error('admin query error:', e && e.message);
  }

  // 汇总
  let totalSearch = 0, totalSummarize = 0, totalIn = 0, totalOut = 0;
  rows.forEach(r => {
    totalSearch += (r.search_count || 0);
    totalSummarize += (r.summarize_count || 0);
    totalIn += (r.input_tokens || 0);
    totalOut += (r.output_tokens || 0);
  });

  // 今日（UTC）
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = rows.find(r => r.day === today) || {};
  const todaySearch = todayRow.search_count || 0;
  const todaySummarize = todayRow.summarize_count || 0;

  // 估算费用（搜索按超免费额度部分算；ERNIE 按 token 算）
  const estSearchCost = Math.max(0, totalSearch) * PRICE.searchPerCall;
  const estErnieCost = (totalIn / 1000) * PRICE.ernieInPerK + (totalOut / 1000) * PRICE.ernieOutPerK;
  const estTotalCost = estSearchCost + estErnieCost;

  const data = {
    ok: true,
    today: {
      day: today,
      search: todaySearch,
      summarize: todaySummarize,
      searchFreeLeft: Math.max(0, PRICE.searchFreeDaily - todaySearch),
    },
    total: {
      search: totalSearch,
      summarize: totalSummarize,
      inputTokens: totalIn,
      outputTokens: totalOut,
    },
    estimate: {
      searchCost: round2(estSearchCost),
      ernieCost: round2(estErnieCost),
      totalCost: round2(estTotalCost),
      note: '费用为按官方单价估算，非精确账单；搜索含每日100次免费额度未抵扣。',
    },
    price: PRICE,
    daily: rows.map(r => ({
      day: r.day,
      search: r.search_count || 0,
      summarize: r.summarize_count || 0,
      inTokens: r.input_tokens || 0,
      outTokens: r.output_tokens || 0,
    })),
  };

  return json(data);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

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

// 调百度 ERNIE 对话模型做 AI 整理（OpenAI 兼容接口）
async function ernieChat(apiKey, prompt) {
  const model = 'ernie-5.1'; // 经 /v2/models 实测：账号当前可用、且返回正常的对话模型
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  };
  const headers = { Authorization: 'Bearer ' + apiKey };
  const result = await postJSON('https://qianfan.baidubce.com/v2/chat/completions', headers, body);
  // 兼容两种返回结构：choices[0].message.content 或直接 result
  const content =
    (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) ||
    (result && result.result) ||
    '';
  return String(content).trim();
}

// 调视觉模型识别图片文字（qwen3.5-122b-a10b，实测支持图片输入）
async function visionChat(apiKey, imageBase64) {
  const model = 'qwen3.5-122b-a10b';
  // 兼容带不带 data: 前缀
  const imgUrl = imageBase64.indexOf('data:') === 0 ? imageBase64 : ('data:image/jpeg;base64,' + imageBase64);
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是一张比赛相关的通知/海报截图。请把图里所有的文字内容识别出来，尽量原样、完整地输出文字，不要遗漏标题、时间、主办方、报名方式、赛制等关键信息。只输出识别到的文字，不要解释。' },
        { type: 'image_url', image_url: { url: imgUrl } },
      ],
    }],
  };
  const headers = { Authorization: 'Bearer ' + apiKey };
  const result = await postJSON('https://qianfan.baidubce.com/v2/chat/completions', headers, body);
  const content =
    (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) ||
    (result && result.result) ||
    '';
  return String(content).trim();
}

// 根据任务类型构造提示词
function buildSummarizePrompt(task, name, context) {
  const shared = '下面给你「' + name + '」这个比赛的参考资料。请整理输出，务必只输出合法 JSON，不要任何多余文字、不要 markdown 代码块。';
  if (task === 'intel') {
    return '你是比赛信息整理助手。' + shared + '\n\n参考资料：\n' + context +
      '\n\n请提炼关键信息，并生成后续引导用户闯关所需的内容，直接输出 JSON（字段名固定）：\n' +
      '{"name":"比赛官方名","host":"主办方","system":"赛制流程","target":"参赛对象","url":"报名入口","track":"赛道组别","time":"时间安排",' +
      '"stages":["环节1","环节2","环节3","环节4"],' +
      '"steps":[{"step":"这一关具体要做什么（必须结合这个比赛、这个环节的真实要求，说清楚要交什么、做到什么程度）","need":"这一关要准备的材料/文件/作品（具体到名称，不要泛泛而谈）","note":"这一关最容易踩的坑、评委/评审最看重什么、截止提醒（要有信息量，禁止写空话）"},...],' +
      '"plan":[["第1关待办1","第1关待办2","第1关待办3"],["第2关待办1","..."],["第3关待办1","..."],["第4关待办1","..."]],' +
      '"eval":"一段针对这个比赛的适配建议（60字内）",' +
      '"exp":[{"title":"经验标题","text":"具体建议（50字内）"},...]}。' +
      '关于 steps 的硬性要求（最重要）：steps 的条数必须与 stages 一致（最多4条），且每一关的 step/need/note 必须针对「这一关」的独特任务来写，绝不能四关写成一样的话。' +
      '例如：报名关就写报名要什么材料、什么条件、在哪报名、截止几号；作品/初赛关就写要交什么作品或文档、格式要求、评委看什么；答辩/路演关就写答辩怎么准备、评委常问什么、评分点；决赛/复评关就写决赛的特别要求。' +
      '如果参考资料里没有某一关的具体信息，就基于这个比赛类型的通用规律，写出「实在、能照着做」的步骤，但严禁写「认真准备、按时提交」这类空洞套话。每一条 note 都要给一个具体的避坑点或提醒，让用户真的能少踩一个坑。' +
      '关于准确性：报名时间、参赛对象、报名入口、主办方、赛制这些「关键规则」字段，如果参考资料里同时有官方来源（官网/政府部门/学校/组委会）和非官方来源，优先采用官方来源的信息；若无法判断哪个更权威，就把最稳妥、最常见的说法填进去，但不要写死某个未经证实的精确日期。';
  }
  if (task === 'exp') {
    return '你是比赛经验整理助手。' + shared + '\n\n参考资料：\n' + context +
      '\n\n请提炼出针对这个比赛的「过来人经验与避坑点」，输出 JSON：\n' +
      '{"exp":[{"title":"经验标题（简短）","text":"具体建议（50字内，实在、不套话）","url":"这条经验主要参考的那条来源的链接（从参考资料里的「链接：」原样复制；若这条经验是综合多条而来，填你最有把握对应的一条链接；实在无法对应就填空字符串）"}]}' +
      '给 3~5 条。只依据参考资料里明确写到的内容，不要编造具体数据；信息不足时结合这类比赛的通用规律给实在建议。url 只能从参考资料里已有的链接中选择，绝不能自己编造网址。';
  }
  if (task === 'stage') {
    // stage 任务：针对「某一个赛段」生成这条赛段内部的更细子步骤路线
    return '你是比赛闯关路线规划助手。' + shared + '\n\n参考资料：\n' + context +
      '\n\n用户正在闯「' + name + '」这个比赛的某一个赛段（阶段）。请针对「这个比赛 + 这个赛段」，规划出一条这条赛段内部的具体闯关步骤（子步骤路线），直接输出 JSON（字段名固定）：\n' +
      '{"stage":"这个赛段的名称","steps":[{"title":"这一步做什么（一句话，动词开头，具体到事）","how":"这一步具体怎么做，说人话，可照着做（60字内）","need":"这一步要准备的材料/文件/工具（具体到名称，不要泛泛而谈）","note":"这一步最容易踩的坑、或最该注意的点（一句话，有信息量，禁止空话）"}]}' +
      '硬性要求（最重要）：\n' +
      '1. steps 给 4~6 条，构成一条完整的、有先后顺序的路线（从这赛段的第一步到最后一步）。\n' +
      '2. 每一条都必须针对「这个比赛的这个赛段」的独特要求来写，绝不能写成「认真准备、按时提交」这类空话，也不能把别的赛段的内容搬过来。\n' +
      '3. 这条路线要具体到能照着做：报名类赛段就写报名要什么材料、什么条件、在哪报、截止几号；作品/初赛类就写要交什么作品、格式、评委看什么；答辩/路演类就写答辩怎么准备、评委常问什么；决赛类就写决赛的特别要求。\n' +
      '4. 如果参考资料里没有这个赛段的具体信息，就基于「这个比赛的类型 + 这个赛段的通用规律」写出实在、能照做的步骤，但每一条 note 都要给一个具体的避坑点或提醒。\n' +
      '5. 只输出 JSON，不要任何解释文字。';
  }
  // 默认当作通用整理
  return '你是整理助手。' + shared + '\n\n参考资料：\n' + context + '\n\n请提炼关键信息输出 JSON。';
}
