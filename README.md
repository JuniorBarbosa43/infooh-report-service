# infooh-report-service

Serviço HTTP para o MovaTalks buscar métricas de audiência do Infooh (D+7 e D+14) a partir de `campaign_id`.

## Endpoints
- `GET /health`
- `POST /report` body:
```json
{ "campaign_id": 89198, "days": 7 }
```

Resposta (quando ok):
```json
{
  "ok": true,
  "campaign_id": 89198,
  "days": 7,
  "alcance_total_abs": "...",
  "alcance_total_pct": "...",
  "impactos_visualizacoes_total": "...",
  "frequencia": "...",
  "grp": "...",
  "link_do_relatorio": "..."
}
```

## Env vars
- `INFOOH_BASE_URL` (ex: https://sistema.infooh.com.br)
- `INFOOH_USERNAME`
- `INFOOH_PASSWORD`
- `PORT` (default 3000)
- `PUBLIC_REPORT_BASE_URL` (opcional)

## Rodar local
```bash
npm install
npm run dev
```

## Deploy (Render)
1. Crie um **New Web Service** e aponte para este repositório.
2. Runtime: Docker (usa o Dockerfile) ou Node.
3. Env vars: `INFOOH_BASE_URL`, `INFOOH_USERNAME`, `INFOOH_PASSWORD`.
4. URL final: `https://SEU-SERVICO.onrender.com/report`

Se o extrator não achar os campos, o serviço retorna HTTP 422 com debug. Nesse caso, pegue o JSON de `GET /api/v1/campaigns/{id}/` e ajustamos o extrator.
