/* =============================================================================
 * SA-1278 — tab "SA-1278" (phase 10)
 * "การตรวจสอบหรือทำรายการ Forward Contract เมื่อระบบมีปัญหา และ/หรือรายการไม่ถูกส่งไป AS400"
 *
 * โจทย์ (As a IT/BU):
 *   - เรียกดูรายการจอง Forward Contract ที่ลูกค้าจองผ่าน App "ทุกรายการ" + สถานะการส่ง AS400
 *   - เมื่อระบบขัดข้อง ดูได้ว่ารายการไหน "ค้าง" อยู่ขั้นตอนไหน
 *   - จัดการรายการที่ค้าง ให้เดินต่อจนสุดทาง (ส่ง AS400 / รับ ack / ปิดรายการ) end-to-end + ออกรายงาน
 *
 * โมเดล state (3 ขั้น) — ปรับตาม BU:
 *   * เป็น customer self-service: ลูกค้า "จอง + ยืนยัน + ออกสัญญา" ใน transaction เดียว (atomic)
 *     และไม่มี function draft การจอง → จึงรวบ 3 ขั้นเดิม (booked/confirmed/issued) เป็นขั้นเดียว
 *   * จุดที่รายการจะ "ค้าง" จริง = รอยต่อ App -> AS400 (ตรงชื่อ ticket) จึงลง granularity ที่ฝั่งนี้:
 *       0 ออกสัญญาแล้ว (App)  — App เสร็จ · รอส่ง AS400 (ถ้าค้าง = ส่งไม่สำเร็จ/ยังไม่ส่ง)
 *       1 ส่งไป AS400          — ส่งเข้า core แล้ว · รอ ack (ถ้าค้าง = ไม่ได้รับ ack)
 *       2 เสร็จสมบูรณ์         — AS400 ack ครบ · สถานะเป็นปัจจุบัน
 *
 * ไฟล์นี้ประกอบด้วย:
 *   - state/data : SA78_STAGES, SA78_TXNS (+ seed), SA78_FILTER, SA78_OPEN
 *   - logic      : sa78Find/sa78Stats/sa78Advance/sa78AdvanceAllStuck/sa78SimOutage/sa78Export
 *   - render     : sa78StageBadge/sa78Stepper/sa78Row/sa78Detail/hSA1278/bindSA1278
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   fmt(), fmtR(), fmtTH(), ic(), render()
 * จุดเชื่อม: render() ใน HTML เรียก hSA1278()/bindSA1278() เมื่อ P.phase===10
 * ============================================================================= */

/* === ขั้นตอนของไปป์ไลน์ (index 0..2 = สถานะที่รายการ "ไปถึงแล้ว") === */
var SA78_STAGES=[
  {key:'issued', label:'ออกสัญญาแล้ว (App)', color:'var(--inf)'},  /* 0 : ลูกค้า self-service จอง+ยืนยัน+ออกสัญญา (atomic) */
  {key:'as400',  label:'ส่งไป AS400',         color:'var(--wn)'},   /* 1 : ส่งเข้า core AS400 แล้ว · รอ ack */
  {key:'done',   label:'เสร็จสมบูรณ์',        color:'var(--ok)'}    /* 2 : AS400 ack ครบ · ปิดรายการ */
];
/* ชื่อ action ตอน "เดินหน้า" จากสถานะปัจจุบัน -> target (index ปลายทาง) */
var SA78_STEP_NAME={1:'ส่งรายการไป AS400',2:'รับ acknowledgement / ปิดรายการ'};

/* สร้าง log เริ่มต้นจากสถานะ seed */
function sa78BuildLog(stage,bookedAt,stuck,error){
  var names=['ลูกค้าจอง + ออกสัญญาอัตโนมัติ (self-service)','ส่งรายการไป AS400','รับ acknowledgement / ปิดรายการสมบูรณ์'];
  var log=[], t=bookedAt;
  for(var i=0;i<=stage;i++){ log.push({ts:t,note:names[i],ok:true,by:(i===0?'ลูกค้า / App':'ระบบ')}); t+=1800000; }
  if(stuck&&stage<2) log.push({ts:t,note:'พยายาม: '+names[stage+1]+' — '+error,ok:false,by:'ระบบ'});
  return log;
}
/* seed รายการจอง (mock) — กระจายทุกสถานะ + มีทั้งปกติ/ค้าง · การค้างอยู่ที่รอยต่อ AS400 */
function sa78Seed(){
  var NOW=Date.now(), D=86400000;
  function mk(o){
    o.stuck=!!o.stuck; o.error=o.error||''; o.as400Ref=(o.stage>=1?('AS4-'+(88000+(parseInt(o.ref.slice(-4),10)||0))):'');
    o.log=sa78BuildLog(o.stage,o.bookedAt,o.stuck,o.error);
    return o;
  }
  return [
    mk({id:'T01',ref:'FWD-2026-100001',company:'บจ. ไทย เอ็กซ์พอร์ต',custcode:'C00124567',side:'sell',ccy:'USD',amt:500000,rate:36.4200,maturity:'2026-09-01',bookedAt:NOW-6*D,stage:2}),
    mk({id:'T02',ref:'FWD-2026-100002',company:'บจ. เอเชีย เทรดดิ้ง',custcode:'C00987654',side:'buy', ccy:'EUR',amt:200000,rate:39.6800,maturity:'2026-07-15',bookedAt:NOW-6*D,stage:2}),
    mk({id:'T03',ref:'FWD-2026-100010',company:'บจ. สยาม อะกรี ฟู้ดส์',custcode:'C00220034',side:'sell',ccy:'USD',amt:750000,rate:36.3000,maturity:'2026-08-20',bookedAt:NOW-2*D,stage:0,stuck:true,error:'ส่ง AS400 ไม่สำเร็จ (timeout)'}),
    mk({id:'T04',ref:'FWD-2026-100011',company:'บจ. โกลบอล ฟู้ดส์',custcode:'C00330077',side:'buy', ccy:'CNY',amt:3500000,rate:5.0200,maturity:'2026-10-05',bookedAt:NOW-2*D,stage:0,stuck:true,error:'ส่ง AS400 ไม่สำเร็จ (connection refused)'}),
    mk({id:'T05',ref:'FWD-2026-100012',company:'บจ. เมทัล เวิร์คส์',custcode:'C00441120',side:'sell',ccy:'USD',amt:1200000,rate:36.2500,maturity:'2026-09-30',bookedAt:NOW-1*D,stage:1,stuck:true,error:'ส่ง AS400 แล้วแต่ไม่ได้รับ acknowledgement'}),
    mk({id:'T06',ref:'FWD-2026-100013',company:'บจ. ปาล์ม ออยล์ ไทย',custcode:'C00552210',side:'buy', ccy:'USD',amt:300000,rate:36.4000,maturity:'2026-07-25',bookedAt:NOW-5*3600000,stage:0}),
    mk({id:'T07',ref:'FWD-2026-100014',company:'บจ. เท็กซ์ไทล์ เอเชีย',custcode:'C00663301',side:'sell',ccy:'EUR',amt:450000,rate:39.5000,maturity:'2026-08-10',bookedAt:NOW-8*3600000,stage:0}),
    mk({id:'T08',ref:'FWD-2026-100015',company:'บจ. อิเล็กทรอนิกส์ พาร์ท',custcode:'C00774412',side:'buy', ccy:'USD',amt:900000,rate:36.1500,maturity:'2026-09-12',bookedAt:NOW-1*D,stage:1}),
    mk({id:'T09',ref:'FWD-2026-100016',company:'บจ. เจมส์ แอนด์ จิวเวลรี่',custcode:'C00885523',side:'sell',ccy:'USD',amt:250000,rate:36.3800,maturity:'2026-08-05',bookedAt:NOW-3*D,stage:0,stuck:true,error:'core banking ปิดปรับปรุง (maintenance) — ยังไม่ส่ง AS400'})
  ];
}
var SA78_TXNS=sa78Seed();
var SA78_FILTER={q:'',stage:'',stuckOnly:false};   /* ตัวกรอง: ค้นหา + สถานะ + เฉพาะที่ค้าง */
var SA78_OPEN=null;                                 /* id รายการที่เปิด modal รายละเอียด */

/* === logic === */
function sa78Find(id){for(var i=0;i<SA78_TXNS.length;i++)if(SA78_TXNS[i].id===id)return SA78_TXNS[i];return null;}
function sa78LastTs(t){return t.log.length?t.log[t.log.length-1].ts:t.bookedAt;}
var SA78_DONE=SA78_STAGES.length-1;   /* index สถานะสุดทาง (เสร็จสมบูรณ์) */
/* สรุปจำนวนตามสถานะ + จำนวนที่ค้าง */
function sa78Stats(){
  var st={perStage:SA78_STAGES.map(function(){return 0;}),stuck:0,done:0,pending:0,total:SA78_TXNS.length};
  SA78_TXNS.forEach(function(t){
    st.perStage[t.stage]++;
    if(t.stuck)st.stuck++;
    if(t.stage>=SA78_DONE)st.done++; else st.pending++;
  });
  return st;
}
/* เดินหน้ารายการ 1 ขั้น หรือจนสุดทาง (แกนหลักของ AC: กู้รายการที่ค้างให้จบ end-to-end) */
function sa78Advance(id,toEnd){
  var t=sa78Find(id); if(!t)return;
  do{
    if(t.stage>=SA78_DONE)break;
    var target=t.stage+1;
    t.stage=target;
    if(target===1)t.as400Ref='AS4-'+(88000+(parseInt(t.ref.slice(-4),10)||0));
    t.log.push({ts:Date.now(),note:SA78_STEP_NAME[target]+(target===1?' (AS400 Ref '+t.as400Ref+')':''),ok:true,by:'IT Recovery'});
  }while(toEnd&&t.stage<SA78_DONE);
  t.stuck=false; t.error='';
  render();
}
/* เดินหน้ารายการที่ "ค้าง" ทั้งหมดให้จบ */
function sa78AdvanceAllStuck(){
  var n=SA78_TXNS.filter(function(t){return t.stuck;}).length;
  if(!n){alert('ไม่มีรายการที่ค้างอยู่ในขณะนี้');return;}
  if(!confirm('ยืนยันดำเนินการรายการที่ค้างทั้งหมด '+n+' รายการ ให้เดินต่อจนสุดทาง (ส่ง AS400 / รับ ack / ปิดรายการ) ?'))return;
  SA78_TXNS.forEach(function(t){if(t.stuck)sa78Advance(t.id,true);});
}
/* จำลองเหตุระบบขัดข้อง — สุ่มทำให้รายการที่ยังไม่จบบางรายการค้างที่รอยต่อ AS400 (เพื่อสาธิต) */
function sa78SimOutage(){
  var errs=['ส่ง AS400 ไม่สำเร็จ (timeout)','ส่ง AS400 ไม่สำเร็จ (connection refused)','core banking ปิดปรับปรุง (maintenance)','ไม่ได้รับ acknowledgement จาก AS400'];
  var cand=SA78_TXNS.filter(function(t){return !t.stuck&&t.stage<SA78_DONE;});
  if(!cand.length){alert('ไม่มีรายการที่กำลังดำเนินการให้จำลองการค้าง');return;}
  var n=Math.min(cand.length,1+Math.floor(Math.random()*2));
  for(var i=0;i<n;i++){
    var t=cand[i];
    t.stuck=true; t.error=errs[Math.floor(Math.random()*errs.length)];
    t.log.push({ts:Date.now(),note:'พยายาม: '+SA78_STEP_NAME[t.stage+1]+' — '+t.error,ok:false,by:'ระบบ'});
  }
  render();
}
/* ออกรายงานสถานะ end-to-end (mock download) */
function sa78Export(){
  var L=['EXIM BANK — SA-1278 · รายงานสถานะ Forward Contract (End-to-End)',
    'ออกรายงาน: '+new Date().toLocaleString('th-TH'),
    '=========================================================',''];
  SA78_TXNS.forEach(function(t){
    L.push(t.ref+'  ·  '+t.company+' ('+t.custcode+')');
    L.push('   '+(t.side==='sell'?'ขาย':'ซื้อ')+' '+fmt(t.amt,0)+' '+t.ccy+' @ '+fmtR(t.rate,t.ccy)+'  ·  ครบกำหนด '+t.maturity);
    L.push('   สถานะ: '+SA78_STAGES[t.stage].label+(t.stuck?'  ⚠ ค้าง: '+t.error:'')+(t.as400Ref?'  ·  AS400: '+t.as400Ref:''));
    L.push('');
  });
  var st=sa78Stats();
  L.push('---------------------------------------------------------');
  L.push('รวม '+st.total+' รายการ  ·  เสร็จสมบูรณ์ '+st.done+'  ·  ระหว่างดำเนินการ '+st.pending+'  ·  ค้าง/มีปัญหา '+st.stuck);
  var a=document.createElement('a');
  a.download='SA-1278_FC_Status_Report.txt';
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(L.join('\n'));
  a.click();
}

/* === render === */
function sa78StageBadge(t){
  if(t.stuck)return '<span class="tag tag-er">'+ic('warn')+' ค้างที่ '+SA78_STAGES[t.stage].label+'</span>';
  if(t.stage>=SA78_DONE)return '<span class="tag tag-ok">'+ic('check')+' เสร็จสมบูรณ์</span>';
  return '<span class="tag tag-inf">'+SA78_STAGES[t.stage].label+'</span>';
}
/* stepper แสดง progress ของ 1 รายการ */
function sa78Stepper(t){
  return '<div style="display:flex;align-items:center;gap:0;flex-wrap:wrap">'+SA78_STAGES.map(function(s,i){
    var done=i<t.stage||t.stage>=SA78_DONE, cur=i===t.stage&&t.stage<SA78_DONE;
    var bg=done?'var(--ok)':(cur?(t.stuck?'var(--er)':'var(--inf)'):'var(--bdr)');
    var fg=(done||cur)?'#fff':'var(--t3)';
    var dot='<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:90px">'
      +'<div style="width:26px;height:26px;border-radius:50%;background:'+bg+';color:'+fg+';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">'+(done?'✓':(cur&&t.stuck?'!':(i+1)))+'</div>'
      +'<div style="font-size:10px;color:'+((done||cur)?'var(--t2)':'var(--t3)')+';text-align:center;line-height:1.2">'+s.label+'</div></div>';
    var line=i<SA78_STAGES.length-1?'<div style="flex:1;min-width:18px;height:2px;background:'+(i<t.stage||t.stage>=SA78_DONE?'var(--ok)':'var(--bdr)')+';margin-top:-16px"></div>':'';
    return dot+line;
  }).join('')+'</div>';
}
/* คอลัมน์สถานะ AS400 ในตาราง */
function sa78As400Cell(t){
  if(t.as400Ref)return '<span style="font-family:monospace;font-size:11px">'+t.as400Ref+'</span>'+(t.stage<SA78_DONE?' <span class="tag tag-wn" style="font-size:9px">รอ ack</span>':'');
  return t.stuck?'<span class="tag tag-er" style="font-size:10px">ส่งไม่สำเร็จ</span>':'<span style="color:var(--t3)">ยังไม่ส่ง</span>';
}
/* แถวในตารางหลัก */
function sa78Row(t){
  var runBtn=t.stage<SA78_DONE?'<button class="btn '+(t.stuck?'btn-r':'btn-s')+' sa78-run" data-id="'+t.id+'" style="font-size:11px;padding:4px 10px">'+ic('arR')+' ดำเนินการต่อ</button>':'';
  return '<tr'+(t.stuck?' style="background:var(--er-bg)"':'')+'>'
    +'<td style="font-weight:600;color:var(--blue);white-space:nowrap">'+t.ref+'</td>'
    +'<td style="font-size:12px"><div style="font-weight:600">'+t.company+'</div><div style="color:var(--t3)">'+t.custcode+'</div></td>'
    +'<td style="white-space:nowrap"><span class="tag '+(t.side==='sell'?'tag-er':'tag-inf')+'">'+(t.side==='sell'?'ขาย':'ซื้อ')+'</span> '+fmt(t.amt,0)+' <span style="color:var(--t3);font-size:11px">'+t.ccy+'</span></td>'
    +'<td>'+sa78StageBadge(t)+(t.stuck?'<div style="font-size:10px;color:var(--er);margin-top:3px">'+t.error+'</div>':'')+'</td>'
    +'<td style="text-align:center">'+sa78As400Cell(t)+'</td>'
    +'<td style="font-size:11px;color:var(--t3);white-space:nowrap">'+new Date(sa78LastTs(t)).toLocaleString('th-TH',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})+'</td>'
    +'<td style="text-align:center;white-space:nowrap"><button class="btn btn-s sa78-view" data-id="'+t.id+'" style="font-size:11px;padding:4px 10px">'+ic('file')+' ดู</button> '+runBtn+'</td>'
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
  var actions=t.stage<SA78_DONE
    ?'<div class="btn-row" style="margin-top:14px">'
      +'<button class="btn btn-s sa78-step" data-id="'+t.id+'" style="font-size:12px">'+ic('arR')+' เดินหน้า 1 ขั้น ('+SA78_STEP_NAME[t.stage+1]+')</button>'
      +'<button class="btn btn-p sa78-runend" data-id="'+t.id+'" style="font-size:12px">'+ic('check')+' ดำเนินการจนสุดทาง</button></div>'
    :'<div class="alert success" style="margin-top:14px">'+ic('check')+'<div>รายการนี้เดินครบไปป์ไลน์แล้ว — ส่ง AS400 ('+t.as400Ref+') และปิดรายการเรียบร้อย</div></div>';
  return '<div style="padding:18px 20px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border-bottom:1px solid var(--bdr);padding-bottom:12px;margin-bottom:14px">'
      +'<div><div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px">SA-1278 · จัดการรายการค้าง</div>'
        +'<strong style="color:var(--blue);font-size:16px">'+t.ref+'</strong>'
        +'<div style="font-size:12px;color:var(--t3);margin-top:2px">'+t.company+' · '+t.custcode+' · '+(t.side==='sell'?'ขาย':'ซื้อ')+' '+fmt(t.amt,0)+' '+t.ccy+' @ '+fmtR(t.rate,t.ccy)+' · ครบกำหนด '+fmtTH(t.maturity)+'</div></div>'
      +'<button class="btn btn-s sa78-close" style="font-size:12px;padding:5px 12px">'+ic('x')+' ปิด</button>'
    +'</div>'
    +(t.stuck?'<div class="alert" style="background:var(--er-bg);color:var(--er);margin-bottom:14px">'+ic('warn')+'<div><strong>รายการค้างที่ขั้น "'+SA78_STAGES[t.stage].label+'"</strong> — '+t.error+'</div></div>':'')
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
    +statCard('ระหว่างดำเนินการ',st.pending,'var(--inf)','ยังไม่ปิดรายการ')
    +statCard('ค้าง / มีปัญหา',st.stuck,'var(--er)','ต้อง IT ดำเนินการ')
    +statCard('เสร็จสมบูรณ์',st.done,'var(--ok)','ส่ง AS400 + ปิดแล้ว')
  +'</div>';

  /* ภาพรวมไปป์ไลน์ — จำนวนต่อสถานะ */
  var pipe='<div class="card"><div class="card-title">'+ic('bld')+' ภาพรวมไปป์ไลน์ (จำนวนรายการต่อสถานะ)</div>'
    +'<div style="display:flex;align-items:flex-start;gap:0;flex-wrap:wrap">'+SA78_STAGES.map(function(s,i){
      var line=i<SA78_STAGES.length-1?'<div style="flex:1;min-width:24px;height:2px;background:var(--bdr);margin-top:19px"></div>':'';
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:110px">'
        +'<div style="width:40px;height:40px;border-radius:50%;background:'+s.color+';color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800">'+st.perStage[i]+'</div>'
        +'<div style="font-size:11px;color:var(--t2);text-align:center;line-height:1.2">'+s.label+'</div></div>'+line;
    }).join('')+'</div></div>';

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
    +'<div class="alert info">'+ic('info')+'<div>เป็น <strong>customer self-service</strong> — ลูกค้าจอง+ยืนยัน+ออกสัญญาในคลิกเดียว (atomic · ไม่มี draft) จึงเริ่มที่สถานะ <strong>"ออกสัญญาแล้ว (App)"</strong> · จุดที่รายการมัก <strong>ค้าง</strong> คือรอยต่อ <strong>App → AS400</strong> · กด <strong>"ดำเนินการต่อ"</strong> ให้ระบบส่ง AS400 → รับ ack → ปิดรายการ แบบ end-to-end</div></div>'
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
  var adv=$('sa78-advall'); if(adv)adv.addEventListener('click',sa78AdvanceAllStuck);
  var sim=$('sa78-sim');    if(sim)sim.addEventListener('click',sa78SimOutage);
  var exp=$('sa78-export'); if(exp)exp.addEventListener('click',sa78Export);
  var rst=$('sa78-reset');  if(rst)rst.addEventListener('click',function(){if(confirm('รีเซ็ตข้อมูลตัวอย่างกลับค่าเริ่มต้น?')){SA78_TXNS=sa78Seed();SA78_OPEN=null;render();}});
  /* ปุ่มในแถว */
  document.querySelectorAll('.sa78-view').forEach(function(b){b.addEventListener('click',function(){SA78_OPEN=this.dataset.id;render();});});
  document.querySelectorAll('.sa78-run').forEach(function(b){b.addEventListener('click',function(){sa78Advance(this.dataset.id,true);});});
  /* modal */
  var ov=$('sa78-modal'); if(ov)ov.addEventListener('click',function(e){if(e.target===ov){SA78_OPEN=null;render();}});
  document.querySelectorAll('.sa78-close').forEach(function(b){b.addEventListener('click',function(){SA78_OPEN=null;render();});});
  document.querySelectorAll('.sa78-step').forEach(function(b){b.addEventListener('click',function(){sa78Advance(this.dataset.id,false);});});
  document.querySelectorAll('.sa78-runend').forEach(function(b){b.addEventListener('click',function(){sa78Advance(this.dataset.id,true);});});
}
