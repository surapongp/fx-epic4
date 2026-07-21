/* =============================================================================
 * SA-1285 — tab "รายงาน Turnover" (phase 12)
 * "หน้าจอเรียกดูรายงานของลูกค้า" → รายงานการจอง Forward Contract (Turnover)
 *
 * โจทย์ (As a ลูกค้า):
 *   - เลือกช่วงเวลา (From/To) · ดึงข้อมูลได้สูงสุด 2 ปี
 *   - กรองตามประเภทสัญญา (ซื้อ/ขาย) · สกุลเงิน · เลขที่สัญญา (ทุกเงื่อนไขใช้ร่วมกันแบบ AND)
 *   - เงื่อนไขมีผลเมื่อกดปุ่ม "ค้นหา" เท่านั้น (TR_DRAFT = ที่กำลังกรอก · TR_F = ที่ค้นแล้ว)
 *   - ตารางแสดงรายการ sort ได้ทุกคอลัมน์ (คลิกหัวคอลัมน์ · คลิกซ้ำสลับทิศ)
 *   - ดาวน์โหลดเป็น Excel (CSV UTF-8 BOM — เปิดใน Excel ได้เลย ภาษาไทยไม่เพี้ยน)
 *   - ค่าเริ่มต้นเรียงตาม Booking Date & Time (ตาม AC)
 *
 *   - ตารางบอกช่องทางที่ทำรายการ (Online / Offline) · รายการ Online ดาวน์โหลดเอกสารสัญญาได้
 *   - แบ่งหน้า + เลือกจำนวนต่อหน้า (แสดงผลเท่านั้น — ไฟล์ CSV ได้ครบทุกแถวเสมอ)
 *
 * 15 คอลัมน์ตาม AC (+ ช่องทาง, เอกสาร): รายการที่ · วันที่ทำรายการ · เวลา · เลขที่สัญญา · สกุลเงิน ·
 *   จำนวนเงิน · ประเภทสัญญา · อัตรา SPOT · Premium/Discount · อัตราสุดท้าย ·
 *   ระยะเวลา · จำนวนวัน · วันที่เริ่มใช้ · วันครบกำหนด · ทำรายการโดย
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   fmt(), fmtR(), fmtISO(), fmtTH(), ic(), render(), dayjs
 * จุดเชื่อม: render() ใน HTML เรียก hTurnover()/bindTurnover() เมื่อ P.phase===12
 * ============================================================================= */

/* === ค่าคงที่ === */
var TR_CCYS = [
  {c:'USD', spot:36.2500, unit:1},
  {c:'EUR', spot:39.6000, unit:1},
  {c:'GBP', spot:46.2000, unit:1},
  {c:'JPY', spot:0.245000, unit:100},   /* JPY quote ต่อ 100 เยน · ทศนิยม 6 ตำแหน่ง (ตาม fmtR) */
  {c:'CNY', spot:5.0200,  unit:1},
  {c:'SGD', spot:27.1000, unit:1}
];
var TR_TYPES = {
  buy:  {label:'ซื้อล่วงหน้า',  short:'ซื้อ',  cls:'buy'},   /* ลูกค้าซื้อเงินตราต่างประเทศล่วงหน้า */
  sell: {label:'ขายล่วงหน้า',  short:'ขาย',  cls:'sell'}   /* ลูกค้าขายเงินตราต่างประเทศล่วงหน้า */
};
var TR_MAX_YEARS = 2;   /* ดึงข้อมูลย้อนหลังได้สูงสุด 2 ปี (ตาม AC) */

/* คอลัมน์: key ใช้ sort · num=จัดชิดขวา
   15 คอลัมน์ตาม AC คงลำดับเดิมครบ · เพิ่ม "ช่องทาง" (ต่อจากเลขที่สัญญา) และ "เอกสาร" (ท้ายสุด) */
var TR_COLS = [
  {key:'seq',      label:'รายการที่',      num:true,  sortable:false},
  {key:'bookedAt', label:'วันที่ทำรายการ', num:false},
  {key:'time',     label:'เวลา',           num:false},
  {key:'contract', label:'เลขที่สัญญา',    num:false},
  {key:'online',   label:'ช่องทาง',        num:false},
  {key:'ccy',      label:'สกุลเงิน',       num:false},
  {key:'amt',      label:'จำนวนเงิน',      num:true},
  {key:'type',     label:'ประเภทสัญญา',    num:false},
  {key:'spot',     label:'อัตรา SPOT',     num:true},
  {key:'prem',     label:'Premium/Discount', num:true},
  {key:'final',    label:'อัตราสุดท้าย',   num:true},
  {key:'tenorM',   label:'ระยะเวลา',       num:true},
  {key:'days',     label:'จำนวนวัน',       num:true},
  {key:'valueDate',label:'วันที่เริ่มใช้',  num:false},
  {key:'maturity', label:'วันครบกำหนด',    num:false},
  {key:'by',       label:'ทำรายการโดย',    num:false},
  {key:'doc',      label:'เอกสาร',         num:false, sortable:false}
];

/* === seed data (deterministic — ไม่สุ่มใหม่ทุกครั้งที่ render) === */
/* LCG เล็ก ๆ เพื่อให้ข้อมูลตัวอย่างคงที่ทุกครั้งที่เปิดหน้า */
function trRnd(seed){
  var s = seed;
  return function(){ s = (s*1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}
function trPad(n){ return String(n).padStart(2,'0'); }

function trSeed(){
  var R = trRnd(12850721);
  var USERS = ['สมชาย ใจดี','วราภรณ์ ศรีสุข','ปิยะ ทองมาก','ณัฐพล วงศ์ไทย','อารีย์ พาณิชย์'];
  var TENORS = [1,2,3,6,9,12];
  var AMTS = [50000,100000,150000,200000,250000,300000,500000,750000,1000000,1200000];
  var out = [], NOW = new Date(), D = 86400000;

  for(var i=0;i<64;i++){
    var cc   = TR_CCYS[Math.floor(R()*TR_CCYS.length)];
    var side = R() < 0.55 ? 'sell' : 'buy';
    var tenorM = TENORS[Math.floor(R()*TENORS.length)];

    /* วัน-เวลาที่ทำรายการ: ย้อนหลังได้ถึง ~26 เดือน (ให้ตัวกรอง 2 ปีมีผลจริง)
       ยกกำลังสองเพื่อเอนข้อมูลมาทางรายการล่าสุด — ช่วง 3 เดือนที่เป็นค่าเริ่มต้นจะได้ไม่โล่ง */
    var u = R();
    var daysAgo = Math.floor(u*u*780) + 1;
    var b = new Date(NOW.getTime() - daysAgo*D);
    b.setHours(9 + Math.floor(R()*8), Math.floor(R()*60), Math.floor(R()*60), 0);

    /* value date = booking + 2 วันทำการ (ย่อเป็น +2 วันปฏิทินสำหรับ prototype) */
    var vd  = new Date(b.getFullYear(), b.getMonth(), b.getDate()+2);
    var mdj = dayjs(fmtISO(vd)).add(tenorM,'month');
    var md  = new Date(mdj.year(), mdj.month(), mdj.date());
    var days = Math.round((md - vd)/D);

    /* spot ขยับเล็กน้อยรายรายการ · swap point โตตามระยะเวลา (ส่วนใหญ่เป็น premium) */
    var spot = cc.spot * (1 + (R()-0.5)*0.012);
    var prem = cc.spot * (tenorM * (0.0009 + R()*0.0011)) * (R() < 0.15 ? -1 : 1);
    var final_ = spot + prem;

    var amt = AMTS[Math.floor(R()*AMTS.length)] * (cc.c==='JPY' ? 100 : cc.c==='CNY' ? 5 : 1);

    /* ช่องทางที่ทำรายการ — โหลดเอกสารสัญญาได้เฉพาะรายการที่ลูกค้าทำเองผ่าน FX Online (ตาม AC ข้อ 3) */
    var online = R() < 0.65;

    out.push({
      id:'TR'+trPad(i+1),
      bookedAt: b.getTime(),
      dateISO: fmtISO(b),
      time: trPad(b.getHours())+':'+trPad(b.getMinutes())+':'+trPad(b.getSeconds()),
      contract: 'FWD-'+b.getFullYear()+'-'+(100000+i*7+3),
      online: online,
      ccy: cc.c,
      amt: amt,
      type: side,
      spot: spot,
      prem: prem,
      final: final_,
      tenorM: tenorM,
      days: days,
      valueDate: fmtISO(vd),
      maturity: fmtISO(md),
      by: USERS[Math.floor(R()*USERS.length)]
    });
  }
  return out;
}
var TR_ROWS = trSeed();

/* === state === */
function trDefaultFrom(){
  var n = new Date();
  return fmtISO(new Date(n.getFullYear(), n.getMonth()-3, n.getDate()));   /* ค่าเริ่มต้น: ย้อนหลัง 3 เดือน */
}
function trBlankFilter(){
  return {from:trDefaultFrom(), to:fmtISO(new Date()), type:'', ccy:'', contract:''};
}
/* แยก 2 ชุด: DRAFT = ค่าที่ผู้ใช้กำลังกรอกในฟอร์ม · F = ค่าที่กดค้นหาแล้ว (ตารางใช้ชุดนี้)
   ผู้ใช้ต้องกด "ค้นหา" ถึงจะ apply — แก้ฟอร์มทิ้งไว้แล้ว sort ตาราง ค่าที่กรอกจะไม่หาย */
var TR_F     = trBlankFilter();
var TR_DRAFT = trBlankFilter();
var TR_ERR   = '';                            /* ข้อความ error จากการ validate ตอนกดค้นหา */
var TR_SORT = {key:'bookedAt', dir:'asc'};   /* ค่าเริ่มต้นตาม AC: เรียงตาม Booking Date & Time */

/* การแบ่งหน้า — เป็นเรื่องการ "แสดงผล" เท่านั้น ไฟล์ CSV ยังได้ครบทุกแถวเสมอ */
var TR_SIZES = [10,25,50,100];
var TR_SIZE  = 25;
var TR_PAGE  = 1;

/* === logic === */

/* ตรวจช่วงวันที่ของ filter ที่ส่งเข้ามา: from<=to และห่างกันไม่เกิน 2 ปี */
function trRangeError(f){
  if(!f.from || !f.to) return 'กรุณาเลือกช่วงวันที่ทั้ง "ตั้งแต่" และ "ถึง"';
  if(f.from > f.to)    return 'วันที่ "ตั้งแต่" ต้องไม่เกินวันที่ "ถึง"';
  var lim = dayjs(f.from).add(TR_MAX_YEARS,'year');
  if(dayjs(f.to).isAfter(lim)) return 'ช่วงเวลาที่เลือกเกิน '+TR_MAX_YEARS+' ปี — เรียกข้อมูลได้สูงสุด '+TR_MAX_YEARS+' ปีต่อครั้ง';
  return '';
}

/* กรอง → เรียง · คืนรายการที่พร้อมแสดง (ยังไม่ใส่เลข "รายการที่")
   TR_F ผ่าน validate มาแล้วเสมอ (assign เฉพาะตอนกดค้นหาและไม่มี error) */
function trQuery(){
  var cno = TR_F.contract.trim().toLowerCase();
  var out = TR_ROWS.filter(function(r){
    if(r.dateISO < TR_F.from || r.dateISO > TR_F.to) return false;
    if(TR_F.type && r.type !== TR_F.type) return false;
    if(TR_F.ccy  && r.ccy  !== TR_F.ccy)  return false;
    if(cno && r.contract.toLowerCase().indexOf(cno) < 0) return false;   /* ค้นบางส่วนได้ เช่นพิมพ์ "100031" */
    return true;
  });
  var k = TR_SORT.key, sgn = TR_SORT.dir==='asc' ? 1 : -1;
  out.sort(function(a,b){
    var x = a[k], y = b[k];
    if(k==='type'){ x = TR_TYPES[x].short; y = TR_TYPES[y].short; }
    if(k==='online'){ x = x?1:0; y = y?1:0; }   /* boolean → ตัวเลข เพื่อให้เรียงชัดเจน (Offline ก่อน Online เมื่อ asc) */
    if(x === y) return (a.bookedAt - b.bookedAt) * sgn;   /* tie-break ด้วยเวลาจองเสมอ */
    return (typeof x === 'number' ? x-y : String(x).localeCompare(String(y),'th')) * sgn;
  });
  return out;
}

/* ข้อมูลการแบ่งหน้า · clamp หน้าปัจจุบันเผื่อผลค้นแคบลงจนหน้าที่ค้างอยู่หายไป */
function trPageInfo(total){
  var pages = Math.max(1, Math.ceil(total/TR_SIZE));
  var page  = Math.min(Math.max(1,TR_PAGE), pages);
  TR_PAGE = page;
  var start = (page-1)*TR_SIZE;
  return {page:page, pages:pages, start:start, end:Math.min(start+TR_SIZE, total), total:total};
}

/* เลขหน้าที่จะแสดง: หน้าแรก · หน้าสุดท้าย · หน้าปัจจุบัน±1 · คั่นด้วย '…' เมื่อมีช่องว่าง */
function trPageList(cur,pages){
  var want = [1, pages, cur-1, cur, cur+1].filter(function(n){ return n>=1 && n<=pages; });
  var uniq = want.filter(function(n,i){ return want.indexOf(n)===i; }).sort(function(a,b){ return a-b; });
  var out = [];
  uniq.forEach(function(n,i){
    if(i>0 && n-uniq[i-1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

/* สรุปยอด: จำนวนรายการ · แยกซื้อ/ขาย · ยอดรวมต่อสกุลเงิน */
function trStats(rows){
  var s = {n:rows.length, buy:0, sell:0, byCcy:{}};
  rows.forEach(function(r){
    s[r.type]++;
    s.byCcy[r.ccy] = (s.byCcy[r.ccy]||0) + r.amt;
  });
  return s;
}

/* ดาวน์โหลด Excel — CSV UTF-8 + BOM (Excel เปิดตรง ๆ ภาษาไทยไม่เพี้ยน) */
function trCsvCell(v){
  var s = String(v==null ? '' : v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function trExport(){
  var rows = trQuery();
  if(!rows.length){ alert('ไม่มีข้อมูลให้ดาวน์โหลด — กรุณาปรับเงื่อนไขการค้นหา'); return; }
  var st = trStats(rows);
  var L = [];
  L.push(['รายงาน Turnover — การจอง Forward Contract (FX Online)']);
  L.push(['ชื่อบริษัท','บจ. ไทย เอ็กซ์พอร์ต จำกัด','รหัสบริษัท','C00124567']);
  L.push(['ช่วงข้อมูล', fmtTH(TR_F.from)+' ถึง '+fmtTH(TR_F.to)]);
  L.push(['ประเภทสัญญา', TR_F.type ? TR_TYPES[TR_F.type].label : 'ทั้งหมด', 'สกุลเงิน', TR_F.ccy || 'ทั้งหมด']);
  if(TR_F.contract.trim()) L.push(['ค้นด้วยเลขที่สัญญา', TR_F.contract.trim()]);
  L.push(['วันที่ออกรายงาน', new Date().toLocaleString('th-TH')]);
  L.push([]);
  /* คอลัมน์ "เอกสาร" เป็นปุ่มบนหน้าจอ ไม่มีความหมายในไฟล์ — ตัดออกจาก CSV */
  L.push(TR_COLS.filter(function(c){ return c.key!=='doc'; }).map(function(c){ return c.label; }));
  rows.forEach(function(r,i){
    L.push([
      i+1, r.dateISO, r.time, r.contract, r.online?'Online':'Offline', r.ccy, r.amt.toFixed(2), TR_TYPES[r.type].label,
      fmtR(r.spot,r.ccy), fmtR(r.prem,r.ccy), fmtR(r.final,r.ccy),
      r.tenorM+' เดือน', r.days, r.valueDate, r.maturity, r.by
    ]);
  });
  L.push([]);
  L.push(['รวมทั้งสิ้น', st.n+' รายการ', 'ซื้อ '+st.buy+' รายการ', 'ขาย '+st.sell+' รายการ']);
  Object.keys(st.byCcy).sort().forEach(function(c){
    L.push(['ยอดรวม '+c, st.byCcy[c].toFixed(2)]);
  });

  var csv = '﻿' + L.map(function(r){ return r.map(trCsvCell).join(','); }).join('\r\n');
  var a = document.createElement('a');
  a.download = 'Turnover_'+TR_F.from+'_ถึง_'+TR_F.to+'.csv';
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* === ดาวน์โหลดเอกสารสัญญา (เฉพาะรายการ Online) === */

/* สร้างหน้าสัญญาแบบ self-contained — เปิดแล้วสั่ง print เป็น PDF ได้ */
function trContractHtml(r){
  var t = TR_TYPES[r.type];
  function row(label,value){
    return '<tr><th>'+label+'</th><td>'+value+'</td></tr>';
  }
  return '<!doctype html><html lang="th"><head><meta charset="utf-8">'
  +'<title>Forward Contract '+r.contract+'</title><style>'
  +'body{font-family:"Segoe UI",Tahoma,sans-serif;color:#1A1D26;margin:0;padding:40px;background:#F4F6FA}'
  +'.doc{max-width:760px;margin:0 auto;background:#fff;padding:40px 48px;border:1px solid #DDE1E9;border-radius:8px}'
  +'.hd{border-bottom:3px solid #C8102E;padding-bottom:16px;margin-bottom:6px}'
  +'.bank{font-size:19px;font-weight:800;color:#003087}.bank small{display:block;font-size:11px;font-weight:400;color:#6B7280;margin-top:2px}'
  +'h1{font-size:16px;color:#003087;margin:24px 0 4px}.sub{font-size:12px;color:#6B7280;margin-bottom:20px}'
  +'table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}'
  +'th{text-align:left;padding:9px 12px;background:#F4F6FA;color:#4B5563;font-weight:600;width:42%;border-bottom:1px solid #E5E7EB}'
  +'td{padding:9px 12px;border-bottom:1px solid #E5E7EB;font-weight:600;text-align:right}'
  +'.hi td{color:#003087;font-size:15px}'
  +'.note{font-size:11px;color:#6B7280;line-height:1.7;border-top:1px solid #E5E7EB;padding-top:14px}'
  +'.sign{display:flex;gap:40px;margin-top:36px;font-size:12px;color:#4B5563}'
  +'.sign div{flex:1;border-top:1px solid #9CA3AF;padding-top:6px;text-align:center}'
  +'.btn{position:fixed;top:20px;right:20px;background:#003087;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}'
  +'@media print{.btn{display:none}body{background:#fff;padding:0}.doc{border:none;max-width:none}}'
  +'</style></head><body>'
  +'<button class="btn" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button>'
  +'<div class="doc">'
    +'<div class="hd"><div class="bank">EXIM BANK<small>ธนาคารเพื่อการส่งออกและนำเข้าแห่งประเทศไทย</small></div></div>'
    +'<h1>สัญญาซื้อขายเงินตราต่างประเทศล่วงหน้า (Forward Contract)</h1>'
    +'<div class="sub">เลขที่สัญญา '+r.contract+' · ทำรายการผ่าน FX Online</div>'
    +'<table>'
      +row('ชื่อลูกค้า','บจ. ไทย เอ็กซ์พอร์ต จำกัด')
      +row('รหัสลูกค้า','C00124567')
      +row('วันที่ทำรายการ', fmtTH(r.dateISO)+' เวลา '+r.time)
      +row('ประเภทสัญญา', t.label)
      +row('สกุลเงิน', r.ccy)
      +row('จำนวนเงิน', fmt(r.amt,2)+' '+r.ccy)
      +row('อัตรา SPOT', fmtR(r.spot,r.ccy))
      +row('Premium / Discount', (r.prem>=0?'+':'')+fmtR(r.prem,r.ccy))
      +'<tr class="hi"><th>อัตราแลกเปลี่ยนล่วงหน้า (อัตราสุดท้าย)</th><td>'+fmtR(r.final,r.ccy)+'</td></tr>'
      +row('ระยะเวลา', r.tenorM+' เดือน ('+r.days+' วัน)')
      +row('วันที่เริ่มใช้ (Value Date)', fmtTH(r.valueDate))
      +row('วันครบกำหนด (Maturity Date)', fmtTH(r.maturity))
      +row('มูลค่าเทียบเท่าเงินบาท', fmt(r.amt*r.final,2)+' บาท')
      +row('ผู้ทำรายการ', r.by)
    +'</table>'
    +'<div class="note">เอกสารฉบับนี้ออกโดยระบบ FX Online เมื่อ '+new Date().toLocaleString('th-TH')+'<br>'
      +'ลูกค้ามีภาระผูกพันต้องส่งมอบ/รับมอบเงินตราต่างประเทศตามจำนวนและอัตราที่ระบุ ณ วันครบกำหนดข้างต้น<br>'
      +'<strong>เอกสารตัวอย่างสำหรับ prototype เท่านั้น ไม่มีผลผูกพันทางกฎหมาย</strong></div>'
    +'<div class="sign"><div>ผู้มีอำนาจลงนาม (ลูกค้า)</div><div>ผู้มีอำนาจลงนาม (ธนาคาร)</div></div>'
  +'</div></body></html>';
}

function trDownloadContract(id){
  var r = TR_ROWS.filter(function(x){ return x.id===id; })[0];
  if(!r) return;
  if(!r.online){ alert('รายการนี้ไม่ได้ทำผ่าน FX Online — ไม่มีเอกสารสัญญาให้ดาวน์โหลด'); return; }
  var a = document.createElement('a');
  a.download = r.contract+'.html';
  a.href = URL.createObjectURL(new Blob([trContractHtml(r)], {type:'text/html;charset=utf-8'}));
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* === render === */

function trTh(c){
  if(c.sortable===false) return '<th style="text-align:'+(c.num?'right':'left')+'">'+c.label+'</th>';
  var on = TR_SORT.key===c.key;
  var arrow = on ? (TR_SORT.dir==='asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.35">⇅</span>';
  return '<th class="tr-sort" data-key="'+c.key+'" style="cursor:pointer;text-align:'+(c.num?'right':'left')+';white-space:nowrap'
    +(on?';background:#0041B8':'')+'" title="คลิกเพื่อเรียงลำดับ">'+c.label+arrow+'</th>';
}

function trRow(r,i){
  var t = TR_TYPES[r.type];
  var premCls = r.prem < 0 ? 'sell' : 'buy';
  var premTxt = (r.prem>=0?'+':'') + fmtR(r.prem, r.ccy);
  return '<tr>'
    +'<td style="text-align:right;color:var(--t3);font-weight:400">'+(i+1)+'</td>'
    +'<td style="white-space:nowrap;text-align:left;font-weight:400">'+r.dateISO.split('-').reverse().join('/')+'</td>'
    +'<td style="text-align:left;font-weight:400;color:var(--t3)">'+r.time+'</td>'
    +'<td style="text-align:left;font-weight:600;color:var(--blue);white-space:nowrap">'+r.contract+'</td>'
    +'<td style="text-align:left">'+trChannel(r)+'</td>'
    +'<td style="text-align:left">'+r.ccy+'</td>'
    +'<td style="text-align:right">'+fmt(r.amt,2)+'</td>'
    +'<td style="text-align:left"><span class="tag '+(r.type==='buy'?'tag-ok':'tag-er')+'">'+t.label+'</span></td>'
    +'<td style="text-align:right">'+fmtR(r.spot,r.ccy)+'</td>'
    +'<td style="text-align:right" class="'+premCls+'">'+premTxt+'</td>'
    +'<td style="text-align:right;color:var(--blue)">'+fmtR(r.final,r.ccy)+'</td>'
    +'<td style="text-align:right;white-space:nowrap">'+r.tenorM+' เดือน</td>'
    +'<td style="text-align:right">'+r.days+'</td>'
    +'<td style="white-space:nowrap;text-align:left;font-weight:400">'+r.valueDate.split('-').reverse().join('/')+'</td>'
    +'<td style="white-space:nowrap;text-align:left;font-weight:400">'+r.maturity.split('-').reverse().join('/')+'</td>'
    +'<td style="text-align:left;font-weight:400">'+r.by+'</td>'
    +'<td style="text-align:center">'+(r.online
        ? '<button class="btn btn-s tr-dl" data-id="'+r.id+'" style="font-size:11px;padding:4px 10px;white-space:nowrap">'+ic('dl')+' โหลดสัญญา</button>'
        : '<span style="color:var(--t3);font-weight:400" title="ทำรายการนอกช่องทาง FX Online — ไม่มีเอกสารให้ดาวน์โหลด">—</span>')+'</td>'
  +'</tr>';
}

/* ป้ายช่องทาง: Online = ทำผ่าน FX Online (โหลดสัญญาได้) · Offline = ช่องทางอื่น */
function trChannel(r){
  return r.online
    ? '<span class="tag tag-inf" style="white-space:nowrap">Online</span>'
    : '<span class="tag" style="background:var(--bg);color:var(--t3);white-space:nowrap">Offline</span>';
}

function hTurnover(){
  var rows = trQuery();

  /* --- ตัวกรอง (ผูกกับ TR_DRAFT — ยังไม่มีผลจนกว่าจะกด "ค้นหา") --- */
  var ccyOpts = '<option value="">ทุกสกุลเงิน</option>'
    + TR_CCYS.map(function(c){ return '<option value="'+c.c+'"'+(TR_DRAFT.ccy===c.c?' selected':'')+'>'+c.c+'</option>'; }).join('');
  var typeOpts = '<option value="">ทุกประเภท</option>'
    + Object.keys(TR_TYPES).map(function(k){
        return '<option value="'+k+'"'+(TR_DRAFT.type===k?' selected':'')+'>'+TR_TYPES[k].label+'</option>';
      }).join('');

  var filters = '<div class="card">'
    +'<div class="card-title">'+ic('cal')+' เงื่อนไขการเรียกรายงาน</div>'
    +'<div class="row">'
      +'<div class="fg"><label class="fl">ตั้งแต่วันที่ <span class="req">*</span></label>'
        +'<input type="date" id="tr-from" value="'+TR_DRAFT.from+'"></div>'
      +'<div class="fg"><label class="fl">ถึงวันที่ <span class="req">*</span></label>'
        +'<input type="date" id="tr-to" value="'+TR_DRAFT.to+'"></div>'
      +'<div class="fg"><label class="fl">ประเภทสัญญา</label>'
        +'<select id="tr-type">'+typeOpts+'</select></div>'
      +'<div class="fg"><label class="fl">สกุลเงิน</label>'
        +'<select id="tr-ccy">'+ccyOpts+'</select></div>'
    +'</div>'
    +'<div class="row" style="margin-bottom:0;align-items:flex-end">'
      +'<div class="fg" style="flex:2"><label class="fl">เลขที่สัญญา</label>'
        +'<input type="text" id="tr-contract" placeholder="เช่น FWD-2026-100031 (พิมพ์บางส่วนได้)" value="'+TR_DRAFT.contract.replace(/"/g,'&quot;')+'"></div>'
      +'<div style="display:flex;gap:8px;flex:0 0 auto;margin-left:auto">'
        +'<button class="btn btn-s" id="tr-reset">'+ic('refresh')+' ล้างเงื่อนไข</button>'
        +'<button class="btn btn-p" id="tr-search">'+ic('doc')+' ค้นหา</button>'
      +'</div>'
    +'</div>'
    +'<div class="hint" style="margin-top:10px">'+ic('info')+' เรียกข้อมูลย้อนหลังได้สูงสุด '+TR_MAX_YEARS+' ปีต่อครั้ง · เลขที่สัญญาใช้ร่วมกับช่วงวันที่ · รายงานแสดงธุรกรรมทุกช่องทาง — ดาวน์โหลดเอกสารสัญญาได้เฉพาะรายการที่ทำผ่าน <strong>FX Online</strong></div>'
  +'</div>';

  if(TR_ERR){
    return '<div class="sc">'+trHead()+filters
      +'<div class="alert err">'+ic('warn')+'<div>'+TR_ERR+'</div></div></div>';
  }

  /* --- ตาราง (แสดงเฉพาะหน้าปัจจุบัน · เลข "รายการที่" นับต่อเนื่องข้ามหน้า) --- */
  var pg = trPageInfo(rows.length);
  var body = rows.length
    ? rows.slice(pg.start, pg.end).map(function(r,i){ return trRow(r, pg.start+i); }).join('')
    : '<tr><td colspan="'+TR_COLS.length+'" style="text-align:center;color:var(--t3);padding:28px;font-weight:400">ไม่พบรายการตามเงื่อนไขที่เลือก</td></tr>';

  var sortLbl = (TR_COLS.filter(function(c){return c.key===TR_SORT.key;})[0]||{}).label || '';
  var countTxt = rows.length
    ? 'แสดง '+(pg.start+1)+'–'+pg.end+' จาก '+rows.length+' รายการ'
    : 'ไม่พบรายการ';

  var table = '<div class="card">'
    +'<div class="card-title" style="justify-content:space-between">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('doc')+' รายการ Forward Contract</span>'
      +'<span style="display:flex;align-items:center;gap:12px">'
        +'<span style="font-size:11px;font-weight:400;color:var(--t3)">'+countTxt+' · เรียงตาม '+sortLbl+' ('+(TR_SORT.dir==='asc'?'น้อย→มาก':'มาก→น้อย')+')</span>'
        +'<button class="btn btn-s" id="tr-export" style="font-size:11px;padding:5px 12px">'+ic('dl')+' ดาวน์โหลด Excel</button>'
      +'</span>'
    +'</div>'
    +'<div style="overflow-x:auto"><table class="rate-table" style="font-size:12px;min-width:1500px">'
      +'<thead><tr>'+TR_COLS.map(trTh).join('')+'</tr></thead>'
      +'<tbody>'+body+'</tbody>'
    +'</table></div>'
    +trPager(pg)
  +'</div>';

  return '<div class="sc">'+trHead()+filters+table+'</div>';
}

/* แถบล่างตาราง: เลือกจำนวนต่อหน้า (ซ้าย) + ปุ่มเปลี่ยนหน้า (ขวา) */
function trPager(pg){
  var sizeSel = '<span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--t3)">'
    +'<span>แสดงหน้าละ</span>'
    +'<select id="tr-size" style="width:auto;padding:5px 26px 5px 10px;font-size:12px">'
      + TR_SIZES.map(function(n){ return '<option value="'+n+'"'+(TR_SIZE===n?' selected':'')+'>'+n+'</option>'; }).join('')
    +'</select>'
    +'<span>รายการ</span>'
  +'</span>';

  if(pg.total===0){
    return '<div style="display:flex;align-items:center;padding-top:14px;margin-top:4px;border-top:1px solid var(--bdr)">'+sizeSel+'</div>';
  }

  function btn(label,page,opt){
    opt = opt||{};
    if(opt.gap) return '<span style="padding:0 4px;color:var(--t3);font-size:12px">…</span>';
    var cur = opt.current;
    var dis = opt.disabled;
    return '<button class="btn btn-s tr-page" data-page="'+page+'"'+(dis?' disabled':'')
      +' style="font-size:12px;padding:5px 11px;min-width:34px;justify-content:center'
      +(cur?';background:var(--blue);color:#fff;border-color:var(--blue)':'')
      +(dis?';opacity:.4;cursor:not-allowed':'')+'">'+label+'</button>';
  }

  var nums = trPageList(pg.page, pg.pages).map(function(n){
    return n==='…' ? btn('',0,{gap:true}) : btn(String(n), n, {current:n===pg.page});
  }).join('');

  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:14px;margin-top:4px;border-top:1px solid var(--bdr)">'
    +sizeSel
    +'<span style="display:flex;align-items:center;gap:5px">'
      +btn('‹ ก่อนหน้า', pg.page-1, {disabled:pg.page<=1})
      +nums
      +btn('ถัดไป ›', pg.page+1, {disabled:pg.page>=pg.pages})
    +'</span>'
  +'</div>';
}

function trHead(){
  return '<div style="font-size:20px;font-weight:700;color:var(--blue);margin-bottom:2px">SA-1285 · รายงาน Turnover</div>'
    +'<div style="font-size:13px;color:var(--t3);margin-bottom:16px">รายงานการจอง Forward Contract ทุกช่องทาง · บจ. ไทย เอ็กซ์พอร์ต จำกัด (C00124567)</div>';
}

/* กดค้นหา: validate DRAFT ก่อน · ผ่านแล้วจึง apply เข้า TR_F (ตารางถึงจะเปลี่ยน) */
function trSearch(){
  TR_ERR = trRangeError(TR_DRAFT);
  if(!TR_ERR){
    TR_F = {from:TR_DRAFT.from, to:TR_DRAFT.to, type:TR_DRAFT.type, ccy:TR_DRAFT.ccy, contract:TR_DRAFT.contract};
    TR_PAGE = 1;                                /* ผลค้นชุดใหม่ ต้องเริ่มที่หน้า 1 */
  }
  render();
}

function bindTurnover(){
  function $(id){ return document.getElementById(id); }
  function on(id,ev,fn){ var e=$(id); if(e) e.addEventListener(ev,fn); }

  /* แก้ฟอร์ม = เขียนลง DRAFT อย่างเดียว ไม่ render (ตารางยังคงผลค้นหาเดิมไว้) */
  on('tr-from','change',    function(){ TR_DRAFT.from=this.value; });
  on('tr-to','change',      function(){ TR_DRAFT.to=this.value; });
  on('tr-type','change',    function(){ TR_DRAFT.type=this.value; });
  on('tr-ccy','change',     function(){ TR_DRAFT.ccy=this.value; });
  on('tr-contract','input', function(){ TR_DRAFT.contract=this.value; });
  /* กด Enter ในช่องเลขที่สัญญา = กดค้นหา */
  on('tr-contract','keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); trSearch(); } });

  on('tr-search','click',trSearch);

  on('tr-reset','click',function(){
    TR_F=trBlankFilter(); TR_DRAFT=trBlankFilter(); TR_ERR='';
    TR_SORT={key:'bookedAt', dir:'asc'}; TR_PAGE=1;   /* จำนวนต่อหน้าไม่รีเซ็ต — เป็นความชอบการแสดงผล ไม่ใช่เงื่อนไขค้นหา */
    render();
  });

  /* เปลี่ยนจำนวนต่อหน้า / เปลี่ยนหน้า */
  on('tr-size','change',function(){ TR_SIZE=parseInt(this.value,10); TR_PAGE=1; render(); });
  document.querySelectorAll('.tr-page').forEach(function(b){
    b.addEventListener('click',function(){
      if(this.disabled) return;
      TR_PAGE=parseInt(this.dataset.page,10); render();
    });
  });
  on('tr-export','click',trExport);

  /* ปุ่มโหลดเอกสารสัญญา (มีเฉพาะแถวที่ทำผ่าน FX Online) */
  document.querySelectorAll('.tr-dl').forEach(function(b){
    b.addEventListener('click',function(){ trDownloadContract(this.dataset.id); });
  });

  /* คลิกหัวคอลัมน์เพื่อ sort (คลิกซ้ำ = สลับทิศ) */
  document.querySelectorAll('.tr-sort').forEach(function(th){
    th.addEventListener('click',function(){
      var k=this.dataset.key;
      if(TR_SORT.key===k) TR_SORT.dir = (TR_SORT.dir==='asc'?'desc':'asc');
      else TR_SORT={key:k, dir:'asc'};
      TR_PAGE=1;              /* เรียงใหม่ = ลำดับเปลี่ยนทั้งชุด กลับไปหน้า 1 */
      render();
    });
  });
}
