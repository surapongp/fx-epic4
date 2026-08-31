/* =============================================================================
 * tab "ตรวจสอบข้อมูล Sync จาก AS400" (phase 14)
 * หน้าจอเฝ้าดูรอบการ sync reference data 3 ชุดที่ FX Online ดึงมาจาก AS400
 *   · วันหยุดธนาคาร (Holiday)
 *   · Counter Rate
 *   · Swap Point
 *
 * ขอบเขตรอบนี้ (ตามที่ผู้ใช้เคาะ): แสดง "ระดับหัวรอบ" เท่านั้น
 *   1) แถบสรุปรอบล่าสุดของแต่ละชุดข้อมูล + ปุ่ม force trigger sync
 *   2) ปุ่มโหลดข้อมูลของแต่ละชุดเป็น CSV ไปเทียบกับฝั่ง AS400
 *   3) ตารางประวัติการ sync ย้อนหลัง (ฟิลเตอร์ / sort / แบ่งหน้า)
 *   ยังไม่แสดงตัวข้อมูลบนจอ (รายการวันหยุด, ตาราง rate, ตาราง swap point) — รอบถัดไป
 *   จึงให้ตรวจผ่านไฟล์ที่โหลดลงมาแทน
 *
 * ข้อสมมติของ prototype (ยังไม่มีสเปกจาก BU):
 *   A1 AS400 ส่ง reference data ทั้ง 3 ชุดเป็นรอบอัตโนมัติวันละครั้ง เวลา 04:30
 *      (ถ้าจริง ๆ วันหยุด sync ไม่ถี่เท่า rate ต้องแก้ตัว seed)
 *   A2 แต่ละรอบเป็น full snapshot ไม่ใช่ delta → จำนวนเรคคอร์ดจึงคงที่
 *      และไม่แยกตัวเลข เพิ่ม/แก้ไข/ลบ
 *   A3 "จำนวนเรคคอร์ด" นับจากข้อมูลจริงในระบบ (HOLIDAYS, M.rates) ณ ตอนที่บันทึกรอบนั้น
 *      เพื่อไม่ให้หน้าจอนี้ขัดกับตัวเลขที่แท็บอื่นใช้จริง · การ์ดสรุปอ่านค่าจากแถวประวัติ
 *      จึงตรงกับตารางด้านล่างเสมอ · ส่วนไฟล์ที่โหลดลงมาคือ "สภาพปัจจุบันในระบบ"
 *      ไม่ใช่การเล่นซ้ำ payload ของรอบนั้น (prototype ไม่ได้เก็บ payload ย้อนหลัง)
 *      สองตัวเลขนี้ต่างกันได้ ท้ายไฟล์จึงแยกป้ายกำกับให้ชัด
 *   A4 force trigger ใน prototype สำเร็จเสมอ · error path ดูได้จากรอบที่ล้มเหลวใน seed
 *   A5 ไม่มีกลไก resend / reconcile — นั่นเป็นขา "ส่งออก" ไป AS400
 *      ส่วนนี้เป็นขา "ดึงเข้า" ของ reference data
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   HOLIDAYS, M, fmtISO(), fmtTH(), ic(), render(), dayjs
 * จุดเชื่อม: render() ใน HTML เรียก hSync400()/bindSync400() เมื่อ P.phase===14
 * ============================================================================= */

/* === ค่าคงที่ === */

/* ชุดข้อมูลที่ sync — key ใช้เป็น data-ds ของปุ่มและค่าในตัวกรอง */
var SY_DS = [
  {key:'holiday', label:'วันหยุดธนาคาร', unit:'วัน',  desc:'ปฏิทินวันหยุดที่ใช้คำนวณ Value Date / Maturity Date'},
  {key:'counter', label:'Counter Rate',  unit:'สกุล', desc:'อัตราอ้างอิงก่อนบวก/ลบ Spread ตาม Segment'},
  {key:'swap',    label:'Swap Point',    unit:'จุด',  desc:'ส่วนต่างตาม Tenor ที่บวกเข้า Favor Rate'}
];
function syDs(k){ return SY_DS.filter(function(d){ return d.key===k; })[0] || {key:k, label:k, unit:''}; }

/* ผลของรอบ sync */
var SY_RESULTS = {
  ok:      {label:'สำเร็จ',        cls:'tag-ok'},
  partial: {label:'สำเร็จบางส่วน', cls:'tag-wn'},
  fail:    {label:'ล้มเหลว',       cls:'tag-er'}
};

var SY_MODES = {auto:'อัตโนมัติ', manual:'เรียกเอง'};

/* เจ้าหน้าที่ที่กำลังใช้หน้าจอ — ประวัติต้องบอกได้ว่าใครสั่ง sync */
var SY_USER = {id:'ops0271', name:'วรพล ระบบงาน', unit:'ฝ่ายเทคโนโลยีสารสนเทศ'};

var SY_COLS = [
  {key:'seq',     label:'ลำดับ',          num:true,  sortable:false},
  {key:'start',   label:'เริ่ม',           num:false},
  {key:'end',     label:'เสร็จ',           num:false},
  {key:'ds',      label:'ชุดข้อมูล',       num:false},
  {key:'mode',    label:'ประเภทรอบ',      num:false},
  {key:'result',  label:'ผล',             num:false},
  {key:'records', label:'จำนวนเรคคอร์ด',  num:true},
  {key:'eff',     label:'Effective Date', num:false},
  {key:'by',      label:'ผู้สั่ง',          num:false},
  {key:'msg',     label:'ข้อความจากระบบ', num:false, sortable:false}
];

/* === จำนวนเรคคอร์ดจริงในระบบ (A3) — อ่านสด ๆ ตอน render ไม่ snapshot ตอนโหลดไฟล์
   เพราะ Sim panel แก้ HOLIDAYS ได้ระหว่างรัน ถ้า snapshot ไว้ตัวเลขจะเพี้ยน === */
function syLiveCount(ds){
  if(ds==='holiday') return (typeof HOLIDAYS==='object') ? Object.keys(HOLIDAYS).length : 0;
  var ccys = (typeof M==='object' && M.ccys) ? M.ccys : [];
  if(ds==='counter') return ccys.length;
  /* swap point = สกุลเงิน × tenor 1–6 เดือน (ตามโครง M.rates[ccy].sw) */
  var tenors = (ccys.length && M.rates[ccys[0]] && M.rates[ccys[0]].sw) ? Object.keys(M.rates[ccys[0]].sw).length : 6;
  return ccys.length * tenors;
}

/* === seed ประวัติ (deterministic — ไม่สุ่มใหม่ทุกครั้งที่ render) === */
function syPad(n,w){ return String(n).padStart(w||2,'0'); }
function syDT(dateISO, hh, mm, ss){ return dateISO+' '+syPad(hh)+':'+syPad(mm)+':'+syPad(ss); }

var SY_SEQ = 0;                 /* ตัวนับ id ของแถวประวัติ */
var SY_DAYS_BACK = 30;          /* seed ย้อนหลัง 30 วัน */

/* แถวประวัติ 1 แถว = 1 รอบ ของ 1 ชุดข้อมูล */
function syMakeRow(o){
  SY_SEQ++;
  return {
    id:'SY'+syPad(SY_SEQ,4), ds:o.ds, start:o.start, end:o.end, mode:o.mode,
    result:o.result, records:o.records, eff:o.eff, by:o.by, msg:o.msg||''
  };
}

function sySeedLog(){
  var rows = [];
  var base = (typeof today!=='undefined' && today instanceof Date) ? today : new Date();
  for(var d=SY_DAYS_BACK; d>=1; d--){
    var dt   = dayjs(base).subtract(d,'day');
    var dISO = dt.format('YYYY-MM-DD');
    SY_DS.forEach(function(ds, idx){
      /* รอบอัตโนมัติ 04:30 — ยิงเรียงกันทีละชุด ชุดละ ~40 วินาที */
      var startS = 30 + idx*3;
      var dur    = 12 + idx*6;
      var result='ok', records=syLiveCount(ds.key), msg='';

      /* จุดล้มเหลว/ไม่ครบแบบกำหนดตายตัว — ให้ error path มีของจริงให้ดู */
      if(ds.key==='counter' && d%11===3){
        result='fail'; records=0;
        msg='เชื่อมต่อ AS400 ไม่สำเร็จ (timeout หลังรอ 60 วินาที)';
      } else if(ds.key==='swap' && d%13===5){
        result='partial'; records=Math.max(0, records-6);
        msg='ได้รับข้อมูลไม่ครบทุกสกุล — ขาด JPY';
      }

      rows.push(syMakeRow({
        ds:ds.key,
        start:syDT(dISO, 4, startS, 0),
        end:syDT(dISO, 4, startS, dur),
        mode:'auto', result:result, records:records,
        eff:result==='fail' ? '' : dISO,
        by:'ระบบ (Batch)', msg:msg
      }));
    });
  }
  return rows;
}

var SY_LOG = sySeedLog();

/* === state (ทุกตัวเป็น global — render() เขียนทับ innerHTML ทั้งก้อนทุกครั้ง) === */
function syToday(){ return fmtISO((typeof today!=='undefined' && today instanceof Date) ? today : new Date()); }
function syBlankFilter(){
  return {from:dayjs(syToday()).subtract(14,'day').format('YYYY-MM-DD'), to:syToday(), ds:'', result:''};
}
var SY_F     = syBlankFilter();   /* เงื่อนไขที่ใช้จริงกับตาราง */
var SY_DRAFT = syBlankFilter();   /* ค่าในฟอร์ม — ยังไม่มีผลจนกว่าจะกด "ค้นหา" */
var SY_ERR   = '';
var SY_SORT  = {key:'start', dir:'desc'};   /* รอบล่าสุดอยู่บนสุด */
var SY_PAGE  = 1;
var SY_SIZE  = 20;
var SY_SIZES = [10, 20, 50];
var SY_RUNNING = {};              /* ชุดข้อมูลที่กำลัง sync อยู่ → ปุ่มถูก disable */
var SY_FETCHED = new Date();      /* เวลาที่ดึงข้อมูลขึ้นหน้าจอครั้งล่าสุด */

/* === สรุปรอบล่าสุดของแต่ละชุด — คำนวณจาก SY_LOG ทั้งหมด
   (log เป็นแหล่งความจริงเดียว การ์ดจึงอัปเดตเองเมื่อมีรอบใหม่) === */
function sySummary(dsKey){
  var mine = SY_LOG.filter(function(r){ return r.ds===dsKey; })
                   .sort(function(a,b){ return a.start < b.start ? 1 : -1; });
  var last   = mine[0] || null;
  var lastOk = mine.filter(function(r){ return r.result!=='fail'; })[0] || null;
  /* จำนวนเรคคอร์ดอ่านจากแถวประวัติเสมอ — การ์ดกับตารางด้านล่างต้องไม่พูดคนละเลข
     ตัวเลขจะขยับก็ต่อเมื่อมีรอบใหม่เข้ามา (ซึ่งตอนนั้นค่อยนับของจริงด้วย syLiveCount) */
  return {
    running: !!SY_RUNNING[dsKey],
    last: last,
    lastOk: lastOk,
    records: lastOk ? lastOk.records : 0,
    eff: lastOk ? lastOk.eff : ''
  };
}

/* === ค้นหา / เรียง === */
function syRangeError(f){
  if(!f.from || !f.to) return 'กรุณาระบุช่วงวันที่ให้ครบทั้งสองช่อง';
  if(f.from > f.to)    return 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด';
  if(f.to > syToday()) return 'เลือกวันที่ในอนาคตไม่ได้';
  return '';
}

function syQuery(){
  var rows = SY_LOG.filter(function(r){
    var d = r.start.slice(0,10);
    if(d < SY_F.from || d > SY_F.to) return false;
    if(SY_F.ds && r.ds !== SY_F.ds) return false;
    if(SY_F.result && r.result !== SY_F.result) return false;
    return true;
  });
  var k = SY_SORT.key, sign = SY_SORT.dir==='asc' ? 1 : -1;
  return rows.sort(function(a,b){
    var va = a[k], vb = b[k];
    if(k==='ds')     { va = syDs(a.ds).label;      vb = syDs(b.ds).label; }
    if(k==='mode')   { va = SY_MODES[a.mode];      vb = SY_MODES[b.mode]; }
    if(k==='result') { va = SY_RESULTS[a.result].label; vb = SY_RESULTS[b.result].label; }
    if(va === vb) return a.id < b.id ? -1 : 1;     /* ค่าเท่ากัน → เรียงตาม id ให้ผลคงที่ */
    return (va < vb ? -1 : 1) * sign;
  });
}

function syPageInfo(total){
  var pages = Math.max(1, Math.ceil(total / SY_SIZE));
  var page  = Math.min(Math.max(1, SY_PAGE), pages);
  SY_PAGE = page;
  var start = (page-1) * SY_SIZE;
  return {page:page, pages:pages, total:total, start:start, end:Math.min(start+SY_SIZE, total)};
}

/* เลขหน้าแบบย่อ: 1 … 4 5 [6] 7 8 … 20 */
function syPageList(page, pages){
  if(pages <= 7){
    var all=[]; for(var i=1;i<=pages;i++) all.push(i); return all;
  }
  var out = [1], lo = Math.max(2, page-1), hi = Math.min(pages-1, page+1);
  if(lo > 2) out.push('…');
  for(var n=lo; n<=hi; n++) out.push(n);
  if(hi < pages-1) out.push('…');
  out.push(pages);
  return out;
}

/* === force trigger sync === */
var SY_RUN_MS = 1200;   /* จำลองเวลาที่ AS400 ตอบกลับ */

function syTrigger(dsKey){
  var list = dsKey==='all' ? SY_DS.map(function(d){ return d.key; }) : [dsKey];
  var names = list.map(function(k){ return syDs(k).label; }).join(' · ');
  if(!confirm('สั่ง sync ข้อมูลจาก AS400 ทันที\n\nชุดข้อมูล: '+names+'\n\nคำสั่งนี้จะยิงไปที่ AS400 จริง และบันทึกลงประวัติในชื่อ '+SY_USER.name+'\nยืนยันหรือไม่?')) return;

  list.forEach(function(k){ SY_RUNNING[k] = true; });
  render();

  setTimeout(function(){
    var now  = new Date();
    var dISO = fmtISO(now);
    var hh = now.getHours(), mm = now.getMinutes(), ss = now.getSeconds();
    list.forEach(function(k){
      delete SY_RUNNING[k];
      /* prototype: รอบที่สั่งเองสำเร็จเสมอ (A4) */
      SY_LOG.push(syMakeRow({
        ds:k,
        start:syDT(dISO, hh, mm, ss),
        end:syDT(dISO, hh, mm, Math.min(59, ss + Math.round(SY_RUN_MS/1000))),
        mode:'manual', result:'ok', records:syLiveCount(k), eff:dISO,
        by:SY_USER.name, msg:'สั่ง sync จากหน้าจอตรวจสอบข้อมูล'
      }));
    });
    SY_FETCHED = now;
    SY_PAGE = 1;          /* รอบใหม่อยู่บนสุดของลำดับเริ่มต้น — พากลับไปหน้า 1 ให้เห็น */
    render();
  }, SY_RUN_MS);
}

function syRefresh(){ SY_FETCHED = new Date(); render(); }

/* === โหลดข้อมูลของรอบล่าสุดลงมาตรวจสอบ ===
   หน้าจอนี้ไม่แสดงตัวข้อมูลบนจอ (ตามขอบเขตที่เคาะไว้) จึงให้โหลดเป็นไฟล์ไปเทียบกับฝั่ง AS400 แทน
   ข้อมูลที่ได้คือ reference data ที่ FX Online ใช้อยู่จริง ณ ตอนกดปุ่ม */

var SY_DAYS_TH = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];

/* คืน {cols, rows} ของชุดข้อมูล — จำนวนแถวต้องตรงกับ syLiveCount() ของชุดนั้น */
function syDataTable(dsKey){
  if(dsKey==='holiday'){
    return {
      cols:['Date','วันที่','วันในสัปดาห์'],
      rows:Object.keys(HOLIDAYS).sort().map(function(s){
        return [s, s.split('-').reverse().join('/'), SY_DAYS_TH[dayjs(s).day()]];
      })
    };
  }
  if(dsKey==='counter'){
    return {
      cols:['Currency','Spot','Buy','Sell'],
      rows:M.ccys.map(function(c){
        var r = M.rates[c];
        return [c, fmtR(r.spot,c), fmtR(r.buy,c), fmtR(r.sell,c)];
      })
    };
  }
  /* swap point — 1 แถว = 1 สกุล × 1 tenor (โครงเดียวกับที่นับเรคคอร์ด) */
  var rows = [];
  M.ccys.forEach(function(c){
    var sw = M.rates[c].sw;
    Object.keys(sw).sort(function(a,b){ return a-b; }).forEach(function(t){
      rows.push([c, t, fmtR(sw[t], c)]);
    });
  });
  return {cols:['Currency','Tenor (เดือน)','Swap Point'], rows:rows};
}

function syCsvCell(v){
  var s = String(v==null ? '' : v);
  return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}

function syDownloadData(dsKey){
  var ds = syDs(dsKey), s = sySummary(dsKey);
  if(s.running){ alert('กำลัง sync '+ds.label+' อยู่ — รอให้รอบนี้เสร็จก่อนจึงโหลดข้อมูลได้'); return; }
  if(!s.lastOk){ alert('ยังไม่มีรอบที่ sync สำเร็จของ '+ds.label+' — ไม่มีข้อมูลให้โหลด'); return; }

  var t = syDataTable(dsKey);
  var L = [t.cols].concat(t.rows);

  /* ท้ายไฟล์บอกที่มาของข้อมูล — เอาไปเทียบกับ AS400 แล้วต้องรู้ว่ากำลังเทียบกับอะไร
     ตัวไฟล์คือ "สภาพปัจจุบันในระบบ" ไม่ใช่การเล่นซ้ำ payload ของรอบนั้น (เก็บ payload ย้อนหลังไม่ได้)
     จำนวนเรคคอร์ดจึงต้องแยกให้ชัดระหว่าง ณ เวลาที่โหลด กับ ที่บันทึกไว้ตอนจบรอบ */
  L.push([]);
  L.push(['ชุดข้อมูล', ds.label]);
  L.push(['ข้อมูลในระบบ ณ เวลาที่โหลด', t.rows.length+' เรคคอร์ด']);
  L.push(['ดาวน์โหลดเมื่อ', new Date().toLocaleString('th-TH')]);
  L.push(['ดาวน์โหลดโดย', SY_USER.name+' ('+SY_USER.id+')']);
  L.push(['รอบ sync สำเร็จล่าสุด (อ้างอิง)',
          syFmtDT(s.lastOk.end)+' · '+SY_MODES[s.lastOk.mode]+' · บันทึกไว้ '+s.records+' เรคคอร์ด']);
  L.push(['Effective Date ของรอบนั้น', s.eff || '—']);

  var csv = '﻿' + L.map(function(r){ return r.map(syCsvCell).join(','); }).join('\r\n');
  var a = document.createElement('a');
  a.download = 'AS400_'+dsKey+'_'+fmtISO(new Date())+'.csv';
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* === render === */

function syFmtDT(s){
  if(!s) return '—';
  var d = s.slice(0,10).split('-').reverse().join('/');
  return d+' '+s.slice(11);
}
function syFmtTime(s){ return s ? s.slice(11) : '—'; }
function syFmtClock(d){ return d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

function syHead(){
  return '<div style="font-size:20px;font-weight:700;color:var(--blue);margin-bottom:2px">ตรวจสอบข้อมูลที่ Sync จาก AS400</div>'
    +'<div style="font-size:13px;color:var(--t3);margin-bottom:16px">รอบการรับข้อมูลอ้างอิง: วันหยุดธนาคาร · Counter Rate · Swap Point</div>';
}

/* การ์ดสรุปรอบล่าสุด 1 ใบต่อ 1 ชุดข้อมูล */
function syCard(ds){
  var s = sySummary(ds.key);
  var busy  = s.running;
  var dlOff = busy || !s.lastOk;

  var badge = busy
    ? '<span class="tag tag-inf">'+ic('refresh')+' กำลัง sync…</span>'
    : (s.last
        ? '<span class="tag '+SY_RESULTS[s.last.result].cls+'">'+SY_RESULTS[s.last.result].label+'</span>'
        : '<span class="tag" style="background:var(--bg);color:var(--t3)">ยังไม่มีรอบ</span>');

  function line(label, value){
    return '<div class="dc-row"><span>'+label+'</span><span>'+value+'</span></div>';
  }

  /* รอบล่าสุดล้มเหลว → บอกให้ชัดว่าตัวเลขที่เห็นมาจากรอบสำเร็จก่อนหน้า */
  var stale = s.last && s.last.result==='fail'
    ? '<div class="hint err" style="margin-top:8px">'+ic('warn')+' รอบล่าสุดล้มเหลว — ตัวเลขด้านบนเป็นของรอบที่สำเร็จก่อนหน้า</div>'
    : '';

  return '<div class="card" style="flex:1;min-width:280px;margin-bottom:0">'
    +'<div class="card-title" style="justify-content:space-between;margin-bottom:12px">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('cal')+' '+ds.label+'</span>'
      +badge
    +'</div>'
    +'<div style="font-size:11px;color:var(--t3);line-height:1.6;margin-bottom:10px">'+ds.desc+'</div>'
    +'<div class="date-constraints" style="margin-top:0">'
      +line('sync สำเร็จล่าสุด', s.lastOk ? syFmtDT(s.lastOk.end) : '—')
      +line('รอบล่าสุด', s.last ? SY_MODES[s.last.mode]+' · '+syFmtDT(s.last.start) : '—')
      +line('จำนวนเรคคอร์ด', s.lastOk ? s.records.toLocaleString('th-TH')+' '+ds.unit : '—')
      +line('Effective Date', s.eff ? fmtTH(s.eff) : '—')
    +'</div>'
    +stale
    /* โหลดไม่ได้ถ้ากำลัง sync อยู่ (ข้อมูลกำลังเปลี่ยน) หรือยังไม่เคยมีรอบที่สำเร็จ */
    +'<div style="display:flex;gap:8px;margin-top:12px">'
      +'<button class="btn btn-s sy-run" data-ds="'+ds.key+'"'+(busy?' disabled':'')
        +' style="flex:1;justify-content:center'+(busy?';opacity:.45;cursor:not-allowed':'')+'">'
        +ic('refresh')+' '+(busy?'กำลัง sync…':'Sync ทันที')+'</button>'
      +'<button class="btn btn-s sy-dl" data-ds="'+ds.key+'"'+(dlOff?' disabled':'')
        +' style="flex:1;justify-content:center'+(dlOff?';opacity:.45;cursor:not-allowed':'')+'"'
        +' title="'+(dlOff?'ยังไม่มีข้อมูลให้โหลด':'โหลดข้อมูลของรอบล่าสุดเป็นไฟล์ CSV')+'">'
        +ic('dl')+' โหลดข้อมูล</button>'
    +'</div>'
  +'</div>';
}

function syTh(c){
  if(c.sortable===false) return '<th style="text-align:'+(c.num?'right':'left')+'">'+c.label+'</th>';
  var on = SY_SORT.key===c.key;
  var arrow = on ? (SY_SORT.dir==='asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.35">⇅</span>';
  return '<th class="sy-sort" data-key="'+c.key+'" style="cursor:pointer;text-align:'+(c.num?'right':'left')+';white-space:nowrap'
    +(on?';background:#0041B8':'')+'" title="คลิกเพื่อเรียงลำดับ">'+c.label+arrow+'</th>';
}

function syRow(r, i){
  var res = SY_RESULTS[r.result];
  return '<tr>'
    +'<td style="text-align:right;color:var(--t3);font-weight:400">'+(i+1)+'</td>'
    +'<td style="text-align:left;white-space:nowrap;font-weight:400">'+syFmtDT(r.start)+'</td>'
    +'<td style="text-align:left;white-space:nowrap;font-weight:400;color:var(--t3)">'+syFmtTime(r.end)+'</td>'
    +'<td style="text-align:left">'+syDs(r.ds).label+'</td>'
    +'<td style="text-align:left"><span class="tag '+(r.mode==='manual'?'tag-inf':'')+'"'
      +(r.mode==='manual'?'':' style="background:var(--bg);color:var(--t3)"')+'>'+SY_MODES[r.mode]+'</span></td>'
    +'<td style="text-align:left"><span class="tag '+res.cls+'">'+res.label+'</span></td>'
    +'<td style="text-align:right'+(r.result==='fail'?';color:var(--t3)':'')+'">'+r.records.toLocaleString('th-TH')+'</td>'
    +'<td style="text-align:left;white-space:nowrap;font-weight:400">'+(r.eff ? r.eff.split('-').reverse().join('/') : '—')+'</td>'
    +'<td style="text-align:left;font-weight:400">'+r.by+'</td>'
    +'<td style="text-align:left;font-weight:400;color:'+(r.result==='ok'?'var(--t3)':'var(--er)')+'">'+(r.msg||'—')+'</td>'
  +'</tr>';
}

function syPager(pg){
  var sizeSel = '<span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--t3)">'
    +'<span>แสดงหน้าละ</span>'
    +'<select id="sy-size" style="width:auto;padding:5px 26px 5px 10px;font-size:12px">'
      + SY_SIZES.map(function(n){ return '<option value="'+n+'"'+(SY_SIZE===n?' selected':'')+'>'+n+'</option>'; }).join('')
    +'</select>'
    +'<span>รอบ</span>'
  +'</span>';

  if(pg.total===0){
    return '<div style="display:flex;align-items:center;padding-top:14px;margin-top:4px;border-top:1px solid var(--bdr)">'+sizeSel+'</div>';
  }

  function btn(label, page, opt){
    opt = opt||{};
    if(opt.gap) return '<span style="padding:0 4px;color:var(--t3);font-size:12px">…</span>';
    return '<button class="btn btn-s sy-page" data-page="'+page+'"'+(opt.disabled?' disabled':'')
      +' style="font-size:12px;padding:5px 11px;min-width:34px;justify-content:center'
      +(opt.current?';background:var(--blue);color:#fff;border-color:var(--blue)':'')
      +(opt.disabled?';opacity:.4;cursor:not-allowed':'')+'">'+label+'</button>';
  }

  var nums = syPageList(pg.page, pg.pages).map(function(n){
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

function hSync400(){
  var anyRunning = Object.keys(SY_RUNNING).length > 0;

  /* --- แถบสรุปรอบล่าสุด + ปุ่ม force trigger --- */
  var summary = '<div class="card">'
    +'<div class="card-title" style="justify-content:space-between">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('globe')+' รอบการ sync ล่าสุด</span>'
      +'<span style="display:flex;align-items:center;gap:12px">'
        +'<span style="font-size:11px;font-weight:400;color:var(--t3)">ดึงข้อมูลขึ้นหน้าจอเมื่อ '+syFmtClock(SY_FETCHED)+'</span>'
        +'<button class="btn btn-s" id="sy-refresh" style="font-size:11px;padding:5px 12px">'+ic('refresh')+' โหลดข้อมูลล่าสุด</button>'
        +'<button class="btn btn-p" id="sy-run-all"'+(anyRunning?' disabled':'')
          +' style="font-size:11px;padding:5px 12px'+(anyRunning?';opacity:.45;cursor:not-allowed':'')+'">'
          +ic('refresh')+' Sync ทั้งหมดทันที</button>'
      +'</span>'
    +'</div>'
    +'<div style="display:flex;gap:16px;flex-wrap:wrap">'+SY_DS.map(syCard).join('')+'</div>'
    +'<div class="hint" style="margin-top:14px">'+ic('info')+' รอบอัตโนมัติทำงานทุกวันเวลา 04:30 · การกด "Sync ทันที" จะบันทึกลงประวัติเป็นรอบประเภท <strong>เรียกเอง</strong> พร้อมชื่อผู้สั่ง · "โหลดข้อมูล" = ดาวน์โหลด reference data ของรอบล่าสุดเป็นไฟล์ CSV ไปเทียบกับฝั่ง AS400</div>'
  +'</div>';

  /* --- ตัวกรองประวัติ (ผูกกับ SY_DRAFT — ยังไม่มีผลจนกว่าจะกด "ค้นหา") --- */
  var dsOpts = '<option value="">ทุกชุดข้อมูล</option>'
    + SY_DS.map(function(d){ return '<option value="'+d.key+'"'+(SY_DRAFT.ds===d.key?' selected':'')+'>'+d.label+'</option>'; }).join('');
  var resOpts = '<option value="">ทุกผลลัพธ์</option>'
    + Object.keys(SY_RESULTS).map(function(k){
        return '<option value="'+k+'"'+(SY_DRAFT.result===k?' selected':'')+'>'+SY_RESULTS[k].label+'</option>';
      }).join('');

  var filters = '<div class="card">'
    +'<div class="card-title">'+ic('cal')+' เงื่อนไขการค้นประวัติ</div>'
    +'<div class="row" style="margin-bottom:0;align-items:flex-end">'
      +'<div class="fg"><label class="fl">ตั้งแต่วันที่ <span class="req">*</span></label>'
        +'<input type="date" id="sy-from" max="'+syToday()+'" value="'+SY_DRAFT.from+'"></div>'
      +'<div class="fg"><label class="fl">ถึงวันที่ <span class="req">*</span></label>'
        +'<input type="date" id="sy-to" max="'+syToday()+'" value="'+SY_DRAFT.to+'"></div>'
      +'<div class="fg"><label class="fl">ชุดข้อมูล</label><select id="sy-ds">'+dsOpts+'</select></div>'
      +'<div class="fg"><label class="fl">ผลลัพธ์</label><select id="sy-result">'+resOpts+'</select></div>'
      +'<div style="display:flex;gap:8px;flex:0 0 auto">'
        +'<button class="btn btn-s" id="sy-reset">'+ic('refresh')+' ล้างเงื่อนไข</button>'
        +'<button class="btn btn-p" id="sy-search">'+ic('doc')+' ค้นหา</button>'
      +'</div>'
    +'</div>'
  +'</div>';

  if(SY_ERR){
    return '<div class="sc">'+syHead()+summary+filters
      +'<div class="alert err">'+ic('warn')+'<div>'+SY_ERR+'</div></div></div>';
  }

  /* --- ตารางประวัติ --- */
  var rows = syQuery();
  var pg   = syPageInfo(rows.length);
  var body = rows.length
    ? rows.slice(pg.start, pg.end).map(function(r,i){ return syRow(r, pg.start+i); }).join('')
    : '<tr><td colspan="'+SY_COLS.length+'" style="text-align:center;color:var(--t3);padding:28px;font-weight:400">ไม่พบรอบการ sync ตามเงื่อนไขที่เลือก</td></tr>';

  var sortLbl = (SY_COLS.filter(function(c){ return c.key===SY_SORT.key; })[0]||{}).label || '';
  var failed  = rows.filter(function(r){ return r.result!=='ok'; }).length;
  var countTxt = rows.length
    ? 'แสดง '+(pg.start+1)+'–'+pg.end+' จาก '+rows.length+' รอบ'+(failed?' · มีปัญหา '+failed+' รอบ':'')
    : 'ไม่พบรอบ';

  var table = '<div class="card">'
    +'<div class="card-title" style="justify-content:space-between">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('doc')+' ประวัติการ sync</span>'
      +'<span style="font-size:11px;font-weight:400;color:var(--t3)">'+countTxt+' · เรียงตาม '+sortLbl+' ('+(SY_SORT.dir==='asc'?'เก่า→ใหม่':'ใหม่→เก่า')+')</span>'
    +'</div>'
    +'<div style="overflow-x:auto"><table class="rate-table" style="font-size:12px;min-width:1180px">'
      +'<thead><tr>'+SY_COLS.map(syTh).join('')+'</tr></thead>'
      +'<tbody>'+body+'</tbody>'
    +'</table></div>'
    +syPager(pg)
  +'</div>';

  return '<div class="sc">'+syHead()+summary+filters+table+'</div>';
}

/* กดค้นหา: validate DRAFT ก่อน · ผ่านแล้วจึง apply เข้า SY_F */
function sySearch(){
  SY_ERR = syRangeError(SY_DRAFT);
  if(!SY_ERR){
    SY_F = {from:SY_DRAFT.from, to:SY_DRAFT.to, ds:SY_DRAFT.ds, result:SY_DRAFT.result};
    SY_PAGE = 1;
  }
  render();
}

function bindSync400(){
  function $(id){ return document.getElementById(id); }
  function on(id,ev,fn){ var e=$(id); if(e) e.addEventListener(ev,fn); }

  /* แก้ฟอร์ม = เขียนลง DRAFT อย่างเดียว ไม่ render (ตารางยังคงผลค้นหาเดิมไว้) */
  on('sy-from','change',  function(){ SY_DRAFT.from=this.value; });
  on('sy-to','change',    function(){ SY_DRAFT.to=this.value; });
  on('sy-ds','change',    function(){ SY_DRAFT.ds=this.value; });
  on('sy-result','change',function(){ SY_DRAFT.result=this.value; });

  on('sy-search','click', sySearch);
  on('sy-reset','click',  function(){
    SY_F=syBlankFilter(); SY_DRAFT=syBlankFilter(); SY_ERR='';
    SY_SORT={key:'start', dir:'desc'}; SY_PAGE=1;
    render();
  });

  on('sy-refresh','click', syRefresh);

  /* force trigger — ทั้งหมด / รายชุดข้อมูล */
  on('sy-run-all','click', function(){ if(!this.disabled) syTrigger('all'); });
  document.querySelectorAll('.sy-run').forEach(function(b){
    b.addEventListener('click', function(){ if(!this.disabled) syTrigger(this.dataset.ds); });
  });

  /* โหลดข้อมูลของชุดนั้นเป็น CSV ไปเทียบกับฝั่ง AS400 */
  document.querySelectorAll('.sy-dl').forEach(function(b){
    b.addEventListener('click', function(){ if(!this.disabled) syDownloadData(this.dataset.ds); });
  });

  on('sy-size','change', function(){ SY_SIZE=parseInt(this.value,10); SY_PAGE=1; render(); });
  document.querySelectorAll('.sy-page').forEach(function(b){
    b.addEventListener('click', function(){
      if(this.disabled) return;
      SY_PAGE=parseInt(this.dataset.page,10); render();
    });
  });

  /* คลิกหัวคอลัมน์เพื่อ sort (คลิกซ้ำ = สลับทิศ) */
  document.querySelectorAll('.sy-sort').forEach(function(th){
    th.addEventListener('click', function(){
      var k=this.dataset.key;
      if(SY_SORT.key===k) SY_SORT.dir = (SY_SORT.dir==='asc'?'desc':'asc');
      else SY_SORT={key:k, dir:'asc'};
      SY_PAGE=1;
      render();
    });
  });
}
