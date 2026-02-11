import crypto from 'node:crypto';

const TTL_MS = 1000 * 60 * 50; // 50 min
let cache = { token: null, at: 0 };

function required(name, v) {
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function getConfig() {
  return {
    baseUrl: required('INFOOH_BASE_URL', process.env.INFOOH_BASE_URL).replace(/\/$/, ''),
    username: required('INFOOH_USERNAME', process.env.INFOOH_USERNAME),
    password: required('INFOOH_PASSWORD', process.env.INFOOH_PASSWORD)
  };
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text };
  }

  // anexar meta útil (sem jogar o texto completo no erro por padrão)
  if (data && typeof data === 'object') {
    data._meta = {
      status: res.status,
      contentType
    };
  }

  // Se a resposta não for JSON, tratar como erro (mesmo que HTTP 200)
  const isJson = contentType.toLowerCase().includes('application/json') || contentType.toLowerCase().includes('+json');
  if (!isJson) {
    const err = new Error('Non-JSON response from InfoOH');
    err.status = res.status;
    err.url = url;
    err.method = method;
    err.data = {
      contentType,
      snippet: (text || '').slice(0, 800)
    };
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    err.url = url;
    err.method = method;
    throw err;
  }

  return data;
}

export async function getToken() {
  const { baseUrl, username, password } = getConfig();
  const now = Date.now();

  // Permitir token estático via ENV para ambientes onde o login por usuário/senha não é suportado
  if (process.env.INFOOH_TOKEN) {
    return process.env.INFOOH_TOKEN;
  }

  if (cache.token && (now - cache.at) < TTL_MS) return cache.token;

  // Alguns ambientes InfoOH podem ter endpoints de autenticação diferentes.
  // Tentar uma lista de caminhos comuns.
  const candidates = [
    { path: '/api/token/', method: 'POST' },
    { path: '/api/token', method: 'POST' },
    { path: '/api/api-token-auth/', method: 'POST' },
    { path: '/api/api-token-auth', method: 'POST' },
    { path: '/api/auth/token/', method: 'POST' },
    { path: '/api/auth/token', method: 'POST' },
    { path: '/api/v1/token/', method: 'POST' },
    { path: '/api/v1/token', method: 'POST' },
    { path: '/api/login/', method: 'POST' },
    { path: '/api/login', method: 'POST' }
  ];

  let lastErr;
  for (const c of candidates) {
    const url = `${baseUrl}${c.path}`;
    try {
      const data = await httpJson(url, {
        method: c.method,
        headers: { 'Content-Type': 'application/json' },
        body: { username, password }
      });

      // suportar chaves comuns
      const token = data?.token || data?.key || data?.access || data?.access_token;
      if (!token) {
        const err = new Error('Token not found in login response');
        err.data = data;
        throw err;
      }

      cache = { token, at: now };
      return token;
    } catch (e) {
      lastErr = e;
      // continuar tentando os próximos
    }
  }

  throw lastErr || new Error('Unable to authenticate to InfoOH');
}

export async function getCampaignDetails(campaignId) {
  const { baseUrl } = getConfig();
  const url = `${baseUrl}/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/`;

  // Se você fornecer o header completo (copiado do DevTools), use ele diretamente.
  // Ex.: INFOOH_AUTH_HEADER="token xxxxx" ou "Bearer xxxxx" etc.
  if (process.env.INFOOH_AUTH_HEADER) {
    return httpJson(url, {
      headers: { Authorization: process.env.INFOOH_AUTH_HEADER }
    });
  }

  const token = await getToken();

  // A InfoOH parece usar diferentes esquemas de Authorization dependendo do ambiente.
  // Tentar os mais comuns até obter JSON.
  const schemes = ['token', 'Token', 'Bearer', 'JWT'];
  let lastErr;

  for (const s of schemes) {
    try {
      return await httpJson(url, {
        headers: { Authorization: `${s} ${token}` }
      });
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

function walk(obj, fn, path = []) {
  if (obj && typeof obj === 'object') {
    fn(obj, path);
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, fn, path.concat(i)));
    } else {
      Object.entries(obj).forEach(([k, v]) => walk(v, fn, path.concat(k)));
    }
  }
}

function normKey(s) {
  return String(s)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tenta achar uma tabela/objeto de comparativo (7 dias / 14 dias) em qualquer estrutura.
 * Retorna o melhor palpite ou null.
 */
function findComparative(candidate) {
  const hits = [];
  walk(candidate, (node, path) => {
    // procurar objetos com chaves que lembram 7/14
    const keys = Object.keys(node || {});
    const nk = keys.map(normKey);
    const has7 = nk.some(k => k.includes('7 dias') || k.includes('1 semana') || k === '7');
    const has14 = nk.some(k => k.includes('14 dias') || k.includes('2 semanas') || k === '14');
    if (has7 && has14) hits.push({ path, node, keys });
  });
  // preferir estruturas mais "rasas" (menor path)
  hits.sort((a, b) => a.path.length - b.path.length);
  return hits[0] || null;
}

function pickMetricRow(tableLike, metricName) {
  // tableLike pode ser array de rows, ou objeto com rows, etc.
  const n = metricName;
  const rows = Array.isArray(tableLike)
    ? tableLike
    : (Array.isArray(tableLike?.rows) ? tableLike.rows : null);
  if (!rows) return null;
  const target = normKey(n);

  for (const row of rows) {
    const label = row?.label || row?.name || row?.metric || row?.title;
    if (!label) continue;
    const nl = normKey(label);
    if (nl.includes(target)) return row;
  }
  return null;
}

function extractFromComparativeNode(compNode, days) {
  // Melhor esforço: suportar formatos comuns
  const keyCandidates = days === 7
    ? ['7 dias', '1 semana', '7']
    : ['14 dias', '2 semanas', '14'];

  const result = {};

  // Caso seja uma tabela em formato { metrics: [...], columns: {...} }
  const rows = compNode?.rows || compNode?.metrics || compNode?.data;
  if (Array.isArray(rows)) {
    // procurar linhas por métricas
    const reachAbs = pickMetricRow({ rows }, 'alcance total') || pickMetricRow({ rows }, 'alcance total abs');
    const reachPct = pickMetricRow({ rows }, 'alcance total %') || pickMetricRow({ rows }, 'alcance total');
    const freq = pickMetricRow({ rows }, 'frequencia');
    const grp = pickMetricRow({ rows }, 'g r p') || pickMetricRow({ rows }, 'grp');
    const impacts = pickMetricRow({ rows }, 'impactos') || pickMetricRow({ rows }, 'visualizacoes');

    const getCell = (row) => {
      if (!row) return null;
      // tentar várias estruturas
      if (row.values && typeof row.values === 'object') {
        // valores por chave
        for (const kc of keyCandidates) {
          const foundKey = Object.keys(row.values).find(k => normKey(k).includes(kc));
          if (foundKey) return row.values[foundKey];
        }
      }
      if (row[days]) return row[days];
      // array alinhado com columns
      if (Array.isArray(row.cells)) {
        const colKeys = Array.isArray(compNode.columns) ? compNode.columns : null;
        if (colKeys) {
          const idx = colKeys.findIndex(c => keyCandidates.some(kc => normKey(c).includes(kc)));
          if (idx >= 0) return row.cells[idx];
        }
      }
      return null;
    };

    result.alcance_total_abs = getCell(reachAbs);
    result.alcance_total_pct = getCell(reachPct);
    result.impactos_visualizacoes_total = getCell(impacts);
    result.frequencia = getCell(freq);
    result.grp = getCell(grp);
  }

  // Caso seja um objeto com chaves 7/14 já prontas
  for (const kc of keyCandidates) {
    const match = Object.keys(compNode || {}).find(k => normKey(k).includes(kc));
    if (match && typeof compNode[match] === 'object') {
      // tentar mapear campos já nomeados
      const n = compNode[match];
      result.alcance_total_abs ??= n.alcance_total_abs || n.reach_abs || n.reach || n.alcance_abs;
      result.alcance_total_pct ??= n.alcance_total_pct || n.reach_pct || n.percent || n.alcance_pct;
      result.impactos_visualizacoes_total ??= n.impactos || n.impactos_total || n.impacts || n.visualizacoes_total;
      result.frequencia ??= n.frequencia || n.frequency;
      result.grp ??= n.grp || n.grp_total;
      break;
    }
  }

  // limpar undefined
  Object.keys(result).forEach(k => (result[k] == null) && delete result[k]);
  return Object.keys(result).length ? result : null;
}

export function extractMetrics(campaignDetails, days) {
  // Caminho conhecido do endpoint v1/campaigns: audience_and_scope.campaign.
  // Nele, os dias vêm como chaves "007" e "014" (strings com zero à esquerda).
  const campaign = campaignDetails?.audience_and_scope?.campaign;
  if (campaign && typeof campaign === 'object') {
    const k = String(days).padStart(3, '0');
    const alcanceAbs = campaign?.absolute_reach?.[k];
    const alcancePct = campaign?.percentage_reach?.[k];
    const freq = campaign?.frequency_visualization?.[k];
    const grp = campaign?.total_grp?.[k];

    if (alcanceAbs != null || alcancePct != null || freq != null || grp != null) {
      // CPM (custo por mil) vem em audience_and_scope.cost_per_thousand.{total,avarage}
      const k2 = String(days).padStart(2, '0');
      const cpmTotal = campaignDetails?.audience_and_scope?.cost_per_thousand?.total?.[k2] ??
        campaignDetails?.audience_and_scope?.cost_per_thousand?.total?.[String(days)] ??
        null;
      const cpmMedio = campaignDetails?.audience_and_scope?.cost_per_thousand?.avarage?.[k2] ??
        campaignDetails?.audience_and_scope?.cost_per_thousand?.avarage?.[String(days)] ??
        null;

      return {
        ok: true,
        alcance_total_abs: alcanceAbs ?? null,
        alcance_total_pct: alcancePct ?? null,
        // A API não traz um campo explícito de impactos multi-período; usar alcance absoluto como proxy.
        impactos_visualizacoes_total: alcanceAbs ?? null,
        frequencia: freq ?? null,
        grp: grp ?? null,
        cpm_total: cpmTotal,
        cpm_medio: cpmMedio,
        debug: {
          source: 'audience_and_scope.campaign',
          key: k,
          key2: k2
        }
      };
    }
  }

  const compHit = findComparative(campaignDetails);
  if (!compHit) {
    return {
      ok: false,
      reason: 'comparative_not_found',
      hint: 'Não achei uma estrutura com 7 dias e 14 dias no JSON. Envie um exemplo do JSON do endpoint de campanha para ajustar o extrator.',
      debug: {
        topLevelKeys: Object.keys(campaignDetails || {}).slice(0, 50)
      }
    };
  }

  const extracted = extractFromComparativeNode(compHit.node, days);
  if (!extracted) {
    return {
      ok: false,
      reason: 'comparative_found_but_metrics_not_extracted',
      hint: 'Achei o bloco de comparativo, mas não consegui mapear as métricas. Preciso do JSON real para ajustar as chaves/estrutura.',
      debug: {
        comparativePath: compHit.path,
        comparativeKeys: compHit.keys
      }
    };
  }

  return {
    ok: true,
    ...extracted,
    debug: {
      comparativePath: compHit.path
    }
  };
}

export function buildPublicReportLink({ campaignId, days }) {
  // placeholder: se você no futuro gerar PDF/HTML, coloque aqui.
  // Por enquanto, retorna vazio e deixe o link ser preenchido pelo MovaTalks manualmente ou por outro serviço.
  const base = process.env.PUBLIC_REPORT_BASE_URL;
  if (!base) return null;
  const url = new URL(base.replace(/\/$/, '') + '/r');
  url.searchParams.set('campaign_id', String(campaignId));
  url.searchParams.set('days', String(days));
  url.searchParams.set('sig', crypto.createHash('sha256').update(String(campaignId) + ':' + String(days)).digest('hex').slice(0, 12));
  return url.toString();
}
