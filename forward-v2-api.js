/* =============================================================================
 * Forward v2 API — tab "Forward v2 API" (phase 11)
 * API spec ของ .NET service ที่พอร์ต logic คำนวณ Tenor จากหน้าจอ Forward v2
 * (source: net/ForwardV2TenorCalculator.cs + net/Program.cs)
 *
 * ไฟล์นี้แยกออกจาก exim_forward_contract (1).html (โหลดผ่าน <script src>)
 * จุดเชื่อม: render() ใน HTML หลักเรียก hFwd2Api()/bindFwd2Api() เมื่อ P.phase===11
 *
 * พึ่งพา global จาก HTML หลัก: ic(), render()
 * ฟีเจอร์ "ลองเรียก (live)" ยิงไปที่ base URL (ค่าเริ่มต้น http://localhost:5080)
 *   — ทำงานได้เพราะฝั่ง API เปิด CORS (AllowAnyOrigin) ไว้แล้ว
 * ============================================================================= */

var FWD2API_BASE = 'http://localhost:5080';

/* === API spec (curated) — อ้างอิงจาก /swagger/v1/swagger.json ของ service === */
var FWD2API_SPEC = {
  title: 'Forward v2 — Tenor Calculator API',
  version: 'v1',
  desc: 'API คำนวณ Tenor รายเดือนของสัญญา FX Forward (พอร์ตจากหน้าจอ Forward v2) · .NET 10 Minimal API',
  swagger: '/swagger',
  ccys: ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'SGD'],
  endpoints: [
    {
      method: 'GET', path: '/api/forward-v2/spot-info',
      summary: 'Spot value date (T+2) + EOM',
      desc: 'คืน Spot value date (T+2 วันทำการไทย) และ flag ว่าเป็นวันทำการสุดท้ายของเดือน (EOM)',
      params: [
        { n: 'tradeDate', t: 'date', req: true, d: 'วันทำรายการจอง (yyyy-MM-dd)' }
      ],
      query: 'tradeDate=2026-01-28',
      resp: '{\n  "tradeDate": "2026-01-28",\n  "spotValueDate": "2026-01-30",\n  "isEndOfMonth": true\n}'
    },
    {
      method: 'GET', path: '/api/forward-v2/max-end',
      summary: 'วันสิ้นสุดสัญญาสูงสุด',
      desc: 'วันสิ้นสุดสัญญาสูงสุด = Spot value date + 6 เดือน',
      params: [
        { n: 'tradeDate', t: 'date', req: true, d: 'วันทำรายการจอง (yyyy-MM-dd)' }
      ],
      query: 'tradeDate=2026-01-28',
      resp: '{\n  "tradeDate": "2026-01-28",\n  "maxEndDate": "2026-07-30"\n}'
    },
    {
      method: 'GET', path: '/api/forward-v2/tenors',
      summary: 'ตาราง Tenor 1–6',
      desc: 'วันครบกำหนดของ tenor 1..6 เดือน + ช่วงวันสิ้นสุดที่เลือกได้ (ใช้สร้าง calendar UI)',
      params: [
        { n: 'tradeDate', t: 'date', req: true, d: 'วันทำรายการจอง' },
        { n: 'ccy', t: 'string', req: true, d: 'สกุลเงิน เช่น USD' }
      ],
      query: 'tradeDate=2026-01-28&ccy=USD',
      resp: '{\n  "tradeDate": "2026-01-28",\n  "ccy": "USD",\n  "spotValueDate": "2026-01-30",\n  "isEndOfMonth": true,\n  "maxEndDate": "2026-07-30",\n  "tenors": [\n    { "tenorMonths": 1, "maturity": "2026-02-27",\n      "selectableFrom": "2026-01-31", "selectableTo": "2026-02-27" },\n    { "tenorMonths": 2, "maturity": "2026-03-31",\n      "selectableFrom": "2026-02-28", "selectableTo": "2026-03-31" }\n    /* ... M3..M6 ... */\n  ]\n}'
    },
    {
      method: 'GET', path: '/api/forward-v2/validate-end',
      summary: 'ตรวจสอบวันสิ้นสุดสัญญา',
      desc: 'ตรวจว่าวันสิ้นสุดที่เลือกอยู่ในช่วง tenor + เป็นวันทำการ + ไม่เกินวันสิ้นสุดวงเงิน',
      params: [
        { n: 'tradeDate', t: 'date', req: true, d: 'วันทำรายการจอง' },
        { n: 'tenor', t: 'int', req: true, d: 'จำนวนเดือนของ tenor (1–6)' },
        { n: 'ccy', t: 'string', req: true, d: 'สกุลเงิน' },
        { n: 'endDate', t: 'date', req: true, d: 'วันสิ้นสุดสัญญาที่เลือก' },
        { n: 'creditLineEnd', t: 'date', req: false, d: 'วันสิ้นสุดวงเงิน (ไม่บังคับ)' }
      ],
      query: 'tradeDate=2026-01-28&tenor=3&ccy=USD&endDate=2026-04-20',
      resp: '{\n  "tradeDate": "2026-01-28",\n  "tenor": 3,\n  "ccy": "USD",\n  "endDate": "2026-04-20",\n  "creditLineEnd": null,\n  "isValid": true,\n  "selectableFrom": "2026-04-01",\n  "selectableTo": "2026-04-30"\n}'
    },
    {
      method: 'GET', path: '/api/forward-v2/schedule',
      summary: 'ตาราง Schedule รายเดือน',
      desc: 'ตาราง tenor รายเดือน + เฉลี่ย swap point เมื่อจองไม่เต็มงวด · includeDaily=true แนบ rate รายวัน (prorate)',
      params: [
        { n: 'tradeDate', t: 'date', req: true, d: 'วันทำรายการจอง' },
        { n: 'endDate', t: 'date', req: true, d: 'วันสิ้นสุดสัญญาที่เลือก' },
        { n: 'ccy', t: 'string', req: true, d: 'สกุลเงิน' },
        { n: 'side', t: 'string', req: false, d: 'buy | sell (ค่าเริ่มต้น sell)' },
        { n: 'includeDaily', t: 'bool', req: false, d: 'true = แนบ rate รายวันของแต่ละงวด' }
      ],
      query: 'tradeDate=2026-01-28&endDate=2026-05-15&ccy=USD&side=sell',
      resp: '{\n  "tradeDate": "2026-01-28",\n  "endDate": "2026-05-15",\n  "ccy": "USD",\n  "side": "Sell",\n  "spotValueDate": "2026-01-30",\n  "isEndOfMonth": true,\n  "spotRate": 36.42,\n  "contractMonths": 4,\n  "periods": [\n    { "month": 1, "start": "2026-01-31", "end": "2026-02-27",\n      "days": 28, "fullPeriodDays": 28, "swapPoint": 0.08,\n      "forwardRate": 36.50, "isPartial": false },\n    /* ... M2, M3 ... */\n    { "month": 4, "start": "2026-05-01", "end": "2026-05-15",\n      "days": 15, "fullPeriodDays": 29, "swapPoint": 0.2714,\n      "forwardRate": 36.6914, "isPartial": true }\n  ]\n}'
    }
  ]
};

/* === helpers === */
function fwd2ApiEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fwd2ApiUrl(i) {
  var ep = FWD2API_SPEC.endpoints[i];
  var base = (document.getElementById('fwd2api-base') || {}).value || FWD2API_BASE;
  var q = (document.getElementById('fwd2api-q-' + i) || {}).value || ep.query;
  return base.replace(/\/+$/, '') + ep.path + (q ? '?' + q : '');
}

/* === render === */
function hFwd2Api() {
  var S = FWD2API_SPEC;

  var codeSt = 'background:#0f172a;color:#cbd5e1;border-radius:8px;padding:12px 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;overflow-x:auto;white-space:pre;margin:0';

  /* header */
  var header = '<div style="font-size:20px;font-weight:700;color:var(--blue);margin-bottom:2px">' + S.title + ' <span style="font-size:12px;font-weight:600;color:var(--t3)">' + S.version + '</span></div>'
    + '<div style="font-size:13px;color:var(--t3);margin-bottom:14px">' + S.desc + '</div>';

  /* base url + swagger link */
  var bar = '<div class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
    + '<span style="font-size:12px;font-weight:600;color:var(--t2)">Base URL</span>'
    + '<input type="text" id="fwd2api-base" value="' + FWD2API_BASE + '" style="flex:1;min-width:220px;font-family:ui-monospace,monospace;font-size:12px">'
    + '<a class="btn btn-s" style="font-size:11px;padding:6px 12px;text-decoration:none" href="' + FWD2API_BASE + S.swagger + '" target="_blank">' + ic('globe') + ' เปิด Swagger UI</a>'
    + '</div>'
    + '<div style="font-size:11px;color:var(--t3);margin-top:8px">' + ic('info') + ' ปุ่ม “ลองเรียก (live)” ยิงตรงไปที่ Base URL (service เปิด CORS ไว้แล้ว) · ต้องรัน <code>dotnet run</code> ในโฟลเดอร์ <code>net</code> ก่อน</div>'
    + '</div>';

  /* market data (mock) */
  var mkt = '<div class="card"><div class="card-title">' + ic('bld') + ' ข้อมูลตลาด (mock ในตัว service)</div>'
    + '<div style="font-size:13px;color:var(--t2)">สกุลเงินที่ seed ไว้: '
    + S.ccys.map(function (c) { return '<span class="tag tag-inf" style="margin-right:4px">' + c + '</span>'; }).join('')
    + '</div>'
    + '<div class="alert info" style="margin-top:10px">' + ic('info') + '<div>spot rate / swap point ใช้<strong>ค่าเดียวกับ sim (Forward v2)</strong> — spot mid + swap point ติดลบ (ฝั่งขายจะ abs เป็นบวก) · เป็นค่า mock ใน <code>Program.cs</code> · ตอนต่อระบบจริงให้ทำ class สืบทอด <code>ForwardV2MarketData</code> ดึงจาก DB แล้วสลับใน DI</div></div>'
    + '</div>';

  /* endpoints */
  var eps = S.endpoints.map(function (ep, i) {
    var mbadge = '<span style="background:var(--ok-bg);color:var(--ok);font-weight:800;font-size:11px;letter-spacing:.5px;padding:3px 8px;border-radius:6px">' + ep.method + '</span>';
    var params = ep.params.map(function (p) {
      return '<tr>'
        + '<td style="font-family:ui-monospace,monospace;font-size:12px;color:var(--t1)">' + p.n + (p.req ? ' <span style="color:var(--er)">*</span>' : '') + '</td>'
        + '<td><span class="tag tag-inf">' + p.t + '</span></td>'
        + '<td style="font-size:12px;color:var(--t3)">' + (p.req ? 'required' : 'optional') + '</td>'
        + '<td style="font-size:12px;color:var(--t2)">' + p.d + '</td>'
        + '</tr>';
    }).join('');

    var reqUrl = FWD2API_BASE.replace(/\/+$/, '') + ep.path + '?' + ep.query;

    return '<div class="card">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">' + mbadge
      + '<span style="font-family:ui-monospace,monospace;font-size:13px;font-weight:700;color:var(--t1)">' + ep.path + '</span></div>'
      + '<div style="font-size:13px;font-weight:600;color:var(--t2)">' + ep.summary + '</div>'
      + '<div style="font-size:12px;color:var(--t3);margin-bottom:10px">' + ep.desc + '</div>'

      + '<div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Parameters</div>'
      + '<div style="overflow-x:auto;margin-bottom:12px"><table class="rate-table"><thead><tr><th>ชื่อ</th><th>ชนิด</th><th>required</th><th>คำอธิบาย</th></tr></thead><tbody>' + params + '</tbody></table></div>'

      + '<div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">ลองเรียก</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">'
      + '<span style="font-family:ui-monospace,monospace;font-size:12px;color:var(--ok);font-weight:700">GET</span>'
      + '<span style="font-size:12px;color:var(--t3)">' + fwd2ApiEsc(ep.path) + '?</span>'
      + '<input type="text" id="fwd2api-q-' + i + '" value="' + fwd2ApiEsc(ep.query).replace(/"/g, '&quot;') + '" style="flex:1;min-width:220px;font-family:ui-monospace,monospace;font-size:12px">'
      + '<button class="btn btn-r fwd2api-try" data-i="' + i + '" style="font-size:11px;padding:6px 14px">' + ic('refresh') + ' ลองเรียก (live)</button>'
      + '</div>'
      + '<pre id="fwd2api-resp-' + i + '" style="' + codeSt + ';min-height:20px;display:none"></pre>'

      + '<div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 4px">ตัวอย่าง Response (200)</div>'
      + '<pre style="' + codeSt + '">' + fwd2ApiEsc(ep.resp) + '</pre>'
      + '</div>';
  }).join('');

  return '<div class="sc">' + header + bar + mkt
    + '<div style="font-size:13px;font-weight:700;color:var(--t2);margin:6px 2px 8px">Endpoints (' + S.endpoints.length + ')</div>'
    + eps + '</div>';
}

function bindFwd2Api() {
  document.querySelectorAll('.fwd2api-try').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var i = this.dataset.i;
      var pre = document.getElementById('fwd2api-resp-' + i);
      var url = fwd2ApiUrl(i);
      pre.style.display = 'block';
      pre.textContent = 'กำลังเรียก ' + url + ' ...';
      fetch(url)
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, ok: r.ok, text: t }; }); })
        .then(function (res) {
          var body = res.text;
          try { body = JSON.stringify(JSON.parse(res.text), null, 2); } catch (e) { }
          pre.style.color = res.ok ? '#cbd5e1' : '#fca5a5';
          pre.textContent = 'HTTP ' + res.status + '\n\n' + body;
        })
        .catch(function (err) {
          pre.style.color = '#fca5a5';
          pre.textContent = 'เรียก API ไม่สำเร็จ: ' + err.message
            + '\n\n• ตรวจว่ารัน service แล้ว (dotnet run ในโฟลเดอร์ net)'
            + '\n• ตรวจ Base URL ให้ตรงกับพอร์ตที่ service รันอยู่';
        });
    });
  });
}
