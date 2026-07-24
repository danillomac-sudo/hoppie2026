# SimBrief Hoppie Dispatcher

Site para buscar o OFP mais recente do SimBrief e agendar uma mensagem via Hoppie ACARS alguns minutos depois.

Agora o projeto tambem inclui uma primeira versao do modulo de aprovacao IFR:

- criacao manual de plano de voo
- importacao a partir do SimBrief
- validacao por etapas: callsign, aeronave, equipamentos, aeroportos, alternado, rota, flight level e ETD
- base local com milhares de aeroportos ICAO gerada a partir do OurAirports
- rejeicao com motivo especifico quando uma etapa falha
- reserva automatica de squawk, ignorando codigos proibidos como 7500, 7600 e 7700
- geracao de Flight Clearance IFR
- API para consultar planos e clearances

## Rodar localmente

```powershell
node server.js
```

Depois abra:

```text
http://localhost:3000
```

Se quiser outra porta:

```powershell
$env:PORT=4000
node server.js
```

## Hospedar no Render

Recomendado para este projeto. O envio com delay precisa de um processo Node que continue vivo depois que voce fecha o navegador.

1. Suba esta pasta para um repositorio no GitHub.
2. No Render, crie um novo Web Service usando esse repositorio.
3. Use:
   - Build command: `npm install --omit=dev`
   - Start command: `npm start`
4. Configure variaveis de ambiente:
   - `SITE_USER`: usuario da tela, por exemplo `admin`
   - `SITE_PASSWORD`: senha forte para proteger o site
   - `HOPPIE_ENDPOINT`: `http://www.hoppie.nl/acars/system/connect.html`

O arquivo `render.yaml` tambem permite criar o servico como Blueprint.

## Sobre Vercel

Vercel usa funcoes serverless em `/var/task`, que nao e um sistema de arquivos persistente. O app agora usa um diretorio temporario quando detecta Vercel, evitando erro como `ENOENT: no such file or directory, mkdir '/var/task/.data'`.

Mesmo assim, Vercel nao e recomendado para o envio atrasado via `setTimeout`, porque a funcao pode encerrar antes do horario de envio. Para mandar mensagem via Hoppie alguns minutos depois com confiabilidade, use Render, Railway ou Fly.io como servico Node sempre ligado.

## Dados necessarios na tela

- SimBrief username ou Pilot ID. O Pilot ID padrao ja esta configurado como `191746`.
- Hoppie logon code do dispatcher. Ele fica configurado no servidor via `HOPPIE_LOGON`, sem aparecer na tela.
- Callsign de origem do dispatcher via `DEFAULT_HOPPIE_FROM`, por exemplo `DANOPS`.
- Callsign de destino e puxado automaticamente do SimBrief, usando o callsign do OFP.

## Observacoes importantes

Os agendamentos ficam em memoria e tambem sao gravados em `.data/jobs.json`, mas o logon do Hoppie nao e salvo no arquivo. Se o servidor reiniciar antes do envio, o job antigo aparece como erro porque nao e seguro gravar esse logon em disco.

Os planos IFR ficam em `.data/flight-plans.json` quando o servidor permite escrita em disco. Em Vercel, esse arquivo fica no diretorio temporario da funcao e pode ser perdido quando a instancia troca. Para uso serio, o proximo passo e trocar esse armazenamento por Postgres/Redis e um worker que verifica a fila a cada minuto.

A base local de aeroportos fica em `lib/ifp/airport-database.js` e foi gerada com dados publicos do OurAirports. Para atualizar:

```powershell
mkdir .tmp-airports
curl.exe -L https://davidmegginson.github.io/ourairports-data/airports.csv -o .tmp-airports/airports.csv
curl.exe -L https://davidmegginson.github.io/ourairports-data/runways.csv -o .tmp-airports/runways.csv
npm run build:airports -- .tmp-airports lib/ifp/airport-database.js
```

Quando um ICAO valido ainda nao existir na base local, o plano passa com aviso de revisao manual em vez de ser rejeitado automaticamente.

## API IFR

```text
GET  /api/flight-plans
POST /api/flight-plans
POST /api/flight-plans/import-simbrief
GET  /api/flight-plans/:id
GET  /api/flight-plans/:id/clearance
POST /api/flight-plans/:id/status
```

Campos aceitos no `POST /api/flight-plans`:

```json
{
  "callsign": "GLO7215",
  "aircraftType": "A320",
  "origin": "SAEZ",
  "destination": "SBCF",
  "alternate": "SBGR",
  "route": "DCT PTA UZ45 PULPO DCT",
  "flightLevel": "FL350",
  "etdUtc": "2026-07-24 13:15",
  "equipment": "SDE2E3FGHIRWXY/LB1",
  "remarks": "PBN/A1B1C1D1",
  "sid": "KUKE1L"
}
```

Estados suportados:

```text
Draft, Pending Validation, Approved, Active, Completed, Archived, Rejected
```

## Placeholders do template

```text
{callsign}
{flightNumber}
{origin}
{destination}
{alternate}
{aircraft}
{registration}
{cruiseAltitude}
{sid}
{sidIdent}
{sidTrans}
{sid_ident}
{sid_trans}
{ete}
{route}
{routeShort}
{distance}
{blockFuel}
{costIndex}
{zfw}
{payload}
{release}
{generatedAt}
{schedOut}
```

Mantenha a mensagem curta. ACARS/Hoppie nao e feito para trafego grande.
