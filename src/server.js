import express from 'express';
import cors from 'cors';
import { getCampaignDetails, extractMetrics, buildPublicReportLink } from './infooh.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'infooh-report-service' });
});

app.post('/report', async (req, res) => {
  try {
    const { campaign_id, days } = req.body || {};
    const d = Number(days);
    if (!campaign_id) return res.status(400).json({ ok: false, error: 'campaign_id_required' });
    if (![7, 14].includes(d)) return res.status(400).json({ ok: false, error: 'days_must_be_7_or_14' });

    const details = await getCampaignDetails(campaign_id);
    const metrics = extractMetrics(details, d);

    // link opcional (se você configurar PUBLIC_REPORT_BASE_URL)
    const link = buildPublicReportLink({ campaignId: campaign_id, days: d });

    if (!metrics.ok) {
      return res.status(422).json({
        ok: false,
        ...metrics,
        campaign_id,
        days: d,
        link_do_relatorio: link
      });
    }

    return res.json({
      ok: true,
      campaign_id,
      days: d,
      alcance_total_abs: String(metrics.alcance_total_abs ?? ''),
      alcance_total_pct: String(metrics.alcance_total_pct ?? ''),
      impactos_visualizacoes_total: String(metrics.impactos_visualizacoes_total ?? ''),
      frequencia: String(metrics.frequencia ?? ''),
      grp: String(metrics.grp ?? ''),
      link_do_relatorio: link
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      ok: false,
      error: e.message || 'unknown_error',
      status,
      data: e.data && status !== 500 ? e.data : undefined
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`infooh-report-service listening on :${port}`);
});
