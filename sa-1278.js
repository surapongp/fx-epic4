/* =============================================================================
 * SA-1278 — tab "SA-1278" (phase 10)
 * "การตรวจสอบหรือทำรายการ Forward Contract เมื่อระบบมีปัญหา และ/หรือรายการไม่ถูกส่งไป AS400"
 *
 * โจทย์ (As a IT/BU):
 *   - เรียกดูรายการจอง Forward Contract ที่ลูกค้าจองผ่าน App "ทุกรายการ" + สถานะการส่ง AS400
 *   - เมื่อระบบขัดข้อง ดูได้ว่ารายการไหน "ค้าง" อยู่ และค้างเพราะอะไร
 *   - จัดการรายการที่ค้าง ให้เดินต่อจนสุดทาง (ส่ง/ตรวจสอบ AS400 · ปิดรายการ) end-to-end + ออกรายงาน
 *
 * โมเดล state (2 ขั้น) — ปรับตาม BU + พฤติกรรมจริงของ AS400 API:
 *   * customer self-service: ลูกค้า "จอง + ยืนยัน + ออกสัญญา" ใน transaction เดียว (atomic · ไม่มี draft)
 *   * AS400 API เป็น synchronous "ตอบผลทันที" → ไม่มีสถานะ "รอ ack" · เรียกแล้วรู้ผลเลย
 *   * รายการจึงมีแค่ 2 สถานะพัก:
 *       0 ออกสัญญาแล้ว (App)  — App เสร็จ · ยังไม่เข้า AS400 (กำลังจะส่ง / ส่งแล้วยังไม่สำเร็จ)
 *       1 เสร็จสมบูรณ์         — AS400 ตอบ success · รายการเข้า core แล้ว · ปิดรายการ
 *   * "ค้าง" เกิดที่รอยต่อ App -> AS400 (ตรงชื่อ ticket) แยก 2 ชนิดตามความเสี่ยง:
 *       error   — ระบบไม่รับ (connection refused / maintenance) · "ยังไม่เข้า core" แน่นอน → ส่งใหม่ได้ปลอดภัย
 *       indoubt — timeout ไม่ได้คำตอบ · "ไม่รู้ว่าเข้า core หรือยัง" → ต้องตรวจสอบ (reconcile) ก่อน กันสัญญาซ้ำ
 *
 * ไฟล์นี้ประกอบด้วย:
 *   - state/data : SA78_STAGES, SA78_STUCK, SA78_TXNS (+ seed), SA78_FILTER, SA78_OPEN
 *   - logic      : sa78Find/sa78Stats/sa78Send/sa78Reconcile/sa78Recover(+AllStuck)/sa78SimOutage/sa78Export
 *   - render     : sa78StageBadge/sa78Stepper/sa78Row/sa78Detail/hSA1278/bindSA1278
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   fmt(), fmtR(), fmtTH(), ic(), render()
 * จุดเชื่อม: render() ใน HTML เรียก hSA1278()/bindSA1278() เมื่อ P.phase===10
 * ============================================================================= */

/* === ขั้นตอนของไปป์ไลน์ (index 0..1 = สถานะที่รายการ "ไปถึงแล้ว") === */
var SA78_STAGES=[
  {key:'issued', label:'ออกสัญญาแล้ว (App)', color:'var(--inf)'},  /* 0 : ลูกค้า self-service จอง+ยืนยัน+ออกสัญญา (atomic) · รอเข้า AS400 */
  {key:'done',   label:'เสร็จสมบูรณ์',        color:'var(--ok)'}    /* 1 : AS400 ตอบ success · เข้า core · ปิดรายการ */
];
/* ชนิดการค้าง (เกิดที่รอยต่อ App -> AS400 เท่านั้น — AS400 ตอบทันที จึงไม่มี "รอ ack") */
var SA78_STUCK={
  error:  {label:'ส่งไม่สำเร็จ',        tag:'tag-er', hint:'ระบบไม่รับรายการ (เชื่อมต่อไม่ได้/ปิดปรับปรุง) — ยังไม่เข้า core · ส่งใหม่ได้ปลอดภัย'},
  indoubt:{label:'ไม่ทราบผล (timeout)', tag:'tag-wn', hint:'ส่งไปแล้วแต่ไม่ได้คำตอบ — ไม่รู้ว่าเข้า core แล้วหรือยัง · ต้องตรวจสอบก่อนส่งซ้ำ กันสัญญาซ้ำ'}
};

/* AS400 ref (deterministic จากเลข FWD ท้าย 4 หลัก) */
function sa78Ref(t){return 'AS4-'+(88000+(parseInt(t.ref.slice(-4),10)||0));}

/* สร้าง log เริ่มต้นจากสถานะ seed */
function sa78BuildLog(o){
  var log=[{ts:o.bookedAt,note:'ลูกค้าจอง + ออกสัญญาอัตโนมัติ (self-service)',ok:true,by:'ลูกค้า / App'}];
  var t=o.bookedAt+1800000;
  if(o.stage>=1){
    log.push({ts:t,note:'ส่งเข้า AS400 สำเร็จ (Ref '+o.as400Ref+') — ปิดรายการสมบูรณ์',ok:true,by:'ระบบ'});
  }else if(o.stuck){
    log.push({ts:t,note:(o.stuckType==='indoubt'?'ส่งเข้า AS400 — หมดเวลา ไม่ได้รับคำตอบ · ':'ส่งเข้า AS400 ไม่สำเร็จ · ')+o.error,ok:false,by:'ระบบ'});
  }
  return log;
}
/* seed รายการจอง (mock) — กระจายทุกสถานะ · การค้างอยู่ที่รอยต่อ App -> AS400 (error / indoubt) */
function sa78Seed(){
  var NOW=Date.now(), D=86400000;
  function mk(o){
    o.stuck=!!o.stuck; o.stuckType=o.stuck?(o.stuckType||'error'):''; o.error=o.error||''; o.coreHasIt=!!o.coreHasIt;
    o.as400Ref=(o.stage>=1?sa78Ref(o):'');
    o.log=sa78BuildLog(o);
    return o;
  }
  return [
    mk({id:'T01',ref:'FWD-2026-100001',company:'บจ. ไทย เอ็กซ์พอร์ต',custcode:'C00124567',side:'sell',ccy:'USD',amt:500000,rate:36.4200,maturity:'2026-09-01',bookedAt:NOW-6*D,stage:1}),
    mk({id:'T02',ref:'FWD-2026-100002',company:'บจ. เอเชีย เทรดดิ้ง',custcode:'C00987654',side:'buy', ccy:'EUR',amt:200000,rate:39.6800,maturity:'2026-07-15',bookedAt:NOW-6*D,stage:1}),
    mk({id:'T03',ref:'FWD-2026-100010',company:'บจ. สยาม อะกรี ฟู้ดส์',custcode:'C00220034',side:'sell',ccy:'USD',amt:750000,rate:36.3000,maturity:'2026-08-20',bookedAt:NOW-2*D,stage:0,stuck:true,stuckType:'indoubt',coreHasIt:true, error:'หมดเวลาระหว่างรอผลตอบกลับจาก AS400 (read timeout)'}),
    mk({id:'T04',ref:'FWD-2026-100011',company:'บจ. โกลบอล ฟู้ดส์',custcode:'C00330077',side:'buy', ccy:'CNY',amt:3500000,rate:5.0200,maturity:'2026-10-05',bookedAt:NOW-2*D,stage:0,stuck:true,stuckType:'error',error:'เชื่อมต่อ AS400 ไม่ได้ (connection refused)'}),
    mk({id:'T05',ref:'FWD-2026-100012',company:'บจ. เมทัล เวิร์คส์',custcode:'C00441120',side:'sell',ccy:'USD',amt:1200000,rate:36.2500,maturity:'2026-09-30',bookedAt:NOW-1*D,stage:0,stuck:true,stuckType:'indoubt',coreHasIt:false,error:'ส่งไปแล้วแต่ไม่ได้รับผลตอบกลับ (timeout)'}),
    mk({id:'T06',ref:'FWD-2026-100013',company:'บจ. ปาล์ม ออยล์ ไทย',custcode:'C00552210',side:'buy', ccy:'USD',amt:300000,rate:36.4000,maturity:'2026-07-25',bookedAt:NOW-5*3600000,stage:0}),
    mk({id:'T07',ref:'FWD-2026-100014',company:'บจ. เท็กซ์ไทล์ เอเชีย',custcode:'C00663301',side:'sell',ccy:'EUR',amt:450000,rate:39.5000,maturity:'2026-08-10',bookedAt:NOW-8*3600000,stage:0}),
    mk({id:'T08',ref:'FWD-2026-100015',company:'บจ. อิเล็กทรอนิกส์ พาร์ท',custcode:'C00774412',side:'buy', ccy:'USD',amt:900000,rate:36.1500,maturity:'2026-09-12',bookedAt:NOW-1*D,stage:0}),
    mk({id:'T09',ref:'FWD-2026-100016',company:'บจ. เจมส์ แอนด์ จิวเวลรี่',custcode:'C00885523',side:'sell',ccy:'USD',amt:250000,rate:36.3800,maturity:'2026-08-05',bookedAt:NOW-3*D,stage:0,stuck:true,stuckType:'error',error:'core banking ปิดปรับปรุง (maintenance)'})
  ];
}
var SA78_TXNS=sa78Seed();
var SA78_FILTER={q:'',stage:'',stuckOnly:false};   /* ตัวกรอง: ค้นหา + สถานะ + เฉพาะที่ค้าง */
var SA78_OPEN=null;                                 /* id รายการที่เปิด modal รายละเอียด */

/* === logic === */
function sa78Find(id){for(var i=0;i<SA78_TXNS.length;i++)if(SA78_TXNS[i].id===id)return SA78_TXNS[i];return null;}
function sa78LastTs(t){return t.log.length?t.log[t.log.length-1].ts:t.bookedAt;}
var SA78_DONE=SA78_STAGES.length-1;   /* index สถานะสุดทาง (เสร็จสมบูรณ์) */
/* สรุปจำนวนตามสถานะ + จำนวนที่ค้าง (แยก error / indoubt) */
function sa78Stats(){
  var st={perStage:SA78_STAGES.map(function(){return 0;}),stuck:0,stuckError:0,stuckIndoubt:0,done:0,pending:0,total:SA78_TXNS.length};
  SA78_TXNS.forEach(function(t){
    st.perStage[t.stage]++;
    if(t.stuck){st.stuck++; if(t.stuckType==='indoubt')st.stuckIndoubt++; else st.stuckError++;}
    if(t.stage>=SA78_DONE)st.done++; else st.pending++;
  });
  return st;
}
/* ปิดรายการเป็น "เสร็จสมบูรณ์" + ใส่ AS400 ref + เคลียร์สถานะค้าง (ไม่ render — ให้ผู้เรียก render) */
function sa78Close(t,note){
  if(!t.as400Ref)t.as400Ref=sa78Ref(t);
  t.stage=SA78_DONE; t.stuck=false; t.stuckType=''; t.error='';
  t.log.push({ts:Date.now(),note:note,ok:true,by:'IT Recovery'});
}
/* ส่งเข้า AS400 (API ตอบทันที) — ใช้กับรายการปกติ และ resend กรณี error ที่ "ยังไม่เข้า core" */
function sa78Send(id){
  var t=sa78Find(id); if(!t||t.stage>=SA78_DONE)return;
  sa78Close(t,'ส่งเข้า AS400 สำเร็จ (Ref '+sa78Ref(t)+') — ปิดรายการสมบูรณ์');
}
/* ตรวจสอบ (reconcile) รายการ in-doubt: ถาม AS400 ก่อนว่ามีรายการนี้แล้วหรือยัง แล้วจึงตัดสินใจ — กันสัญญาซ้ำ */
function sa78Reconcile(id){
  var t=sa78Find(id); if(!t||t.stage>=SA78_DONE)return;
  if(t.coreHasIt)
    sa78Close(t,'ตรวจสอบ AS400: พบรายการ (Ref '+sa78Ref(t)+') อยู่ใน core แล้ว → ปิดรายการโดยไม่ส่งซ้ำ (กันสัญญาซ้ำ)');
  else
    sa78Close(t,'ตรวจสอบ AS400: ไม่พบรายการใน core → ส่งใหม่สำเร็จ (Ref '+sa78Ref(t)+') · ปิดรายการ');
}
/* กู้รายการ 1 รายการ ตามชนิดของมัน: in-doubt -> reconcile, ที่เหลือ -> ส่ง/ส่งใหม่ (ไม่ render — ให้ผู้เรียก render) */
function sa78Recover(id){
  var t=sa78Find(id); if(!t)return;
  if(t.stuck&&t.stuckType==='indoubt')sa78Reconcile(id); else sa78Send(id);
}
/* กู้รายการที่ "ค้าง" ทั้งหมด — in-doubt route ผ่าน reconcile เสมอ (ห้าม resend ทื่อ เพราะเสี่ยงสัญญาซ้ำ) */
function sa78RecoverAllStuck(){
  var stuck=SA78_TXNS.filter(function(t){return t.stuck;});
  if(!stuck.length){alert('ไม่มีรายการที่ค้างอยู่ในขณะนี้');return;}
  var ni=stuck.filter(function(t){return t.stuckType==='indoubt';}).length, ne=stuck.length-ni;
  if(!confirm('ดำเนินการรายการค้างทั้งหมด '+stuck.length+' รายการ?\n• ส่งไม่สำเร็จ '+ne+' รายการ → ส่งใหม่\n• ไม่ทราบผล/timeout '+ni+' รายการ → ตรวจสอบกับ AS400 ก่อน (กันสัญญาซ้ำ)'))return;
  stuck.forEach(function(t){sa78Recover(t.id);});
  render();
}
/* จำลองเหตุระบบขัดข้อง — สุ่มทำให้รายการที่ยังไม่จบบางรายการค้างที่รอยต่อ AS400 (error หรือ indoubt) */
function sa78SimOutage(){
  var cases=[
    {type:'error',  msg:'เชื่อมต่อ AS400 ไม่ได้ (connection refused)'},
    {type:'error',  msg:'core banking ปิดปรับปรุง (maintenance)'},
    {type:'indoubt',msg:'หมดเวลา ไม่ได้รับคำตอบจาก AS400 (read timeout)'},
    {type:'indoubt',msg:'ส่งไปแล้วแต่ผลตอบกลับหมดเวลา'}
  ];
  var cand=SA78_TXNS.filter(function(t){return !t.stuck&&t.stage<SA78_DONE;});
  if(!cand.length){alert('ไม่มีรายการที่กำลังดำเนินการให้จำลองการค้าง');return;}
  var n=Math.min(cand.length,1+Math.floor(Math.random()*2));
  for(var i=0;i<n;i++){
    var t=cand[i], c=cases[Math.floor(Math.random()*cases.length)];
    t.stuck=true; t.stuckType=c.type; t.error=c.msg;
    t.coreHasIt=(c.type==='indoubt')?(Math.random()<0.5):false;   /* บาง timeout เข้า core จริง บางอันไม่เข้า → reconcile ถึงจะรู้ */
    t.log.push({ts:Date.now(),note:(c.type==='indoubt'?'ส่งเข้า AS400 — หมดเวลา ไม่ได้รับคำตอบ · ':'ส่งเข้า AS400 ไม่สำเร็จ · ')+c.msg,ok:false,by:'ระบบ'});
  }
  render();
}
/* ออกรายงานสถานะ end-to-end (mock download) */
function sa78Export(){
  var L=['EXIM BANK — SA-1278 · รายงานสถานะ Forward Contract (End-to-End)',
    'ออกรายงาน: '+new Date().toLocaleString('th-TH'),
    '=========================================================',''];
  SA78_TXNS.forEach(function(t){
    var stat=t.stage>=SA78_DONE?'เสร็จสมบูรณ์':(t.stuck?('ค้าง — '+SA78_STUCK[t.stuckType].label+' ('+t.error+')'):'ออกสัญญาแล้ว (App) · รอส่ง AS400');
    L.push(t.ref+'  ·  '+t.company+' ('+t.custcode+')');
    L.push('   '+(t.side==='sell'?'ขาย':'ซื้อ')+' '+fmt(t.amt,0)+' '+t.ccy+' @ '+fmtR(t.rate,t.ccy)+'  ·  ครบกำหนด '+t.maturity);
    L.push('   สถานะ: '+stat+(t.as400Ref?'  ·  AS400: '+t.as400Ref:''));
    L.push('');
  });
  var st=sa78Stats();
  L.push('---------------------------------------------------------');
  L.push('รวม '+st.total+' รายการ  ·  เสร็จสมบูรณ์ '+st.done+'  ·  ระหว่างดำเนินการ '+st.pending+'  ·  ค้าง '+st.stuck+' (ส่งไม่สำเร็จ '+st.stuckError+' · ไม่ทราบผล '+st.stuckIndoubt+')');
  var a=document.createElement('a');
  a.download='SA-1278_FC_Status_Report.txt';
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(L.join('\n'));
  a.click();
}

/* === render === */
function sa78StageBadge(t){
  if(t.stuck){var s=SA78_STUCK[t.stuckType]||SA78_STUCK.error;return '<span class="tag '+s.tag+'">'+ic('warn')+' ค้าง: '+s.label+'</span>';}
  if(t.stage>=SA78_DONE)return '<span class="tag tag-ok">'+ic('check')+' เสร็จสมบูรณ์</span>';
  return '<span class="tag tag-inf">'+SA78_STAGES[t.stage].label+'</span>';
}
/* stepper แสดง progress ของ 1 รายการ (2 ขั้น) */
function sa78Stepper(t){
  return '<div style="display:flex;align-items:center;gap:0;flex-wrap:wrap">'+SA78_STAGES.map(function(s,i){
    var done=i<t.stage||t.stage>=SA78_DONE, cur=i===t.stage&&t.stage<SA78_DONE;
    var stuckCol=(t.stuckType==='indoubt')?'var(--wn)':'var(--er)';
    var bg=done?'var(--ok)':(cur?(t.stuck?stuckCol:'var(--inf)'):'var(--bdr)');
    var fg=(done||cur)?'#fff':'var(--t3)';
    var dot='<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:110px">'
      +'<div style="width:26px;height:26px;border-radius:50%;background:'+bg+';color:'+fg+';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">'+(done?'✓':(cur&&t.stuck?'!':(i+1)))+'</div>'
      +'<div style="font-size:10px;color:'+((done||cur)?'var(--t2)':'var(--t3)')+';text-align:center;line-height:1.2">'+s.label+'</div></div>';
    var line=i<SA78_STAGES.length-1?'<div style="flex:1;min-width:18px;height:2px;background:'+(t.stage>=SA78_DONE?'var(--ok)':'var(--bdr)')+';margin-top:-16px"></div>':'';
    return dot+line;
  }).join('')+'</div>';
}
/* คอลัมน์สถานะ AS400 ในตาราง */
function sa78As400Cell(t){
  if(t.stage>=SA78_DONE)return '<span style="font-family:monospace;font-size:11px">'+t.as400Ref+'</span>';
  if(t.stuck)return t.stuckType==='indoubt'
    ?'<span class="tag tag-wn" style="font-size:10px">ไม่ทราบผล</span>'
    :'<span class="tag tag-er" style="font-size:10px">ส่งไม่สำเร็จ</span>';
  return '<span style="color:var(--t3)">ยังไม่ส่ง</span>';
}
/* ปุ่มกู้/ดำเนินการต่อ ตามสถานะรายการ (in-doubt = ตรวจสอบก่อน · error = ส่งใหม่ · ปกติ = ส่ง) */
function sa78RecoverBtn(t){
  if(t.stage>=SA78_DONE)return '';
  if(t.stuck&&t.stuckType==='indoubt')
    return '<button class="btn btn-p sa78-recover" data-id="'+t.id+'" style="font-size:11px;padding:4px 10px">'+ic('warn')+' ตรวจสอบ AS400</button>';
  return '<button class="btn '+(t.stuck?'btn-r':'btn-s')+' sa78-recover" data-id="'+t.id+'" style="font-size:11px;padding:4px 10px">'+ic('arR')+' '+(t.stuck?'ส่งใหม่':'ส่งเข้า AS400')+'</button>';
}
/* แถวในตารางหลัก */
function sa78Row(t){
  return '<tr'+(t.stuck?' style="background:var(--er-bg)"':'')+'>'
    +'<td style="font-weight:600;color:var(--blue);white-space:nowrap">'+t.ref+'</td>'
    +'<td style="font-size:12px"><div style="font-weight:600">'+t.company+'</div><div style="color:var(--t3)">'+t.custcode+'</div></td>'
    +'<td style="white-space:nowrap"><span class="tag '+(t.side==='sell'?'tag-er':'tag-inf')+'">'+(t.side==='sell'?'ขาย':'ซื้อ')+'</span> '+fmt(t.amt,0)+' <span style="color:var(--t3);font-size:11px">'+t.ccy+'</span></td>'
    +'<td>'+sa78StageBadge(t)+(t.stuck?'<div style="font-size:10px;color:'+(t.stuckType==='indoubt'?'var(--wn)':'var(--er)')+';margin-top:3px">'+t.error+'</div>':'')+'</td>'
    +'<td style="text-align:center">'+sa78As400Cell(t)+'</td>'
    +'<td style="font-size:11px;color:var(--t3);white-space:nowrap">'+new Date(sa78LastTs(t)).toLocaleString('th-TH',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})+'</td>'
    +'<td style="text-align:center;white-space:nowrap"><button class="btn btn-s sa78-view" data-id="'+t.id+'" style="font-size:11px;padding:4px 10px">'+ic('file')+' ดู</button> '+sa78RecoverBtn(t)+'</td>'
  +'</tr>';
}
/* modal รายละเอียด + timeline + ปุ่มกู้รายการ */
function sa78Detail(t){
  var timeline=t.log.map(function(h){
    var col=h.ok?'var(--ok)':'var(--er)';
    return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px dashed var(--bdr)">'
      +'<div style="width:8px;height:8px;border-radius:50%;background:'+col+';margin-top:5px;flex-shrink:0"></div>'
      +'<div style="flex:1"><div style="font-size:12px;color:'+(h.ok?'var(--t2)':'var(--er)')+';font-weight:'+(h.ok?'400':'600')+'">'+(h.ok?'':ic('warn')+' ')+h.note+'</div>'
      +'<div style="font-size:10px;color:var(--t3)">'+new Date(h.ts).toLocaleString('th-TH')+' · '+h.by+'</div></div></div>';
  }).join('');
  var actions;
  if(t.stage>=SA78_DONE){
    actions='<div class="alert success" style="margin-top:14px">'+ic('check')+'<div>รายการนี้เข้า AS400 ('+t.as400Ref+') และปิดรายการเรียบร้อยแล้ว</div></div>';
  }else if(t.stuck&&t.stuckType==='indoubt'){
    actions='<div class="btn-row" style="margin-top:14px"><button class="btn btn-p sa78-recover" data-id="'+t.id+'" style="font-size:12px">'+ic('warn')+' ตรวจสอบกับ AS400 (reconcile)</button></div>'
      +'<div style="font-size:11px;color:var(--t3);margin-top:6px">ระบบจะถาม AS400 ก่อนว่ามีรายการนี้แล้วหรือยัง → ถ้ามีแล้วปิดเลย (ไม่ส่งซ้ำ) · ถ้ายังไม่มีจึงส่งใหม่</div>';
  }else{
    actions='<div class="btn-row" style="margin-top:14px"><button class="btn '+(t.stuck?'btn-r':'btn-p')+' sa78-recover" data-id="'+t.id+'" style="font-size:12px">'+ic('arR')+' '+(t.stuck?'ส่งใหม่เข้า AS400':'ส่งเข้า AS400')+'</button></div>';
  }
  var stuckAlert=t.stuck
    ?'<div class="alert" style="background:'+(t.stuckType==='indoubt'?'var(--wn-bg);color:var(--wn)':'var(--er-bg);color:var(--er)')+';margin-bottom:14px">'+ic('warn')+'<div><strong>รายการค้าง — '+SA78_STUCK[t.stuckType].label+'</strong> · '+t.error+'<div style="font-size:11px;font-weight:400;margin-top:2px">'+SA78_STUCK[t.stuckType].hint+'</div></div></div>'
    :'';
  return '<div style="padding:18px 20px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border-bottom:1px solid var(--bdr);padding-bottom:12px;margin-bottom:14px">'
      +'<div><div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px">SA-1278 · จัดการรายการค้าง</div>'
        +'<strong style="color:var(--blue);font-size:16px">'+t.ref+'</strong>'
        +'<div style="font-size:12px;color:var(--t3);margin-top:2px">'+t.company+' · '+t.custcode+' · '+(t.side==='sell'?'ขาย':'ซื้อ')+' '+fmt(t.amt,0)+' '+t.ccy+' @ '+fmtR(t.rate,t.ccy)+' · ครบกำหนด '+fmtTH(t.maturity)+'</div></div>'
      +'<button class="btn btn-s sa78-close" style="font-size:12px;padding:5px 12px">'+ic('x')+' ปิด</button>'
    +'</div>'
    +stuckAlert
    +'<div style="margin-bottom:14px">'+sa78Stepper(t)+'</div>'
    +'<div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:4px">Timeline การดำเนินการ</div>'
    +'<div>'+timeline+'</div>'
    +actions
  +'</div>';
}
function hSA1278(){
  var st=sa78Stats(), F=SA78_FILTER, q=(F.q||'').trim().toUpperCase();
  var shown=SA78_TXNS.filter(function(t){
    if(q){var hay=(t.ref+' '+t.company+' '+t.custcode).toUpperCase();if(hay.indexOf(q)<0)return false;}
    if(F.stage!==''&&String(t.stage)!==String(F.stage))return false;
    if(F.stuckOnly&&!t.stuck)return false;
    return true;
  });

  /* การ์ดสรุป */
  function statCard(label,val,color,sub){
    return '<div style="flex:1;min-width:120px;border:1px solid var(--bdr);border-radius:var(--rs);padding:12px 14px">'
      +'<div style="font-size:11px;color:var(--t3)">'+label+'</div>'
      +'<div style="font-size:24px;font-weight:800;color:'+(color||'var(--blue)')+';line-height:1.1">'+val+'</div>'
      +(sub?'<div style="font-size:10px;color:var(--t3);margin-top:2px">'+sub+'</div>':'')+'</div>';
  }
  var cards='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">'
    +statCard('รายการทั้งหมด',st.total,'var(--blue)','จองผ่าน App')
    +statCard('ระหว่างดำเนินการ',st.pending,'var(--inf)','ยังไม่เข้า AS400')
    +statCard('ค้าง / มีปัญหา',st.stuck,'var(--er)','ส่งไม่สำเร็จ '+st.stuckError+' · ไม่ทราบผล '+st.stuckIndoubt)
    +statCard('เสร็จสมบูรณ์',st.done,'var(--ok)','เข้า AS400 + ปิดแล้ว')
  +'</div>';

  /* ภาพรวมไปป์ไลน์ — จำนวนต่อสถานะ */
  var pipe='<div class="card"><div class="card-title">'+ic('bld')+' ภาพรวมไปป์ไลน์ (จำนวนรายการต่อสถานะ)</div>'
    +'<div style="display:flex;align-items:flex-start;gap:0;flex-wrap:wrap">'+SA78_STAGES.map(function(s,i){
      var line=i<SA78_STAGES.length-1?'<div style="flex:1;min-width:24px;height:2px;background:var(--bdr);margin-top:19px"></div>':'';
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:120px">'
        +'<div style="width:40px;height:40px;border-radius:50%;background:'+s.color+';color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800">'+st.perStage[i]+'</div>'
        +'<div style="font-size:11px;color:var(--t2);text-align:center;line-height:1.2">'+s.label+'</div></div>'+line;
    }).join('')+'</div>'
    +(st.stuck?'<div style="font-size:11px;color:var(--er);margin-top:8px">'+ic('warn')+' มี '+st.stuck+' รายการค้างที่รอยต่อ App → AS400 (นับรวมอยู่ใน "'+SA78_STAGES[0].label+'") — ส่งไม่สำเร็จ '+st.stuckError+' · ไม่ทราบผล '+st.stuckIndoubt+'</div>':'')
  +'</div>';

  /* toolbar: ค้นหา/กรอง + action ระดับระบบ */
  var stageOpts='<option value="">ทุกสถานะ</option>'+SA78_STAGES.map(function(s,i){return '<option value="'+i+'"'+(String(F.stage)===String(i)?' selected':'')+'>'+s.label+'</option>';}).join('');
  var toolbar='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">'
    +'<input type="text" id="sa78-q" placeholder="ค้นหา Reference / ชื่อบริษัท / custcode..." value="'+(F.q||'').replace(/"/g,'&quot;')+'" style="flex:1;min-width:220px">'
    +'<select id="sa78-stage" style="max-width:190px">'+stageOpts+'</select>'
    +'<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t2);white-space:nowrap"><input type="checkbox" id="sa78-stuck" '+(F.stuckOnly?'checked':'')+' style="accent-color:var(--er)"> เฉพาะที่ค้าง</label>'
    +'<span style="font-size:11px;color:var(--t3)">'+shown.length+' / '+SA78_TXNS.length+' รายการ</span>'
  +'</div>';

  var rows=shown.length?shown.map(sa78Row).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--t3);padding:18px">— ไม่พบรายการตามเงื่อนไข —</td></tr>';
  var table='<div class="card">'
    +'<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span>'+ic('file')+' รายการจอง Forward Contract + สถานะการส่ง AS400</span>'
      +'<span style="display:flex;gap:6px;flex-wrap:wrap">'
        +'<button class="btn btn-s" id="sa78-sim" style="font-size:11px;padding:5px 12px">'+ic('warn')+' จำลองเหตุระบบขัดข้อง</button>'
        +'<button class="btn btn-r" id="sa78-advall" style="font-size:11px;padding:5px 12px">'+ic('refresh')+' ดำเนินการรายการค้างทั้งหมด</button>'
        +'<button class="btn btn-s" id="sa78-export" style="font-size:11px;padding:5px 12px">'+ic('dl')+' ออกรายงาน</button>'
        +'<button class="btn btn-s" id="sa78-reset" style="font-size:11px;padding:5px 12px">'+ic('refresh')+' รีเซ็ตข้อมูล</button>'
      +'</span></div>'
    +'<div class="alert info">'+ic('info')+'<div>เป็น <strong>customer self-service</strong> — ลูกค้าจอง+ยืนยัน+ออกสัญญาในคลิกเดียว (atomic · ไม่มี draft) · <strong>AS400 API ตอบผลทันที</strong> จึงไม่มีสถานะ "รอ ack" · จุดที่รายการมัก <strong>ค้าง</strong> คือรอยต่อ <strong>App → AS400</strong> แยกเป็น <span class="tag tag-er" style="font-size:10px">ส่งไม่สำเร็จ</span> (ส่งใหม่ได้) กับ <span class="tag tag-wn" style="font-size:10px">ไม่ทราบผล/timeout</span> (ต้อง <strong>ตรวจสอบก่อนส่งซ้ำ</strong> กันสัญญาซ้ำ)</div></div>'
    +toolbar
    +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr><th>Reference No.</th><th>ลูกค้า</th><th>รายการ</th><th>สถานะปัจจุบัน</th><th style="text-align:center">AS400</th><th>อัปเดตล่าสุด</th><th style="text-align:center">การจัดการ</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
  +'</div>';

  var modal=(SA78_OPEN&&sa78Find(SA78_OPEN))
    ?'<div class="modal-ov show" id="sa78-modal"><div style="background:#fff;border-radius:var(--r);max-width:720px;width:94%;max-height:88vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.25)">'+sa78Detail(sa78Find(SA78_OPEN))+'</div></div>'
    :'';

  return '<div class="sc">'
    +'<div style="font-size:20px;font-weight:700;color:var(--blue);margin-bottom:2px">SA-1278 · จัดการรายการ Forward Contract เมื่อระบบมีปัญหา</div>'
    +'<div style="font-size:13px;color:var(--t3);margin-bottom:16px">ตรวจสอบสถานะการส่ง AS400 และกู้รายการที่ค้างให้จบ end-to-end</div>'
    +cards+pipe+table
  +modal+'</div>';
}
function bindSA1278(){
  function $(id){return document.getElementById(id);}
  /* filter: ค้นหา (คงตำแหน่ง cursor) + สถานะ + เฉพาะที่ค้าง */
  var qi=$('sa78-q');
  if(qi)qi.addEventListener('input',function(){
    SA78_FILTER.q=this.value; var pos=this.selectionStart; render();
    var n=document.getElementById('sa78-q'); if(n){n.focus();try{n.setSelectionRange(pos,pos);}catch(e){}}
  });
  var stg=$('sa78-stage'); if(stg)stg.addEventListener('change',function(){SA78_FILTER.stage=this.value;render();});
  var stk=$('sa78-stuck'); if(stk)stk.addEventListener('change',function(){SA78_FILTER.stuckOnly=this.checked;render();});
  /* action ระดับระบบ */
  var adv=$('sa78-advall'); if(adv)adv.addEventListener('click',sa78RecoverAllStuck);
  var sim=$('sa78-sim');    if(sim)sim.addEventListener('click',sa78SimOutage);
  var exp=$('sa78-export'); if(exp)exp.addEventListener('click',sa78Export);
  var rst=$('sa78-reset');  if(rst)rst.addEventListener('click',function(){if(confirm('รีเซ็ตข้อมูลตัวอย่างกลับค่าเริ่มต้น?')){SA78_TXNS=sa78Seed();SA78_OPEN=null;render();}});
  /* ปุ่มในแถว + ปุ่มกู้รายการใน modal (in-doubt=ตรวจสอบ · error=ส่งใหม่ · ปกติ=ส่ง) */
  document.querySelectorAll('.sa78-view').forEach(function(b){b.addEventListener('click',function(){SA78_OPEN=this.dataset.id;render();});});
  document.querySelectorAll('.sa78-recover').forEach(function(b){b.addEventListener('click',function(){sa78Recover(this.dataset.id);render();});});
  /* modal */
  var ov=$('sa78-modal'); if(ov)ov.addEventListener('click',function(e){if(e.target===ov){SA78_OPEN=null;render();}});
  document.querySelectorAll('.sa78-close').forEach(function(b){b.addEventListener('click',function(){SA78_OPEN=null;render();});});
}
