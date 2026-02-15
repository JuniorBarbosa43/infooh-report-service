function required(name, v) {
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getLcConfig() {
  return {
    baseUrl: (process.env.LC_BASE_URL || 'https://services.leadconnectorhq.com').replace(/\/$/, ''),
    version: process.env.LC_VERSION || '2021-07-28',
    pit: required('LC_PIT', process.env.LC_PIT),
    locationId: required('LC_LOCATION_ID', process.env.LC_LOCATION_ID)
  };
}

async function lcJson(path, { method = 'GET', headers = {}, body } = {}) {
  const { baseUrl, version, pit } = getLcConfig();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${pit}`,
      'Version': version,
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }

  if (!res.ok) {
    const err = new Error(`LC HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let fieldsCache = { at: 0, fields: null };
const FIELDS_TTL_MS = 1000 * 60 * 30;

export async function listCustomFields() {
  const now = Date.now();
  if (fieldsCache.fields && (now - fieldsCache.at) < FIELDS_TTL_MS) return fieldsCache.fields;

  const { locationId } = getLcConfig();

  // Endpoints variam por versão; tentar alguns caminhos conhecidos
  const paths = [
    `/locations/${encodeURIComponent(locationId)}/customFields`,
    `/locations/${encodeURIComponent(locationId)}/custom-fields`,
    `/custom-fields?locationId=${encodeURIComponent(locationId)}`,
    `/customFields?locationId=${encodeURIComponent(locationId)}`
  ];

  let lastErr;
  for (const p of paths) {
    try {
      const data = await lcJson(p);
      const fields =
        data?.customFields ||
        data?.custom_fields ||
        data?.fields ||
        (Array.isArray(data) ? data : null);
      if (Array.isArray(fields)) {
        fieldsCache = { at: now, fields };
        return fields;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Unable to list custom fields');
}

export async function resolveFieldIdsByName(desiredNames) {
  const fields = await listCustomFields();
  const byNorm = new Map();

  for (const f of fields) {
    const name = f?.name || f?.title || f?.label;
    const id = f?.id || f?._id || f?.fieldId;
    if (!name || !id) continue;
    byNorm.set(normKey(name), id);
  }

  const out = {};
  for (const name of desiredNames) {
    const id = byNorm.get(normKey(name));
    if (id) out[name] = id;
  }
  return out;
}

export async function updateContactCustomFields(contactId, fieldIdToValue) {
  const { locationId } = getLcConfig();

  const customFields = Object.entries(fieldIdToValue)
    .filter(([, v]) => v !== undefined)
    .map(([id, value]) => ({ id, value: value == null ? '' : String(value) }));

  // Neste endpoint, o LeadConnector rejeita `locationId` no body.
  // (Erro: "property locationId should not exist").
  const body = { customFields };

  // A API do LeadConnector tem variações de rota por versão/ambiente.
  // Tentamos alguns formatos comuns antes de falhar.
  const cid = encodeURIComponent(String(contactId));
  const lid = encodeURIComponent(String(locationId));
  const paths = [
    // Variante "global"
    `/contacts/${cid}`,
    `/contacts/${cid}/`,

    // Algumas instalações exigem locationId como query
    `/contacts/${cid}?locationId=${lid}`,
    `/contacts/${cid}/?locationId=${lid}`,
    `/contacts/${cid}?location_id=${lid}`,
    `/contacts/${cid}/?location_id=${lid}`,

    // Algumas documentações expõem rota aninhada por location
    `/locations/${lid}/contacts/${cid}`,
    `/locations/${lid}/contacts/${cid}/`,
    `/locations/${lid}/contacts/${cid}?locationId=${lid}`,

    // Em alguns ambientes o update de customFields pode ser um subrecurso
    `/contacts/${cid}/customFields`,
    `/contacts/${cid}/custom-fields`,
  ];

  let lastErr;
  const methods = ['PUT', 'PATCH'];

  for (const method of methods) {
    for (const p of paths) {
      try {
        return await lcJson(p, { method, body });
      } catch (e) {
        lastErr = e;
        // Se não for 404, provavelmente é um erro real (401/422/400) -> não faz sentido tentar outras rotas.
        if (e?.status && e.status !== 404) throw e;
      }
    }
  }

  throw lastErr;
}
