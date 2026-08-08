/* =============================================================================
 * SA-1286 — tab "รายงานของ Business User" (phase 13)
 * "หน้าจอเรียกดูรายงานของ BU" → ภาพรวมธุรกรรม Forward Contract ที่ลูกค้าทำผ่าน FX Online
 *
 * โจทย์ (As a BU):
 *   AC-1 ตารางสรุปบนหน้าจอแบบ real-time — ยอดรวมต่อ "สกุลเงิน × Export/Import"
 *   AC-2 export รายงาน Excel (+PDF) 24 คอลัมน์ · ระบุ Date From/To · เรียงตาม Booking Date/Time
 *        · ท้ายรายงานมี Report request date/time + Username ที่เรียกรายงาน
 *   AC-3 เข้าดูโฟลเดอร์เอกสาร Underlying ที่ลูกค้า upload (ชื่อไฟล์ U+Contract No.+_YYMMDD)
 *   AC-4 BU ดูรายงานฝั่งลูกค้า (SA-1285) ได้ทุกฉบับ · ทุกราย → มีตัวกรองลูกค้า
 *
 * ขอบเขตข้อมูล: เฉพาะธุรกรรมที่ทำผ่าน FX Online (ยืนยันโดย BU — ไม่รวม offline)
 * ทิศทาง (ตาม AC): Export = ลูกค้า"ขาย" FCY ล่วงหน้า · Import = ลูกค้า"ซื้อ" FCY ล่วงหน้า
 *
 * ข้อสมมติของ prototype (open question ที่ยังไม่เคาะ — ดู SA-1286-AC.md):
 *   Q1 Forward Type — ตัวอย่างเป็น 'P' ทุกแถว จึง seed เป็น 'P' ทั้งหมด (ยังไม่รู้ค่าที่เป็นไปได้)
 *   Q2 คอลัมน์ 17–19 — สมมติเป็น flag ที่ FX Online บันทึกเองตอนยิงงานออก (ไม่ query ปลายทางสด)
 *   Q3 โครงสร้าง Underlying (ยืนยันโดยผู้ใช้): 1 สัญญา → หลาย Underlying (แยกตาม Invoice No.)
 *      · 1 Underlying → หลายไฟล์ · ตารางเก็บ 1 แถว = 1 สัญญา แล้วคั่นด้วย ", " ทั้ง invoice และไฟล์
 *   Q5 ชื่อไฟล์มี '/' ติดมาจากเลขสัญญา — แสดงตามสเปกตรง ๆ ไม่แอบแทนด้วย '-'
 *      · สเปกเดิม U+Contract No.+_YYMMDD ทำให้ชื่อชนกันเมื่อ 1 สัญญามีหลายไฟล์
 *        → เติม Invoice No. + running ต่อท้ายตามที่ผู้ใช้เคาะ (ยังไม่ผ่าน BU)
 *   Q8 real-time — ใช้ปุ่ม "โหลดข้อมูลล่าสุด" + ป้ายเวลาที่ดึงข้อมูล (ไม่ทำ auto-poll)
 *   Q9 ไฟล์ Excel — CSV UTF-8 BOM (เปิดใน Excel ได้เลย) เหมือน SA-1285 · PDF = หน้า print
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   fmt(), fmtR(), fmtISO(), fmtTH(), ic(), render(), goPhase(), dayjs
 * จุดเชื่อม: render() ใน HTML เรียก hBU1286()/bindBU1286() เมื่อ P.phase===13
 * ============================================================================= */

/* === ค่าคงที่ === */

/* seed สำหรับสร้างข้อมูลตัวอย่างเท่านั้น — "ตารางสรุป" ไม่ได้อ่านจากตัวนี้
   AC-1 ห้าม hardcode รายการสกุล → แกนสกุลเงินของตารางสรุปมาจากข้อมูลจริง (ดู buSummary) */
var BU_CCY_SEED = [
  {c:'AUD', spot:23.8500, unit:1},
  {c:'CHF', spot:40.9000, unit:1},
  {c:'CNY', spot:5.0200,  unit:1},
  {c:'EUR', spot:39.6000, unit:1},
  {c:'GBP', spot:46.2000, unit:1},
  {c:'HKD', spot:4.6600,  unit:1},
  {c:'JPY', spot:0.245000, unit:100},   /* JPY quote ต่อ 100 เยน · ทศนิยม 6 ตำแหน่ง (ตาม fmtR) */
  {c:'SGD', spot:27.1000, unit:1},
  {c:'USD', spot:36.2500, unit:1}
];

/* ประเภทสัญญาในมุมของ BU — map กับ ซื้อ/ขาย ของฝั่งลูกค้าตามที่ผู้ใช้ยืนยัน 31/07/2026 */
var BU_TYPES = {
  EXP: {label:'Export', desc:'ลูกค้าขายเงินตราต่างประเทศล่วงหน้า', cls:'tag-ok'},
  IMP: {label:'Import', desc:'ลูกค้าซื้อเงินตราต่างประเทศล่วงหน้า', cls:'tag-er'}
};

var BU_REQ_DOCS = ['Underlying', 'Underlying ตามวงเงิน'];

/* ผู้ใช้ที่กำลังเรียกรายงาน — ท้ายรายงานต้องมีชื่อคนเรียก (AC-2) */
var BU_USER = {id:'bu0142', name:'ศิริพร ตรวจสอบ', unit:'ฝ่ายบริหารเงิน (Treasury)'};

/* 24 คอลัมน์ตาม sheet "BU หน้ารายงาน Excel" (B9–Y9) — คงลำดับเดิมทั้งหมด
   key ใช้ sort · num=จัดชิดขวา · exp=false คือคอลัมน์บนจอที่ไม่ลงไฟล์ */
var BU_COLS = [
  {key:'seq',      label:'No.',                  num:true,  sortable:false},
  {key:'bookedAt', label:'Booking Date',         num:false},   /* sort ด้วย timestamp เต็ม = Booking Date + Time ตาม AC-2 */
  {key:'time',     label:'Booking Time',         num:false},
  {key:'custId',   label:'Cust ID',              num:false},
  {key:'custName', label:'Company Name',         num:false},
  {key:'contract', label:'Contract No.',         num:false},
  {key:'ccy',      label:'Currency',             num:false},
  {key:'amt',      label:'Amount',               num:true},
  {key:'type',     label:'Type of Contract',     num:false},
  {key:'spot',     label:'Spot Rate',            num:true},
  {key:'swap',     label:'Swap Points',          num:true},
  {key:'final',    label:'Final Rate',           num:true},
  {key:'tenorM',   label:'Tenor',                num:true},
  {key:'maturity', label:'Maturity Date',        num:false},
  {key:'fwdType',  label:'Forward Type',         num:false},
  {key:'by',       label:'Username ลูกค้า',      num:false},
  {key:'sentAs400',label:'Sent to AS400',        num:false},
  {key:'sentMail', label:'Sent Email Cfm',       num:false},
  {key:'sentEsvc', label:'Sent to E-Service',    num:false},
  {key:'reqDoc',   label:'Required Document',    num:false},
  {key:'ulInv',    label:'Invoice No.',          num:false, sortable:false},
  {key:'ulCcy',    label:'Currency (U)',         num:false, sortable:false},
  {key:'ulAmt',    label:'Amount (U)',           num:true,  sortable:false},
  {key:'ulFile',   label:'Underlying Upload file',num:false, sortable:false},
  /* 2 คอลัมน์ท้ายเป็นปุ่มบนจอ ไม่มีความหมายในไฟล์รายงาน */
  {key:'folder',   label:'โฟลเดอร์',             num:false, sortable:false, exp:false},
  {key:'doc',      label:'เอกสารสัญญา',          num:false, sortable:false, exp:false}
];

/* === seed data (deterministic — ไม่สุ่มใหม่ทุกครั้งที่ render) === */
function buRnd(seed){
  var s = seed;
  return function(){ s = (s*1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}
function buPad(n,w){ return String(n).padStart(w||2,'0'); }

/* ลูกค้าตัวอย่าง — BU เห็นได้ทุกราย (AC-4) จึงต้องมีหลายบริษัท */
var BU_CUSTS = [
  {id:'0012345', name:'บจ. ไทย เอ็กซ์พอร์ต จำกัด'},
  {id:'0023871', name:'บมจ. สยาม อะกริฟู้ดส์'},
  {id:'0031164', name:'บจ. เอเชีย พรีซิชั่น พาร์ท'},
  {id:'0044902', name:'บจ. บางกอก เท็กซ์ไทล์ กรุ๊ป'},
  {id:'0052380', name:'บมจ. อีสเทิร์น เคมิคอล'},
  {id:'0067513', name:'บจ. นครหลวง อิเล็กทรอนิกส์'},
  {id:'0071228', name:'บจ. รุ่งเรือง ซีฟู้ด อินเตอร์'},
  {id:'0088460', name:'บมจ. เมทัลเวิร์ค อินดัสทรี'}
];

/* เลขที่สัญญาแบบ BU: FOP + running 7 หลัก + '/' + ปี ค.ศ. 2 หลัก (เช่น FOP0100555/26) */
function buContractNo(seq, year){
  return 'FOP' + buPad(100000 + seq*7 + 3, 7) + '/' + buPad(year % 100);
}
/* ชื่อไฟล์เอกสาร Underlying — ต่อยอดจากสเปก U + Contract No. + '_' + YYMMDD (ค.ศ.)
   ตัวอย่างในไฟล์แนบคือ UFOP0100555/26_260416 ('/' ติดมาจากเลขสัญญา ไม่ใช่ตัวคั่นวันที่)
   แต่ 1 สัญญามีได้หลาย Underlying และ 1 Underlying มีได้หลายไฟล์ → ชื่อตามสเปกเดิมชนกันเอง
   จึงแทรก Invoice No. และเติม running 2 หลักท้าย: UFOP0100555/26_INV-2026-1003_260416_01 */
function buUlFileName(contract, inv, d, seq){
  return 'U' + contract + '_' + inv + '_'
    + buPad(d.getFullYear()%100) + buPad(d.getMonth()+1) + buPad(d.getDate())
    + '_' + buPad(seq);
}

function buSeed(){
  var R = buRnd(28613097);
  var USERS = ['somchai.j','waraporn.s','piya.t','nattapon.w','areeya.p','kanokwan.m'];
  var TENORS = [1,2,3,6,9,12];
  var AMTS = [50000,100000,150000,200000,250000,300000,500000,750000,1000000,1200000];
  var out = [], NOW = new Date(), D = 86400000;

  for(var i=0;i<86;i++){
    var cc     = BU_CCY_SEED[Math.floor(R()*BU_CCY_SEED.length)];
    var cust   = BU_CUSTS[Math.floor(R()*BU_CUSTS.length)];
    var type   = R() < 0.58 ? 'EXP' : 'IMP';    /* ธนาคารเพื่อการส่งออก → ฝั่ง Export หนากว่าเล็กน้อย */
    var tenorM = TENORS[Math.floor(R()*TENORS.length)];

    /* วัน-เวลาที่จอง: ย้อนหลังได้ถึง ~2 ปี · ยกกำลังสองเพื่อเอนมาทางรายการล่าสุด
       (ช่วง 3 เดือนที่เป็นค่าเริ่มต้นของตัวกรองจะได้ไม่โล่ง) */
    var u = R();
    var b = new Date(NOW.getTime() - (Math.floor(u*u*700) + 1)*D);
    b.setHours(9 + Math.floor(R()*8), Math.floor(R()*60), Math.floor(R()*60), 0);

    /* value date = booking + 2 วันทำการ (ย่อเป็น +2 วันปฏิทินสำหรับ prototype) */
    var vd  = new Date(b.getFullYear(), b.getMonth(), b.getDate()+2);
    var mdj = dayjs(fmtISO(vd)).add(tenorM,'month');
    var md  = new Date(mdj.year(), mdj.month(), mdj.date());

    var spot  = cc.spot * (1 + (R()-0.5)*0.012);
    var swap  = cc.spot * (tenorM * (0.0009 + R()*0.0011)) * (R() < 0.15 ? -1 : 1);
    var amt   = AMTS[Math.floor(R()*AMTS.length)] * (cc.c==='JPY' ? 100 : cc.c==='CNY' ? 5 : 1);
    var contract = buContractNo(i, b.getFullYear());

    /* เอกสาร Underlying: 1 สัญญา → 1–3 Underlying (แยกตาม Invoice No.) · 1 Underlying → 1–3 ไฟล์
       upload หลัง booking 0–4 วัน · ยอดรวมทุกใบ ≈ ยอดสัญญา (ใบสุดท้ายรับเศษ) */
    var nUl = R() < 0.55 ? 1 : (R() < 0.7 ? 3 : 2);
    var uls = [], left = amt;
    for(var k=0;k<nUl;k++){
      var share = (k===nUl-1) ? left : Math.round(amt/nUl);
      left -= share;
      var inv = 'INV-'+b.getFullYear()+'-'+buPad(1000+i*3+k, 4);
      var nFile = R() < 0.6 ? 1 : (R() < 0.8 ? 3 : 2);
      var files = [];
      for(var f=0;f<nFile;f++){
        var up = new Date(b.getFullYear(), b.getMonth(), b.getDate() + Math.floor(R()*5));
        files.push({
          name:  buUlFileName(contract, inv, up, f+1),
          upISO: fmtISO(up),
          size:  (0.3 + R()*2.4)                     /* MB — ใช้แสดงในมุมมองโฟลเดอร์ */
        });
      }
      uls.push({
        inv:   inv,
        ccy:   cc.c,                                 /* prototype: Underlying ใช้สกุลเดียวกับสัญญา */
        amt:   share,
        files: files
      });
    }

    /* flag ปลายทาง (Q2 สมมติว่า FX Online บันทึกเองตอนยิงงานออก)
       รายการที่จองวันนี้บางส่วนยังส่งไม่ครบ → มีค่า N ให้เห็นบ้าง */
    var fresh = (NOW - b) < 2*D;
    out.push({
      id:'BU'+buPad(i+1,3),
      bookedAt: b.getTime(),
      dateISO: fmtISO(b),
      time: buPad(b.getHours())+':'+buPad(b.getMinutes())+':'+buPad(b.getSeconds()),
      custId: cust.id,
      custName: cust.name,
      contract: contract,
      ccy: cc.c,
      amt: amt,
      type: type,
      spot: spot,
      swap: swap,
      final: spot + swap,
      tenorM: tenorM,
      valueDate: fmtISO(vd),
      maturity: fmtISO(md),
      fwdType: 'P',                                  /* Q1 — ตัวอย่างเป็น P ทุกแถว */
      by: USERS[Math.floor(R()*USERS.length)],
      sentAs400: (fresh && R()<0.35) ? 'N' : 'Y',
      sentMail:  (fresh && R()<0.5)  ? 'N' : 'Y',
      sentEsvc:  (fresh && R()<0.5)  ? 'N' : 'Y',
      reqDoc: BU_REQ_DOCS[R() < 0.7 ? 0 : 1],
      uls: uls
    });
  }
  return out;
}
var BU_ROWS = buSeed();

/* ค่าของ 4 คอลัมน์ Underlying บนแถวเดียว — คั่นด้วย ", " (Q3)
   inv/ccy/amt = 1 ค่าต่อ 1 Underlying · file = ทุกไฟล์ของทุก Underlying เรียงต่อกัน
   raw=true คือรูปแบบสำหรับไฟล์ CSV (ไม่มีตัวคั่นหลักพัน — ใบเดียวจะได้เป็นตัวเลขที่ Excel บวกได้) */
function buUlText(r, field, raw){
  if(field==='file'){
    return r.uls.reduce(function(acc,u){
      return acc.concat(u.files.map(function(f){ return f.name; }));
    }, []).join(', ');
  }
  return r.uls.map(function(u){
    return field==='amt' ? (raw ? u.amt.toFixed(2) : fmt(u.amt,2)) : u[field];
  }).join(', ');
}
/* จำนวนไฟล์ทั้งหมดของสัญญา — ใช้บอกบนปุ่มเปิดโฟลเดอร์ */
function buFileCount(r){
  return r.uls.reduce(function(n,u){ return n + u.files.length; }, 0);
}

/* === state === */
function buDefaultFrom(){
  var n = new Date();
  return fmtISO(new Date(n.getFullYear(), n.getMonth()-3, n.getDate()));   /* ค่าเริ่มต้น: ย้อนหลัง 3 เดือน */
}
function buToday(){ return fmtISO(new Date()); }
/* เพดานย้อนหลัง = 1 ม.ค. ของปีที่แล้ว (ยืนกฎเดียวกับ SA-1285 เพื่อไม่ให้สองหน้าตอบคนละอย่าง) */
function buMinDate(){ return fmtISO(new Date(new Date().getFullYear()-1, 0, 1)); }

function buBlankFilter(){
  return {from:buDefaultFrom(), to:buToday(), cust:'', type:'', ccy:'', contract:''};
}
/* แยก 2 ชุด: DRAFT = ค่าที่กำลังกรอก · F = ค่าที่กดค้นหาแล้ว (ตาราง/สรุปใช้ชุดนี้) */
var BU_F     = buBlankFilter();
var BU_DRAFT = buBlankFilter();
var BU_ERR   = '';
var BU_SORT  = {key:'bookedAt', dir:'asc'};   /* ค่าเริ่มต้นตาม AC-2: เรียงตาม Booking Date/Time */
var BU_SIZES = [10,25,50,100];
var BU_SIZE  = 25;
var BU_PAGE  = 1;
var BU_FOLDER = '';                            /* id ของสัญญาที่กำลังเปิดดูโฟลเดอร์ Underlying (AC-3) */
var BU_TS    = new Date();                     /* เวลาที่ดึงข้อมูลรอบล่าสุด (AC-1 real-time) */
var BU_CR_CUST = '';                           /* ลูกค้าที่เลือกในการ์ดรายงานฝั่งลูกค้า (AC-4) — แยกจากตัวกรองของตาราง */

/* === logic === */

function buRangeError(f){
  if(!f.from || !f.to) return 'กรุณาเลือกช่วงวันที่ทั้ง Date From และ Date To';
  if(f.from > f.to)    return 'Date From ต้องไม่เกิน Date To';
  if(f.from < buMinDate()) return 'เลือกข้อมูลย้อนหลังได้ถึง '+fmtTH(buMinDate())+' เท่านั้น (ต้นปีที่แล้ว)';
  if(f.to > buToday())     return 'เลือกวันที่ในอนาคตไม่ได้ — Date To ต้องไม่เกินวันนี้';
  return '';
}

/* กรอง → เรียง (BU_F ผ่าน validate มาแล้วเสมอ) */
function buQuery(){
  var cno  = BU_F.contract.trim().toLowerCase();
  /* ลูกค้าเป็นช่องกรอกอิสระ — ค้นบางส่วนได้ทั้งรหัสลูกค้าและชื่อบริษัท */
  var cust = BU_F.cust.trim().toLowerCase();
  var out = BU_ROWS.filter(function(r){
    if(r.dateISO < BU_F.from || r.dateISO > BU_F.to) return false;
    if(cust && (r.custId+' '+r.custName).toLowerCase().indexOf(cust) < 0) return false;
    if(BU_F.type && r.type   !== BU_F.type) return false;
    if(BU_F.ccy  && r.ccy    !== BU_F.ccy)  return false;
    if(cno && r.contract.toLowerCase().indexOf(cno) < 0) return false;
    return true;
  });
  var k = BU_SORT.key, sgn = BU_SORT.dir==='asc' ? 1 : -1;
  out.sort(function(a,b){
    var x = a[k], y = b[k];
    if(k==='type'){ x = BU_TYPES[x].label; y = BU_TYPES[y].label; }
    if(x === y) return (a.bookedAt - b.bookedAt) * sgn;   /* tie-break ด้วยเวลาจองเสมอ */
    return (typeof x === 'number' ? x-y : String(x).localeCompare(String(y),'th')) * sgn;
  });
  return out;
}

function buPageInfo(total){
  var pages = Math.max(1, Math.ceil(total/BU_SIZE));
  var page  = Math.min(Math.max(1,BU_PAGE), pages);
  BU_PAGE = page;
  var start = (page-1)*BU_SIZE;
  return {page:page, pages:pages, start:start, end:Math.min(start+BU_SIZE, total), total:total};
}
function buPageList(cur,pages){
  var want = [1, pages, cur-1, cur, cur+1].filter(function(n){ return n>=1 && n<=pages; });
  var uniq = want.filter(function(n,i){ return want.indexOf(n)===i; }).sort(function(a,b){ return a-b; });
  var out = [];
  uniq.forEach(function(n,i){
    if(i>0 && n-uniq[i-1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

/* รายการสกุลเงินที่ระบบรู้จัก = สกุลที่ "มีอยู่ในข้อมูลจริง" ∪ สกุลตั้งต้น
   AC-1 ห้าม hardcode → ทั้งแกนตารางสรุปและตัวเลือกใน dropdown ใช้ฟังก์ชันนี้ตัวเดียวกัน
   สกุลใหม่ที่เข้ามาในข้อมูลจึงโผล่ทั้งสองที่เองโดยไม่ต้องแก้โปรแกรม
   (ที่ยังรวมสกุลตั้งต้นไว้ เพื่อให้เห็นแถวยอด 0 ตอนผลค้นหาแคบ — ไม่ใช่แหล่งที่มาของแกน) */
function buCcyList(){
  var seen = {};
  BU_CCY_SEED.forEach(function(c){ seen[c.c] = 1; });
  BU_ROWS.forEach(function(r){ seen[r.ccy] = 1; });
  return Object.keys(seen).sort();
}

/* AC-1 · ตารางสรุป: สกุลเงิน × Export/Import */
function buSummary(rows){
  var map = {};
  buCcyList().forEach(function(c){ map[c] = {ccy:c, EXP:0, IMP:0, nEXP:0, nIMP:0}; });
  rows.forEach(function(r){
    var s = map[r.ccy];
    s[r.type] += r.amt;
    s['n'+r.type]++;
  });
  return Object.keys(map).sort().map(function(c){ return map[c]; });
}

/* === export: Excel (CSV UTF-8 + BOM) === */
function buCsvCell(v){
  var s = String(v==null ? '' : v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
/* ค่าของ 1 แถวตามลำดับ 24 คอลัมน์ (ใช้ร่วมกันทั้ง CSV และ PDF)
   raw=true สำหรับ CSV — Amount (U) ต้องไม่มีตัวคั่นหลักพัน ไม่งั้น Excel อ่านเป็นข้อความบวกไม่ได้ */
function buExportRow(r, i, raw){
  return [
    i+1, r.dateISO, r.time, r.custId, r.custName, r.contract, r.ccy, r.amt.toFixed(2),
    BU_TYPES[r.type].label, fmtR(r.spot,r.ccy), fmtR(r.swap,r.ccy), fmtR(r.final,r.ccy),
    r.tenorM+'M', r.maturity, r.fwdType, r.by,
    r.sentAs400, r.sentMail, r.sentEsvc, r.reqDoc,
    buUlText(r,'inv'), buUlText(r,'ccy'), buUlText(r,'amt',raw), buUlText(r,'file')
  ];
}
function buExpCols(){
  return BU_COLS.filter(function(c){ return c.exp !== false; });
}
function buCustLabel(){
  return BU_F.cust.trim() || 'ทุกราย';
}

function buExportExcel(){
  var rows = buQuery();
  if(!rows.length){ alert('ไม่มีข้อมูลให้ดาวน์โหลด — กรุณาปรับเงื่อนไขการเรียกรายงาน'); return; }
  var req = new Date();
  var L = [];
  L.push(['รายงานธุรกรรม Forward Contract ผ่าน FX Online (Business User)']);
  L.push(['Date From', BU_F.from, 'Date To', BU_F.to]);
  L.push(['ลูกค้า', buCustLabel(), 'Type of Contract', BU_F.type ? BU_TYPES[BU_F.type].label : 'ทั้งหมด']);
  L.push(['Currency', BU_F.ccy || 'ทั้งหมด', 'Contract No.', BU_F.contract.trim() || 'ทั้งหมด']);
  L.push([]);
  L.push(buExpCols().map(function(c){ return c.label; }));
  rows.forEach(function(r,i){ L.push(buExportRow(r,i,true)); });

  /* ตารางสรุปท้ายไฟล์ — แกนเดียวกับที่แสดงบนจอ */
  L.push([]);
  L.push(['สรุปยอดตามสกุลเงิน (จำนวนเงินสกุลต่างประเทศ)']);
  L.push(['Currency','Export','Import']);
  buSummary(rows).forEach(function(s){
    if(s.EXP || s.IMP) L.push([s.ccy, s.EXP.toFixed(2), s.IMP.toFixed(2)]);
  });
  L.push(['รวมทั้งสิ้น', rows.length+' รายการ']);

  /* ท้ายรายงานตาม AC-2 */
  L.push([]);
  L.push(['Report request date/Time', req.toLocaleString('th-TH')]);
  L.push(['Requested by', BU_USER.name+' ('+BU_USER.id+')', BU_USER.unit]);

  var csv = '﻿' + L.map(function(r){ return r.map(buCsvCell).join(','); }).join('\r\n');
  var a = document.createElement('a');
  a.download = 'BU_Forward_'+BU_F.from+'_ถึง_'+BU_F.to+'.csv';
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* === export: PDF (หน้า print แบบ self-contained — สั่ง "บันทึกเป็น PDF" จากไดอะล็อกพิมพ์) === */
function buEsc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function buReportHtml(rows, req){
  var cols = buExpCols();
  var head = cols.map(function(c){ return '<th'+(c.num?' class="n"':'')+'>'+buEsc(c.label)+'</th>'; }).join('');
  var body = rows.map(function(r,i){
    return '<tr>'+buExportRow(r,i).map(function(v,ci){
      return '<td'+(cols[ci].num?' class="n"':'')+'>'+buEsc(v)+'</td>';
    }).join('')+'</tr>';
  }).join('');
  var sum = buSummary(rows).filter(function(s){ return s.EXP || s.IMP; }).map(function(s){
    return '<tr><td>'+s.ccy+'</td><td class="n">'+fmt(s.EXP,2)+'</td><td class="n">'+fmt(s.IMP,2)+'</td></tr>';
  }).join('');

  return '<!doctype html><html lang="th"><head><meta charset="utf-8">'
  +'<title>BU Forward Report '+BU_F.from+' - '+BU_F.to+'</title><style>'
  +'@page{size:A4 landscape;margin:12mm}'
  +'body{font-family:"Segoe UI",Tahoma,sans-serif;color:#1A1D26;margin:0;padding:24px;background:#F4F6FA}'
  +'.doc{background:#fff;padding:28px 30px;border:1px solid #DDE1E9;border-radius:8px}'
  +'.hd{border-bottom:3px solid #C8102E;padding-bottom:12px;margin-bottom:14px}'
  +'.bank{font-size:18px;font-weight:800;color:#003087}.bank small{display:block;font-size:11px;font-weight:400;color:#6B7280;margin-top:2px}'
  +'h1{font-size:15px;color:#003087;margin:10px 0 4px}'
  +'.meta{font-size:11px;color:#4B5563;line-height:1.8;margin-bottom:14px}'
  +'table{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:16px}'
  +'th{background:#003087;color:#fff;padding:5px 4px;text-align:left;font-weight:600;font-size:8.5px;white-space:nowrap}'
  /* ชื่อไฟล์ Underlying ยาวมากเมื่อมีหลายไฟล์ — ต้องตัดคำ ไม่งั้นดันคอลัมน์ล้นหน้า A4 */
  +'td{padding:4px;border-bottom:1px solid #E5E7EB;vertical-align:top;word-break:break-all}'
  +'th.n,td.n{text-align:right}'
  +'.sum{width:auto;min-width:340px;font-size:11px}.sum th{font-size:10px;padding:6px 12px}.sum td{padding:5px 12px}'
  +'h2{font-size:12px;color:#003087;margin:0 0 6px}'
  +'.ft{font-size:10px;color:#4B5563;line-height:1.9;border-top:1px solid #E5E7EB;padding-top:10px;margin-top:14px}'
  +'.btn{position:fixed;top:16px;right:16px;background:#003087;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}'
  +'@media print{.btn{display:none}body{background:#fff;padding:0}.doc{border:none;padding:0}}'
  +'</style></head><body>'
  +'<button class="btn" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button>'
  +'<div class="doc">'
    +'<div class="hd"><div class="bank">EXIM BANK<small>ธนาคารเพื่อการส่งออกและนำเข้าแห่งประเทศไทย</small></div></div>'
    +'<h1>รายงานธุรกรรม Forward Contract ผ่าน FX Online (Business User)</h1>'
    +'<div class="meta">Date From <strong>'+BU_F.from+'</strong> ถึง Date To <strong>'+BU_F.to+'</strong>'
      +' · ลูกค้า: '+buEsc(buCustLabel())
      +' · Type: '+(BU_F.type ? BU_TYPES[BU_F.type].label : 'ทั้งหมด')
      +' · Currency: '+(BU_F.ccy || 'ทั้งหมด')
      +'<br>เรียงตาม Booking Date / Booking Time · ทั้งหมด '+rows.length+' รายการ</div>'
    +'<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>'
    +'<h2>สรุปยอดตามสกุลเงิน (จำนวนเงินสกุลต่างประเทศ)</h2>'
    +'<table class="sum"><thead><tr><th>Currency</th><th class="n">Export</th><th class="n">Import</th></tr></thead>'
    +'<tbody>'+sum+'</tbody></table>'
    +'<div class="ft">Report request date/Time: <strong>'+req.toLocaleString('th-TH')+'</strong><br>'
      +'Username ที่เรียกรายงาน: <strong>'+buEsc(BU_USER.name)+' ('+BU_USER.id+')</strong> — '+buEsc(BU_USER.unit)+'<br>'
      +'ข้อมูลครอบคลุมเฉพาะธุรกรรมที่ทำผ่าน FX Online<br>'
      +'<strong>เอกสารตัวอย่างสำหรับ prototype เท่านั้น</strong></div>'
  +'</div></body></html>';
}
function buExportPdf(){
  var rows = buQuery();
  if(!rows.length){ alert('ไม่มีข้อมูลให้ออกรายงาน — กรุณาปรับเงื่อนไขการเรียกรายงาน'); return; }
  var w = window.open('', '_blank');
  if(!w){ alert('เบราว์เซอร์บล็อกการเปิดหน้าต่างใหม่ — กรุณาอนุญาต pop-up แล้วลองอีกครั้ง'); return; }
  w.document.write(buReportHtml(rows, new Date()));
  w.document.close();
}

/* === ดาวน์โหลดเอกสารสัญญารายรายการ ===
   หน้า self-contained เปิดแล้วสั่ง print เป็น PDF ได้ (แนวเดียวกับฝั่งลูกค้าใน SA-1285)
   ข้อมูลทุกรายการในหน้านี้ทำผ่าน FX Online อยู่แล้ว จึงโหลดเอกสารได้ทุกแถว */
function buContractHtml(r, req){
  function row(label,value){ return '<tr><th>'+label+'</th><td>'+value+'</td></tr>'; }
  var t = BU_TYPES[r.type];
  var ulRows = r.uls.map(function(u){
    return '<tr><td>'+buEsc(u.inv)+'</td><td>'+u.ccy+'</td><td class="n">'+fmt(u.amt,2)+'</td>'
      +'<td class="n">'+u.files.length+'</td></tr>';
  }).join('');

  return '<!doctype html><html lang="th"><head><meta charset="utf-8">'
  +'<title>Forward Contract '+buEsc(r.contract)+'</title><style>'
  +'body{font-family:"Segoe UI",Tahoma,sans-serif;color:#1A1D26;margin:0;padding:40px;background:#F4F6FA}'
  +'.doc{max-width:780px;margin:0 auto;background:#fff;padding:40px 48px;border:1px solid #DDE1E9;border-radius:8px}'
  +'.hd{border-bottom:3px solid #C8102E;padding-bottom:16px;margin-bottom:6px}'
  +'.bank{font-size:19px;font-weight:800;color:#003087}.bank small{display:block;font-size:11px;font-weight:400;color:#6B7280;margin-top:2px}'
  +'h1{font-size:16px;color:#003087;margin:24px 0 4px}.sub{font-size:12px;color:#6B7280;margin-bottom:20px}'
  +'h2{font-size:13px;color:#003087;margin:22px 0 8px}'
  +'table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}'
  +'th{text-align:left;padding:9px 12px;background:#F4F6FA;color:#4B5563;font-weight:600;width:42%;border-bottom:1px solid #E5E7EB}'
  +'td{padding:9px 12px;border-bottom:1px solid #E5E7EB;font-weight:600;text-align:right}'
  +'td.n{text-align:right}'
  +'.hi td{color:#003087;font-size:15px}'
  /* ตาราง Underlying จัดชิดซ้ายและมีหัวคอลัมน์ปกติ — ไม่ใช้ layout label/value เหมือนตารางบน */
  +'.ul th{width:auto;background:#003087;color:#fff;font-size:11px}'
  +'.ul td{text-align:left;font-weight:400}.ul td.n{text-align:right;font-weight:600}'
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
    +'<div class="sub">เลขที่สัญญา '+buEsc(r.contract)+' · ทำรายการผ่าน FX Online</div>'
    +'<table>'
      +row('รหัสลูกค้า (Cust ID)', r.custId)
      +row('ชื่อลูกค้า (Company Name)', buEsc(r.custName))
      +row('วันที่ทำรายการ (Booking Date/Time)', fmtTH(r.dateISO)+' เวลา '+r.time)
      +row('ประเภทสัญญา (Type of Contract)', t.label+' — '+t.desc)
      +row('สกุลเงิน (Currency)', r.ccy)
      +row('จำนวนเงิน (Amount)', fmt(r.amt,2)+' '+r.ccy)
      +row('Spot Rate', fmtR(r.spot,r.ccy))
      +row('Swap Points', (r.swap>=0?'+':'')+fmtR(r.swap,r.ccy))
      +'<tr class="hi"><th>Final Rate (อัตราแลกเปลี่ยนล่วงหน้า)</th><td>'+fmtR(r.final,r.ccy)+'</td></tr>'
      +row('Tenor', r.tenorM+' เดือน')
      +row('วันที่เริ่มใช้ (Value Date)', fmtTH(r.valueDate))
      +row('วันครบกำหนด (Maturity Date)', fmtTH(r.maturity))
      +row('Forward Type', r.fwdType)
      +row('มูลค่าเทียบเท่าเงินบาท', fmt(r.amt*r.final,2)+' บาท')
      +row('ผู้ทำรายการ (Username ลูกค้า)', buEsc(r.by))
      +row('สถานะส่งต่อระบบ', 'AS400: '+r.sentAs400+' · Email Cfm: '+r.sentMail+' · E-Service: '+r.sentEsvc)
    +'</table>'
    +'<h2>เอกสาร Underlying — '+buEsc(r.reqDoc)+'</h2>'
    +'<table class="ul"><thead><tr><th>Invoice No.</th><th>สกุลเงิน</th><th class="n">จำนวนเงิน</th><th class="n">จำนวนไฟล์</th></tr></thead>'
    +'<tbody>'+ulRows+'</tbody></table>'
    +'<div class="note">เอกสารฉบับนี้ออกจากหน้าจอรายงาน BU เมื่อ '+req.toLocaleString('th-TH')
      +' โดย '+buEsc(BU_USER.name)+' ('+BU_USER.id+')<br>'
      +'ลูกค้ามีภาระผูกพันต้องส่งมอบ/รับมอบเงินตราต่างประเทศตามจำนวนและอัตราที่ระบุ ณ วันครบกำหนดข้างต้น<br>'
      +'<strong>เอกสารตัวอย่างสำหรับ prototype เท่านั้น ไม่มีผลผูกพันทางกฎหมาย</strong></div>'
    +'<div class="sign"><div>ผู้มีอำนาจลงนาม (ลูกค้า)</div><div>ผู้มีอำนาจลงนาม (ธนาคาร)</div></div>'
  +'</div></body></html>';
}

/* ดาวน์โหลดชุดเอกสารของ 1 Underlying เป็น .zip
   prototype ยังไม่ผูกกับที่เก็บไฟล์จริงและไม่มี lib บีบอัด จึงยังไม่ได้ไฟล์จริง —
   แสดงชื่อ .zip กับรายการไฟล์ข้างในให้เห็นว่าจะได้อะไร */
function buUlZipName(r, u){
  /* '/' ในเลขที่สัญญาตั้งเป็นชื่อไฟล์ไม่ได้ — แทนด้วย '-' เฉพาะตอนตั้งชื่อไฟล์ */
  return 'U' + r.contract.replace(/\//g,'-') + '_' + u.inv + '.zip';
}
function buDownloadUlZip(id, ulIdx){
  var r = BU_ROWS.filter(function(x){ return x.id===id; })[0];
  if(!r) return;
  var u = r.uls[ulIdx];
  if(!u) return;
  alert('ดาวน์โหลดชุดเอกสาร Underlying\n\n'
    + buUlZipName(r,u) + '\n'
    + 'สัญญา ' + r.contract + ' · Invoice ' + u.inv + ' · ' + u.ccy + ' ' + fmt(u.amt,2) + '\n\n'
    + 'ไฟล์ข้างใน ' + u.files.length + ' ไฟล์:\n'
    + u.files.map(function(f){ return '  • '+f.name+'  ('+f.upISO+' · '+f.size.toFixed(1)+' MB)'; }).join('\n')
    + '\n\nprototype ยังไม่ผูกกับที่เก็บไฟล์จริง จึงยังไม่ได้ไฟล์ .zip จริง');
}

function buDownloadContract(id){
  var r = BU_ROWS.filter(function(x){ return x.id===id; })[0];
  if(!r) return;
  var a = document.createElement('a');
  /* เลขที่สัญญามี '/' ตั้งเป็นชื่อไฟล์ไม่ได้ — แทนด้วย '-' เฉพาะตอนตั้งชื่อไฟล์ที่โหลด
     (ในเนื้อเอกสารยังแสดงเลขสัญญาเต็มตามสเปก) */
  a.download = r.contract.replace(/\//g,'-')+'.html';
  a.href = URL.createObjectURL(new Blob([buContractHtml(r, new Date())], {type:'text/html;charset=utf-8'}));
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* === render === */

function buTh(c){
  if(c.sortable===false) return '<th style="text-align:'+(c.num?'right':'left')+';white-space:nowrap">'+c.label+'</th>';
  var on = BU_SORT.key===c.key;
  var arrow = on ? (BU_SORT.dir==='asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.35">⇅</span>';
  return '<th class="bu-sort" data-key="'+c.key+'" style="cursor:pointer;text-align:'+(c.num?'right':'left')+';white-space:nowrap'
    +(on?';background:#0041B8':'')+'" title="คลิกเพื่อเรียงลำดับ">'+c.label+arrow+'</th>';
}

/* Y/N ของคอลัมน์ 17–19 — N คือยังส่งไม่สำเร็จ ให้เห็นชัดว่าต้องตาม */
function buYN(v){
  return v==='Y'
    ? '<span class="tag tag-ok">Y</span>'
    : '<span class="tag tag-er">N</span>';
}

function buRow(r,i){
  var t = BU_TYPES[r.type];
  var swapCls = r.swap < 0 ? 'sell' : 'buy';
  var multi = r.uls.length > 1 ? '<span style="color:var(--t3);font-weight:400"> ('+r.uls.length+' ใบ)</span>' : '';
  /* รายชื่อไฟล์ยาวได้มาก (หลาย Underlying × หลายไฟล์) — บนจอตัดด้วย ellipsis แล้วดูเต็มใน tooltip/โฟลเดอร์
     ส่วนไฟล์ Excel/PDF ยังได้ครบทุกชื่อเสมอ */
  var fileTxt = buUlText(r,'file');
  var nFile = buFileCount(r);
  return '<tr>'
    +'<td style="text-align:right;color:var(--t3);font-weight:400">'+(i+1)+'</td>'
    +'<td style="white-space:nowrap;text-align:left;font-weight:400">'+r.dateISO+'</td>'
    +'<td style="text-align:left;font-weight:400;color:var(--t3)">'+r.time+'</td>'
    +'<td style="text-align:left;font-weight:400">'+r.custId+'</td>'
    +'<td style="text-align:left;white-space:nowrap">'+r.custName+'</td>'
    +'<td style="text-align:left;font-weight:600;color:var(--blue);white-space:nowrap">'+r.contract+'</td>'
    +'<td style="text-align:left">'+r.ccy+'</td>'
    +'<td style="text-align:right">'+fmt(r.amt,2)+'</td>'
    +'<td style="text-align:left"><span class="tag '+t.cls+'" title="'+t.desc+'">'+t.label+'</span></td>'
    +'<td style="text-align:right">'+fmtR(r.spot,r.ccy)+'</td>'
    +'<td style="text-align:right" class="'+swapCls+'">'+(r.swap>=0?'+':'')+fmtR(r.swap,r.ccy)+'</td>'
    +'<td style="text-align:right;color:var(--blue)">'+fmtR(r.final,r.ccy)+'</td>'
    +'<td style="text-align:right;white-space:nowrap">'+r.tenorM+'M</td>'
    +'<td style="white-space:nowrap;text-align:left;font-weight:400">'+r.maturity+'</td>'
    +'<td style="text-align:left">'+r.fwdType+'</td>'
    +'<td style="text-align:left;font-weight:400">'+r.by+'</td>'
    +'<td style="text-align:center">'+buYN(r.sentAs400)+'</td>'
    +'<td style="text-align:center">'+buYN(r.sentMail)+'</td>'
    +'<td style="text-align:center">'+buYN(r.sentEsvc)+'</td>'
    +'<td style="text-align:left;font-weight:400;white-space:nowrap">'+r.reqDoc+'</td>'
    +'<td style="text-align:left;font-weight:400;white-space:nowrap">'+buUlText(r,'inv')+multi+'</td>'
    +'<td style="text-align:left;font-weight:400">'+buUlText(r,'ccy')+'</td>'
    +'<td style="text-align:right;font-weight:400">'+buUlText(r,'amt')+'</td>'
    +'<td style="text-align:left;font-weight:400;font-size:11px" title="'+fileTxt.replace(/"/g,'&quot;')+'">'
      +'<div style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+fileTxt+'</div>'
      +(nFile>1?'<span style="color:var(--t3)">รวม '+nFile+' ไฟล์</span>':'')+'</td>'
    +'<td style="text-align:center">'
      +'<button class="btn btn-s bu-folder" data-id="'+r.id+'" style="font-size:11px;padding:4px 10px;white-space:nowrap">'+ic('file')+' เปิดโฟลเดอร์ ('+nFile+')</button>'
    +'</td>'
    +'<td style="text-align:center">'
      +'<button class="btn btn-s bu-dl" data-id="'+r.id+'" style="font-size:11px;padding:4px 10px;white-space:nowrap">'+ic('dl')+' โหลดสัญญา</button>'
    +'</td>'
  +'</tr>';
}

/* AC-1 · ตารางสรุปบนหน้าจอ */
function buSummaryCard(rows){
  var sum = buSummary(rows);
  var body = sum.map(function(s){
    var empty = !s.EXP && !s.IMP;
    var dim = empty ? ';color:var(--t3);font-weight:400' : '';
    return '<tr'+(empty?' style="opacity:.55"':'')+'>'
      +'<td style="text-align:left;font-weight:700">'+s.ccy+'</td>'
      +'<td style="text-align:right'+dim+'">'+fmt(s.EXP,2)+'</td>'
      +'<td style="text-align:right;color:var(--t3);font-weight:400;font-size:11px">'+s.nEXP+' รายการ</td>'
      +'<td style="text-align:right'+dim+'">'+fmt(s.IMP,2)+'</td>'
      +'<td style="text-align:right;color:var(--t3);font-weight:400;font-size:11px">'+s.nIMP+' รายการ</td>'
    +'</tr>';
  }).join('');

  return '<div class="card">'
    +'<div class="card-title" style="justify-content:space-between">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('fx')+' สรุปธุรกรรมตามสกุลเงิน × ประเภทสัญญา</span>'
      +'<span style="display:flex;align-items:center;gap:10px">'
        +'<span style="font-size:11px;font-weight:400;color:var(--t3)">'+ic('clock')+' ข้อมูล ณ '+BU_TS.toLocaleString('th-TH')+'</span>'
        +'<button class="btn btn-s" id="bu-refresh" style="font-size:11px;padding:5px 12px">'+ic('refresh')+' โหลดข้อมูลล่าสุด</button>'
      +'</span>'
    +'</div>'
    +'<div style="overflow-x:auto"><table class="rate-table" style="font-size:12px">'
      +'<thead><tr>'
        +'<th style="text-align:left">Currency</th>'
        +'<th style="text-align:right">Export</th><th style="text-align:right">จำนวน</th>'
        +'<th style="text-align:right">Import</th><th style="text-align:right">จำนวน</th>'
      +'</tr></thead><tbody>'+body+'</tbody></table></div>'
    /* กล่องหมายเหตุอธิบายข้อสมมติ/open question ถอดออกแล้ว — ไม่โชว์ใน prototype
       (ข้อสมมติทั้งหมดยังบันทึกไว้ที่ส่วนหัวของไฟล์นี้) */
  +'</div>';
}

/* AC-3 · โฟลเดอร์เอกสาร Underlying ของสัญญาที่เลือก — แสดงเป็น modal
   จัดกลุ่มตาม Invoice No. (1 Underlying = 1 invoice) แล้วลิสต์ไฟล์ของแต่ละ invoice ข้างใต้ */
function buFolderModal(){
  var r = BU_ROWS.filter(function(x){ return x.id===BU_FOLDER; })[0];
  if(!r) return '';

  var groups = r.uls.map(function(u, gi){
    var files = u.files.map(function(f){
      return '<tr>'
        +'<td style="text-align:left;font-weight:600;color:var(--blue);word-break:break-all">'+ic('file')+' '+f.name+'</td>'
        +'<td style="text-align:left;font-weight:400;white-space:nowrap">'+f.upISO+'</td>'
        +'<td style="text-align:right;font-weight:400;color:var(--t3);white-space:nowrap">'+f.size.toFixed(1)+' MB</td>'
      +'</tr>';
    }).join('');

    return '<div style="margin-bottom:'+(gi===r.uls.length-1?'0':'16px')+'">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;'
        +'background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rs);padding:9px 12px;margin-bottom:8px">'
        +'<span style="font-size:13px;font-weight:700;color:var(--t1)">'+ic('doc')+' Invoice No. '+u.inv+'</span>'
        +'<span style="display:flex;align-items:center;gap:12px">'
          +'<span style="font-size:12px;color:var(--t2)">'+u.ccy+' <strong>'+fmt(u.amt,2)+'</strong>'
            +' · <span style="color:var(--t3)">'+u.files.length+' ไฟล์</span></span>'
          +'<button class="btn btn-s bu-ulzip" data-id="'+r.id+'" data-ul="'+gi+'" style="font-size:11px;padding:4px 10px;white-space:nowrap">'
            +ic('dl')+' โหลด .zip</button>'
        +'</span>'
      +'</div>'
      +'<table class="rate-table" style="font-size:12px">'
        +'<thead><tr><th style="text-align:left">ชื่อไฟล์</th>'
        +'<th style="text-align:left">วันที่ upload</th><th style="text-align:right">ขนาด</th></tr></thead>'
        +'<tbody>'+files+'</tbody></table>'
    +'</div>';
  }).join('');

  return '<div class="modal-ov show" id="bu-folder-ov">'
    +'<div style="background:#fff;border-radius:var(--r);width:92%;max-width:820px;max-height:88vh;display:flex;flex-direction:column;'
      +'box-shadow:0 8px 40px rgba(0,0,0,.25);overflow:hidden">'

      +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;'
        +'padding:18px 24px 14px;border-bottom:1px solid var(--bdr)">'
        +'<div>'
          +'<div style="font-size:16px;font-weight:800;color:var(--blue);display:flex;align-items:center;gap:8px">'
            +ic('file')+' โฟลเดอร์เอกสาร Underlying</div>'
          +'<div style="font-size:12px;color:var(--t3);margin-top:4px;line-height:1.7">'
            +'สัญญา <strong style="color:var(--t2)">'+r.contract+'</strong> · '+r.custId+' · '+r.custName+'<br>'
            +r.ccy+' '+fmt(r.amt,2)+' · '+BU_TYPES[r.type].label
            +' · Required Document: <strong style="color:var(--t2)">'+r.reqDoc+'</strong>'
            +' · <strong style="color:var(--t2)">'+r.uls.length+'</strong> Underlying / <strong style="color:var(--t2)">'+buFileCount(r)+'</strong> ไฟล์</div>'
        +'</div>'
        +'<button class="btn btn-s" id="bu-folder-close" style="font-size:11px;padding:5px 12px;flex:0 0 auto">'+ic('x')+' ปิด</button>'
      +'</div>'

      /* กล่องหมายเหตุอธิบายข้อสมมติ/open question ถอดออกแล้ว — ไม่โชว์ใน prototype */
      +'<div style="padding:18px 24px;overflow-y:auto">'+groups+'</div>'

    +'</div>'
  +'</div>';
}

/* AC-4 · ทางเข้ารายงานฝั่งลูกค้า (SA-1285) — BU เลือกลูกค้าได้ทุกราย
   ปิดไว้ก่อน: ไม่ถูกเรียกใน hBU1286() เพราะยังไม่อยู่ใน go-live 1 (พึ่ง SA-1285)
   เปิดกลับได้โดยใส่ +buCustReportCard() กลับเข้าไปใน return ของ hBU1286() */
function buCustReportCard(){
  var opts = '<option value="">— เลือกลูกค้า —</option>'
    + BU_CUSTS.map(function(c){
        return '<option value="'+c.id+'"'+(BU_CR_CUST===c.id?' selected':'')+'>'+c.id+' · '+c.name+'</option>';
      }).join('');

  return '<div class="card">'
    +'<div class="card-title">'+ic('doc')+' รายงานฝั่งลูกค้า (SA-1285) — BU เรียกดูได้ทุกราย</div>'
    +'<div class="row" style="margin-bottom:10px;align-items:flex-end">'
      +'<div class="fg" style="flex:2"><label class="fl">ลูกค้า</label><select id="bu-cr-cust">'+opts+'</select></div>'
      +'<div style="display:flex;gap:8px;flex:0 0 auto">'
        +'<button class="btn btn-s bu-cr" data-r="turnover">'+ic('doc')+' รายงาน Turnover</button>'
        +'<button class="btn btn-s bu-cr" data-r="contract">'+ic('dl')+' เอกสาร Forward Contract</button>'
        /* MTM ยังไม่อยู่ใน go-live 1 — ปิดไว้ก่อน ไม่ผูก handler */
        +'<button class="btn btn-s" disabled style="opacity:.45;cursor:not-allowed" title="ยังไม่มีใน go-live 1">'+ic('fx')+' รายงาน MTM</button>'
      +'</div>'
    +'</div>'
    +'<div class="hint">'+ic('info')+' <strong>รายงาน MTM ปิดไว้ก่อน — ยังไม่อยู่ใน go-live 1</strong> '
      +'· ส่วนนี้พึ่งงาน SA-1285 — prototype ยังผูกลูกค้าตัวอย่างรายเดียว '
      +'จึงยังสลับตามลูกค้าที่เลือกไม่ได้ · และ<strong>สิทธิ์การเข้าถึงของ BU</strong> (เห็นทุกราย หรือเฉพาะลูกค้าที่ดูแล) ยังไม่เคาะ (open question ข้อ 7)</div>'
  +'</div>';
}

function buHead(){
  return '<div style="font-size:20px;font-weight:700;color:var(--blue);margin-bottom:2px">SA-1286 · หน้าจอเรียกดูรายงานของ Business User</div>'
    +'<div style="font-size:13px;color:var(--t3);margin-bottom:16px">ธุรกรรม Forward Contract ที่ลูกค้าทำผ่าน FX Online · '+BU_USER.name+' ('+BU_USER.unit+')</div>';
}

function hBU1286(){
  var ccyOpts = '<option value="">ทุกสกุลเงิน</option>'
    + buCcyList().map(function(c){ return '<option value="'+c+'"'+(BU_DRAFT.ccy===c?' selected':'')+'>'+c+'</option>'; }).join('');
  var typeOpts = '<option value="">ทุกประเภท</option>'
    + Object.keys(BU_TYPES).map(function(k){
        return '<option value="'+k+'"'+(BU_DRAFT.type===k?' selected':'')+'>'+BU_TYPES[k].label+'</option>';
      }).join('');
  var filters = '<div class="card">'
    +'<div class="card-title">'+ic('cal')+' เงื่อนไขการเรียกรายงาน</div>'
    +'<div class="row">'
      +'<div class="fg"><label class="fl">Date From <span class="req">*</span></label>'
        +'<input type="date" id="bu-from" min="'+buMinDate()+'" max="'+buToday()+'" value="'+BU_DRAFT.from+'"></div>'
      +'<div class="fg"><label class="fl">Date To <span class="req">*</span></label>'
        +'<input type="date" id="bu-to" min="'+buMinDate()+'" max="'+buToday()+'" value="'+BU_DRAFT.to+'"></div>'
      +'<div class="fg" style="flex:2"><label class="fl">ลูกค้า</label>'
        +'<input type="text" id="bu-cust" autocomplete="off" placeholder="รหัสลูกค้า หรือ ชื่อบริษัท (พิมพ์บางส่วนได้ · เว้นว่าง = ทุกราย)" value="'+BU_DRAFT.cust.replace(/"/g,'&quot;')+'"></div>'
    +'</div>'
    +'<div class="row" style="margin-bottom:0;align-items:flex-end">'
      +'<div class="fg"><label class="fl">Type of Contract</label>'
        +'<select id="bu-type">'+typeOpts+'</select></div>'
      +'<div class="fg"><label class="fl">Currency</label>'
        +'<select id="bu-ccy">'+ccyOpts+'</select></div>'
      +'<div class="fg" style="flex:2"><label class="fl">Contract No.</label>'
        +'<input type="text" id="bu-contract" placeholder="เช่น FOP0100555/26 (พิมพ์บางส่วนได้)" value="'+BU_DRAFT.contract.replace(/"/g,'&quot;')+'"></div>'
      +'<div style="display:flex;gap:8px;flex:0 0 auto;margin-left:auto">'
        +'<button class="btn btn-s" id="bu-reset">'+ic('refresh')+' ล้างเงื่อนไข</button>'
        +'<button class="btn btn-p" id="bu-search">'+ic('doc')+' เรียกรายงาน</button>'
      +'</div>'
    +'</div>'
    +'<div class="hint" style="margin-top:10px">'+ic('info')+' เลือกข้อมูลย้อนหลังได้ถึง '+fmtTH(buMinDate())+' (ต้นปีที่แล้ว) '
      +'· รายงานครอบคลุมเฉพาะธุรกรรมที่ทำผ่าน <strong>FX Online</strong> ไม่รวมรายการที่ทำผ่านเจ้าหน้าที่/สาขา</div>'
  +'</div>';

  if(BU_ERR){
    return '<div class="sc">'+buHead()+filters
      +'<div class="alert err">'+ic('warn')+'<div>'+BU_ERR+'</div></div></div>';
  }

  var rows = buQuery();
  var pg = buPageInfo(rows.length);
  var body = rows.length
    ? rows.slice(pg.start, pg.end).map(function(r,i){ return buRow(r, pg.start+i); }).join('')
    : '<tr><td colspan="'+BU_COLS.length+'" style="text-align:center;color:var(--t3);padding:28px;font-weight:400">ไม่พบรายการตามเงื่อนไขที่เลือก</td></tr>';

  var sortLbl = (BU_COLS.filter(function(c){return c.key===BU_SORT.key;})[0]||{}).label || 'Booking Date';
  var countTxt = rows.length
    ? 'แสดง '+(pg.start+1)+'–'+pg.end+' จาก '+rows.length+' รายการ'
    : 'ไม่พบรายการ';

  var table = '<div class="card">'
    +'<div class="card-title" style="justify-content:space-between">'
      +'<span style="display:flex;align-items:center;gap:8px">'+ic('doc')+' รายการ Forward Contract (FX Online)</span>'
      +'<span style="display:flex;align-items:center;gap:12px">'
        +'<span style="font-size:11px;font-weight:400;color:var(--t3)">'+countTxt+' · เรียงตาม '+sortLbl+' ('+(BU_SORT.dir==='asc'?'น้อย→มาก':'มาก→น้อย')+')</span>'
        +'<button class="btn btn-s" id="bu-pdf" style="font-size:11px;padding:5px 12px">'+ic('file')+' PDF</button>'
        +'<button class="btn btn-s" id="bu-excel" style="font-size:11px;padding:5px 12px">'+ic('dl')+' Excel</button>'
      +'</span>'
    +'</div>'
    /* กล่องหมายเหตุอธิบายข้อสมมติ/open question ถอดออกแล้ว — ไม่โชว์ใน prototype */
    +'<div style="overflow-x:auto"><table class="rate-table" style="font-size:12px;min-width:2750px">'
      +'<thead><tr>'+BU_COLS.map(buTh).join('')+'</tr></thead>'
      +'<tbody>'+body+'</tbody>'
    +'</table></div>'
    +buPager(pg)
  +'</div>';

  /* buCustReportCard() (AC-4 · รายงานฝั่งลูกค้า SA-1285) ปิดไว้ก่อน — ยังไม่อยู่ใน go-live 1 */
  return '<div class="sc">'+buHead()+filters+buSummaryCard(rows)+table+buFolderModal()+'</div>';
}

/* แถบล่างตาราง: เลือกจำนวนต่อหน้า (ซ้าย) + ปุ่มเปลี่ยนหน้า (ขวา) */
function buPager(pg){
  var sizeSel = '<span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--t3)">'
    +'<span>แสดงหน้าละ</span>'
    +'<select id="bu-size" style="width:auto;padding:5px 26px 5px 10px;font-size:12px">'
      + BU_SIZES.map(function(n){ return '<option value="'+n+'"'+(BU_SIZE===n?' selected':'')+'>'+n+'</option>'; }).join('')
    +'</select>'
    +'<span>รายการ</span>'
  +'</span>';

  if(pg.total===0){
    return '<div style="display:flex;align-items:center;padding-top:14px;margin-top:4px;border-top:1px solid var(--bdr)">'+sizeSel+'</div>';
  }

  function btn(label,page,opt){
    opt = opt||{};
    if(opt.gap) return '<span style="padding:0 4px;color:var(--t3);font-size:12px">…</span>';
    return '<button class="btn btn-s bu-page" data-page="'+page+'"'+(opt.disabled?' disabled':'')
      +' style="font-size:12px;padding:5px 11px;min-width:34px;justify-content:center'
      +(opt.current?';background:var(--blue);color:#fff;border-color:var(--blue)':'')
      +(opt.disabled?';opacity:.4;cursor:not-allowed':'')+'">'+label+'</button>';
  }

  var nums = buPageList(pg.page, pg.pages).map(function(n){
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

/* กดเรียกรายงาน: validate DRAFT ก่อน · ผ่านแล้วจึง apply เข้า BU_F */
function buSearch(){
  BU_ERR = buRangeError(BU_DRAFT);
  if(!BU_ERR){
    BU_F = {from:BU_DRAFT.from, to:BU_DRAFT.to, cust:BU_DRAFT.cust, type:BU_DRAFT.type, ccy:BU_DRAFT.ccy, contract:BU_DRAFT.contract};
    BU_PAGE = 1;
    BU_FOLDER = '';       /* ผลค้นชุดใหม่ — โฟลเดอร์ที่เปิดค้างไว้อาจไม่อยู่ในผลแล้ว */
    BU_TS = new Date();
  }
  render();
}

function bindBU1286(){
  function $(id){ return document.getElementById(id); }
  function on(id,ev,fn){ var e=$(id); if(e) e.addEventListener(ev,fn); }

  /* แก้ฟอร์ม = เขียนลง DRAFT อย่างเดียว ไม่ render (ตารางยังคงผลค้นหาเดิมไว้) */
  on('bu-from','change',    function(){ BU_DRAFT.from=this.value; });
  on('bu-to','change',      function(){ BU_DRAFT.to=this.value; });
  on('bu-cust','input',     function(){ BU_DRAFT.cust=this.value; });
  on('bu-cust','keydown',   function(e){ if(e.key==='Enter'){ e.preventDefault(); buSearch(); } });
  on('bu-type','change',    function(){ BU_DRAFT.type=this.value; });
  on('bu-ccy','change',     function(){ BU_DRAFT.ccy=this.value; });
  on('bu-contract','input', function(){ BU_DRAFT.contract=this.value; });
  on('bu-contract','keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); buSearch(); } });

  on('bu-search','click',buSearch);
  on('bu-reset','click',function(){
    BU_F=buBlankFilter(); BU_DRAFT=buBlankFilter(); BU_ERR='';
    BU_SORT={key:'bookedAt', dir:'asc'}; BU_PAGE=1; BU_FOLDER='';
    render();
  });

  /* AC-1 real-time — prototype ไม่มี backend จึงแค่ประทับเวลาที่ดึงข้อมูลรอบล่าสุด */
  on('bu-refresh','click',function(){ BU_TS=new Date(); render(); });

  on('bu-excel','click',buExportExcel);
  on('bu-pdf','click',buExportPdf);

  on('bu-size','change',function(){ BU_SIZE=parseInt(this.value,10); BU_PAGE=1; render(); });
  document.querySelectorAll('.bu-page').forEach(function(b){
    b.addEventListener('click',function(){
      if(this.disabled) return;
      BU_PAGE=parseInt(this.dataset.page,10); render();
    });
  });

  /* AC-3 · เปิด/ปิด modal โฟลเดอร์เอกสาร Underlying */
  function closeFolder(){ BU_FOLDER=''; render(); }
  document.querySelectorAll('.bu-folder').forEach(function(b){
    b.addEventListener('click',function(){ BU_FOLDER=this.dataset.id; render(); });
  });
  on('bu-folder-close','click',closeFolder);
  /* คลิกพื้นหลังนอกกล่อง = ปิด (คลิกในกล่องต้องไม่ปิด) */
  on('bu-folder-ov','click',function(e){ if(e.target===this) closeFolder(); });

  /* ปุ่มโหลด .zip ของแต่ละ Invoice ใน modal */
  document.querySelectorAll('.bu-ulzip').forEach(function(b){
    b.addEventListener('click',function(){
      buDownloadUlZip(this.dataset.id, parseInt(this.dataset.ul,10));
    });
  });

  /* ปุ่มโหลดเอกสารสัญญารายรายการ */
  document.querySelectorAll('.bu-dl').forEach(function(b){
    b.addEventListener('click',function(){ buDownloadContract(this.dataset.id); });
  });

  /* AC-4 · ทางเข้ารายงานฝั่งลูกค้า — ตัวเลือกนี้ไม่ยุ่งกับตัวกรองของตารางด้านบน
     ตอนนี้การ์ดไม่ถูก render จึงหา element ไม่เจอและ querySelectorAll คืนค่าว่าง (ไม่มีผลอะไร)
     เก็บ bind ไว้คู่กับ buCustReportCard() เพื่อให้เปิดกลับแล้วใช้งานได้ทันที */
  on('bu-cr-cust','change',function(){ BU_CR_CUST=this.value; });
  document.querySelectorAll('.bu-cr').forEach(function(b){
    b.addEventListener('click',function(){
      if(!BU_CR_CUST){ alert('กรุณาเลือกลูกค้าก่อน'); return; }
      var c = BU_CUSTS.filter(function(x){ return x.id===BU_CR_CUST; })[0];
      if(this.dataset.r==='turnover'){
        alert('เปิดรายงาน Turnover ของ '+c.name+'\n\nprototype ยังผูกลูกค้าตัวอย่างรายเดียว (SA-1285) — จะพาไปหน้ารายงาน Turnover ที่มีอยู่');
        goPhase(12);
        return;
      }
      alert('ยังไม่มีใน prototype — เอกสาร Forward Contract เป็นของ SA-1285 · ลูกค้า '+c.name);
    });
  });

  /* คลิกหัวคอลัมน์เพื่อ sort (คลิกซ้ำ = สลับทิศ) */
  document.querySelectorAll('.bu-sort').forEach(function(th){
    th.addEventListener('click',function(){
      var k=this.dataset.key;
      if(BU_SORT.key===k) BU_SORT.dir = (BU_SORT.dir==='asc'?'desc':'asc');
      else BU_SORT={key:k, dir:'asc'};
      BU_PAGE=1;
      render();
    });
  });
}
