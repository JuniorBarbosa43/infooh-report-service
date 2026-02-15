import express from 'express';
import cors from 'cors';
import { getCampaignDetails, extractMetrics, buildPublicReportLink } from './infooh.js';
import { resolveFieldIdsByName, updateContactCustomFields, findContactIdByPhone } from './leadconnector.js';

const app = express();
app.use(cors());
// Alguns webhooks enviam application/x-www-form-urlencoded por padrão
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'infooh-report-service' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'infooh-report-service' });
});

app.post('/report', async (req, res) => {
  try {
    // DEBUG: log do payload recebido (chaves e content-type) para diagnosticar webhooks do MovaTalks
    console.log('[report] content-type:', req.headers['content-type']);
    try {
      const b = req.body || {};
      console.log('[report] body keys:', Object.keys(b));
      if (b && typeof b === 'object') {
        console.log('[report] body sample:', JSON.stringify(b).slice(0, 2000));
      }
    } catch {}
    const body = req.body || {};
    const q = req.query || {};

    const campaign_id =
      body.campaign_id ||
      body.campaignId ||
      // fallback: alguns webhooks enviam o ID da campanha como campo personalizado do contato
      body.infooh_campaign_id ||
      body.infoohCampaignId ||
      body?.customData?.campaign_id ||
      body?.customData?.campaignId ||
      body?.customData?.infooh_campaign_id ||
      body?.customData?.infoohCampaignId ||
      body?.custom_data?.campaign_id ||
      body?.data?.campaign_id ||
      q.campaign_id ||
      q.campaignId;

    const contact_id =
      body.contact_id ||
      body.contactId ||
      body?.customData?.contact_id ||
      body?.customData?.contactId ||
      body?.custom_data?.contact_id ||
      body?.data?.contact_id ||
      q.contact_id ||
      q.contactId;

    const days =
      body.days ||
      body?.customData?.days ||
      body?.custom_data?.days ||
      body?.data?.days ||
      q.days;

    const phone =
      body.phone ||
      body.phone_number ||
      body?.contact?.phone ||
      body?.contact?.phoneNumber ||
      body?.customData?.contact?.phone ||
      body?.customData?.phone ||
      body?.data?.phone ||
      null;

    const d = Number(days);
    if (!campaign_id) return res.status(400).json({ ok: false, error: 'campaign_id_required', receivedKeys: Object.keys(body), receivedQueryKeys: Object.keys(q) });
    // Suportar réguas semanais (múltiplos de 7 até 56) e mensais (múltiplos de 30 até 360).
    const allowedWeekly = [7, 14, 21, 28, 35, 42, 49, 56];
    const allowedMonthly = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
    const allowedDays = [...allowedWeekly, ...allowedMonthly];
    if (!allowedDays.includes(d)) return res.status(400).json({ ok: false, error: 'days_not_supported', allowedDays });

    const details = await getCampaignDetails(campaign_id);
    const metrics = extractMetrics(details, d);

    // link opcional (se você configurar PUBLIC_REPORT_BASE_URL)
    const link = buildPublicReportLink({ campaignId: campaign_id, days: d });

    if (!metrics.ok) {
      return res.status(422).json({
        ok: false,
        ...metrics,
        campaign_id,
        contact_id: contact_id || null,
        days: d,
        link_do_relatorio: link
      });
    }

    const toNum = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const fmtInt = (v) => {
      const n = toNum(v);
      if (n == null) return '';
      return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(n);
    };

    const fmtDec = (v, digits = 2) => {
      const n = toNum(v);
      if (n == null) return '';
      return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    };

    const fmtPct = (v) => {
      const n = toNum(v);
      if (n == null) return '';
      return `${fmtDec(n, 2)}%`;
    };

    const fmtBRL = (v) => {
      const n = toNum(v);
      if (n == null) return '';
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    };

    const payload = {
      ok: true,
      campaign_id,
      contact_id: contact_id || null,
      days: d,
      dias_extraidos: String(d),
      // valores formatados (pt-BR) para gravar limpo nos campos
      alcance_total_abs: fmtInt(metrics.alcance_total_abs),
      alcance_total_pct: fmtPct(metrics.alcance_total_pct),
      impactos_visualizacoes_total: fmtInt(metrics.impactos_visualizacoes_total),
      frequencia: fmtDec(metrics.frequencia, 2),
      grp: fmtInt(metrics.grp),
      cpm_total: fmtBRL(metrics.cpm_total),
      cpm_medio: fmtBRL(metrics.cpm_medio),
      link_do_relatorio: null
    };

    // Se contact_id + credenciais LC_* existirem, atualizar o contato automaticamente.
    // O MovaTalks não consegue mapear a response do webhook para campos, então fazemos aqui.
    let contact_updated = false;
    let contact_update_error = null;

    if (contact_id && process.env.LC_PIT && process.env.LC_LOCATION_ID) {
      try {
        const desiredFieldNames = [
          'Nome Da Campanha',
          'Dias Extraidos',
          'Alcance Total ABS',
          'Alcance %',
          'Impactos / Visualizações Total',
          'Frequência',
          'GRP',
          'CPM Total',
          'CPM Médio'
        ];

        const nameToId = await resolveFieldIdsByName(desiredFieldNames);

        const fieldIdToValue = {};
        if (nameToId['Nome Da Campanha']) fieldIdToValue[nameToId['Nome Da Campanha']] = String(details?.name || '');
        if (nameToId['Dias Extraidos']) fieldIdToValue[nameToId['Dias Extraidos']] = payload.dias_extraidos;
        if (nameToId['Alcance Total ABS']) fieldIdToValue[nameToId['Alcance Total ABS']] = payload.alcance_total_abs;
        if (nameToId['Alcance %']) fieldIdToValue[nameToId['Alcance %']] = payload.alcance_total_pct;
        if (nameToId['Impactos / Visualizações Total']) fieldIdToValue[nameToId['Impactos / Visualizações Total']] = payload.impactos_visualizacoes_total;
        if (nameToId['Frequência']) fieldIdToValue[nameToId['Frequência']] = payload.frequencia;
        if (nameToId['GRP']) fieldIdToValue[nameToId['GRP']] = payload.grp;
        if (nameToId['CPM Total']) fieldIdToValue[nameToId['CPM Total']] = payload.cpm_total;
        if (nameToId['CPM Médio']) fieldIdToValue[nameToId['CPM Médio']] = payload.cpm_medio;

        try {
          await updateContactCustomFields(contact_id, fieldIdToValue);
          contact_updated = true;
        } catch (e) {
          // Fallback: às vezes o ID que chega do CRM não é o mesmo ID aceito pela API.
          // Tenta resolver pelo telefone do contato e repetir.
          if (e?.status === 404 && phone) {
            const resolvedId = await findContactIdByPhone(phone);
            if (resolvedId && resolvedId !== contact_id) {
              await updateContactCustomFields(resolvedId, fieldIdToValue);
              contact_updated = true;
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      } catch (e) {
        contact_update_error = {
          message: e.message,
          status: e.status,
          data: e.data
        };
      }
    }

    return res.json({
      ...payload,
      contact_updated,
      contact_update_error
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      ok: false,
      error: e.message || 'unknown_error',
      status,
      url: e.url,
      method: e.method,
      data: e.data && status !== 500 ? e.data : undefined
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`infooh-report-service listening on :${port}`);
});
