/* =============================================================================
 * Adjust Underlying — tab "Adjust Underlying" (phase 9)
 * แยกออกมาจาก exim_forward_contract (1).html
 *
 * แนวคิด: เจ้าหน้าที่ดูรายการจอง Forward แล้วปรับ Underlying (Reference/จำนวน)
 *   ภายหลังได้ พร้อมทะเบียน Reference (แก้ Max / ยอดนอกระบบ) และตรวจยอดคงเหลือ
 *
 * ไฟล์นี้ประกอบด้วย:
 *   - state : EMP2_REF_EXT_SEED, EMP2_ADJUST, EMP2_OPEN, EMP2_REF_SEL,
 *             EMP2_REF_EDIT, EMP2_REF_EXT, EMP2_REF_FILTER
 *   - helper : emp2ViewDoc/emp2DocChips/emp2RefRemainFor/emp2Metrics/emp2Changed
 *             /emp2RefCcy/emp2Ext/ccyFlag
 *   - render : emp2GridCard/emp2Detail/hEmp2RefTable/hEmp2RefDetail/hEmp2/bindEmp2
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   REF_DB, REF_DOCS, BOOKINGS, M, fmt(), fmtAmt(), ic(), SVG, render()
 * จุดเชื่อม: render() ใน HTML เรียก hEmp2()/bindEmp2() เมื่อ P.phase===9
 * ============================================================================= */

/* === state === */
/* custcode + combined key: Reference No อาจซ้ำข้ามลูกค้าได้ → identity = custcode + RefNo (refKey) */
var EMP2_CUST_DEF='C00124567';                         /* custcode ตั้งต้น (ลูกค้าที่ล็อกอิน) */
var CUST_NAMES={'C00124567':'บจ. ไทย เอ็กซ์พอร์ต','C00987654':'บจ. เอเชีย เทรดดิ้ง'};
function refKey(cust,ref){return (cust||EMP2_CUST_DEF)+'||'+ref;}      /* คีย์รวม custcode+RefNo */
function keyCust(key){var i=key.indexOf('||');return i<0?EMP2_CUST_DEF:key.slice(0,i);}
function keyRef(key){var i=key.indexOf('||');return i<0?key:key.slice(i+2);}
/* master REF_DB จะถือว่าเป็นของ (custcode+RefNo) ก็ต่อเมื่อ REF_DB[ref].cust ตรงกับ custcode นั้น */
function emp2Master(cust,ref){var r=REF_DB[ref];if(r&&(r.cust||EMP2_CUST_DEF)===cust)return r;return EMP2_REF_IMPORTED[refKey(cust,ref)]||null;}

/* ค่า "นอกระบบ" เริ่มต้น (คีย์ด้วย custcode+RefNo) ของ Underlying ที่ยกมาจากระบบเดิม */
var EMP2_REF_EXT_SEED={'C00124567||MIG-2566-0001':250000,'C00124567||MIG-2566-0002':150000,'C00124567||MIG-2566-0003':900000};
var EMP2_ADJUST=null;   /* (feature ถูก disable) state สำหรับ "จัดการรายการ v2" */
var EMP2_OPEN=null;     /* (feature ถูก disable) index สัญญาที่กดเปิด review Underlying */
var EMP2_REF_SEL=null;  /* custKey (custcode+RefNo) ที่เลือกเพื่อแสดงสัญญาในการ์ดแยกด้านล่าง */
var EMP2_REF_EDIT=null; /* custKey ที่กำลังแก้ค่า Max / นอกระบบ ในตารางทะเบียน Reference */
var EMP2_REF_EXT=Object.assign({},EMP2_REF_EXT_SEED);  /* { custKey: number } ยอด "นอกระบบ" ต่อ (custcode+RefNo) */
var EMP2_REF_MAX={};    /* { custKey: number } Max ที่แก้ในแท็บนี้ ต่อ (custcode+RefNo) — ไม่เขียนทับ REF_DB */
var EMP2_REF_FILTER={q:'',ccy:'',status:''}; /* ตัวกรองตารางทะเบียน Reference: ค้นหา + สกุล + สถานะ */
/* Max ของ (custcode+RefNo): ใช้ค่าที่แก้ในแท็บก่อน ถ้าไม่มีจึงใช้ master REF_DB (เฉพาะที่เป็นของ custcode นั้น) */
function emp2Max(key){if(EMP2_REF_MAX[key]!=null)return EMP2_REF_MAX[key];var m=emp2Master(keyCust(key),keyRef(key));return m?m.total:null;}

/* === นำเข้า Underlying (import): เพิ่ม Reference ใหม่เข้าทะเบียน โดยไม่แก้ REF_DB ตรงๆ === */
var EMP2_REF_IMPORTED={};  /* { custKey: {cust,ref,ccy,total,desc} } master ที่เพิ่มผ่านการนำเข้า - คู่ขนานกับ REF_DB */
var EMP2_IMPORT_MODE=null; /* null | 'single' | 'bulk' - modal นำเข้าที่กำลังเปิด */
var EMP2_IMPORT_SINGLE={cust:'',ref:'',ccy:M.ccys[0],max:'',ext:'',desc:'',err:''};
var EMP2_IMPORT_BULK={fileName:'',rows:null,err:''}; /* fileName = ไฟล์ CSV ที่เลือก · rows = ผลลัพธ์ parse ล่าสุด (null = ยังไม่เลือกไฟล์) */
var EMP2_CSV_TEMPLATE_HEADER=['custcode','Reference No','สกุลเงิน','Max','นอกระบบ','คำอธิบาย'];

/* === จัดการรายการ v2 — ดูรายการจอง + ปรับ Underlying ภายหลัง === */
/* mock เปิดดูเอกสารของ Reference */
function emp2ViewDoc(ref,name,type,size){
  var a=document.createElement('a');
  a.download=name;
  a.href='data:application/octet-stream;charset=utf-8,'+encodeURIComponent('เปิดเอกสาร (ตัวอย่าง)\n\nReference : '+ref+'\nประเภท : '+type+'\nไฟล์ : '+name+'\nขนาด : '+size+'\n\n[mock preview]');
  a.click();
}
/* chips เอกสารของ Reference (ใช้ทั้งโหมดดู/แก้ไข) */
function emp2DocChips(ref){
  var ds=REF_DOCS[ref]||[];
  if(!ds.length)return '<span style="font-size:11px;color:var(--t3)">ไม่มีเอกสาร</span>';
  return ds.map(function(d){
    return '<a onclick="emp2ViewDoc(\''+ref+'\',\''+d.name+'\',\''+d.type+'\',\''+d.size+'\')" title="'+d.name+' · '+d.size+'" style="display:inline-flex;align-items:center;gap:3px;background:var(--inf-bg);color:var(--inf);font-size:11px;padding:3px 8px;border-radius:6px;margin:2px 4px 2px 0;cursor:pointer;text-decoration:none">'+SVG.file+' '+d.type+'</a>';
  }).join('');
}
/* คงเหลือของ Reference k ที่ "แถว j ของสัญญา bkIdx" ใช้ได้ = Max − นอกระบบ − ที่ใช้โดยรายการอื่น
   · null = ไม่มี Max (เช็คความเพียงพอไม่ได้) · ul = รายการ underlying ปัจจุบันของสัญญานั้น (ใช้ค่าที่กำลังแก้) */
function emp2RefRemainFor(k,bkIdx,ul,j){
  var cust=(BOOKINGS[bkIdx]&&BOOKINGS[bkIdx].cust)||EMP2_CUST_DEF, key=refKey(cust,k);
  var max=emp2Max(key); if(max==null)return null;   /* ไม่มี Max (คิดตาม custcode+RefNo) */
  var others=0;
  BOOKINGS.forEach(function(bk,bi){if(bi===bkIdx)return;if((bk.cust||EMP2_CUST_DEF)!==cust)return;bk.ul.forEach(function(u){if(u.ref===k)others+=parseFloat(u.amt)||0;});});
  if(ul)ul.forEach(function(u,jj){if(jj!==j&&u.ref===k)others+=parseFloat(u.amt)||0;});
  return max-emp2Ext(key)-others;
}
/* metric สรุปของสัญญา (ใช้ทั้งการ์ด grid และ detail) */
function emp2Metrics(bk){
  var editing=EMP2_ADJUST&&BOOKINGS[EMP2_ADJUST.idx]===bk;
  var idx=editing?EMP2_ADJUST.idx:BOOKINGS.indexOf(bk);
  var ul=editing?EMP2_ADJUST.ul:bk.ul;
  var ulSum=ul.reduce(function(s,u){return s+(u.ccy===bk.ccy?(parseFloat(u.amt)||0):0);},0);
  /* กติกา: ยอด Underlying รวม ต้อง >= ยอดจอง (มากกว่าหรือเท่ากับได้ · น้อยกว่าไม่ได้) */
  return {ul:ul,ulSum:ulSum,short:ulSum<bk.amt-0.001,
    anyOver:ul.some(function(u,j){var rem=emp2RefRemainFor(u.ref,idx,ul,j);return rem!=null&&(parseFloat(u.amt)||0)>rem+0.001;})};
}
/* เทียบ Underlying ที่กำลังแก้ กับของเดิม — true ถ้ามีการเปลี่ยนแปลงจริง */
function emp2Changed(i){
  var o=BOOKINGS[i].ul, n=EMP2_ADJUST.ul;
  if(o.length!==n.length)return true;
  for(var k=0;k<o.length;k++){
    if(String(o[k].ref)!==String(n[k].ref))return true;
    if(String(o[k].ccy)!==String(n[k].ccy))return true;
    if((parseFloat(o[k].amt)||0)!==(parseFloat(n[k].amt)||0))return true;
  }
  return false;
}
/* การ์ดสรุปสัญญาในรูปแบบ grid */
function emp2GridCard(bk,i){
  var m=emp2Metrics(bk), active=EMP2_OPEN===i, reviewed=!!bk.reviewed;
  var sumTag=m.short?'<span class="tag tag-er">'+ic('warn')+' Underlying ไม่พอ</span>':'';
  var overTag=m.anyOver?'<span class="tag tag-er">'+ic('warn')+' เกินคงเหลือ Ref</span>':'';
  var revTag=reviewed?'<span class="tag tag-ok">'+ic('check')+' review แล้ว</span>':'<span class="tag tag-wn">ยังไม่ review</span>';
  return '<div style="border:1px solid '+(active?'var(--blue)':'var(--bdr)')+';border-left:4px solid '+(reviewed?'var(--ok)':'var(--bdr2)')+';border-radius:var(--rs);padding:14px;'+(active?'box-shadow:0 0 0 2px rgba(0,48,135,.12);':'')+'display:flex;flex-direction:column;gap:8px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center"><span><strong style="color:var(--blue);font-size:13px">'+bk.ref+'</strong> <span style="font-size:10px;color:var(--t3)">'+(bk.cust||EMP2_CUST_DEF)+'</span></span>'
      +'<span class="tag '+(bk.side==='sell'?'tag-er':'tag-inf')+'">'+(bk.side==='sell'?'ขาย':'ซื้อ')+'</span></div>'
    +'<div style="font-size:19px;font-weight:700;line-height:1.1">'+fmt(bk.amt,0)+' <span style="font-size:12px;color:var(--t3);font-weight:400">'+bk.ccy+'</span></div>'
    +'<div style="font-size:11px;color:var(--t3)">Rate '+fmtR(bk.rate,bk.ccy)+' · สิ้นสุด '+fmtTH(bk.maturity)+'</div>'
    +'<div style="display:flex;flex-wrap:wrap;gap:4px">'+revTag+sumTag+overTag+'</div>'
    +'<div style="font-size:11px;color:var(--t3)">'+bk.ul.length+' Underlying'+(bk.ulHistory.length?' · แก้ไข '+bk.ulHistory.length+' ครั้ง':'')+'</div>'
    +'<button class="btn '+(active?'btn-p':'btn-s')+' emp2-open" data-i="'+i+'" style="width:100%;font-size:12px;margin-top:2px">'+ic('file')+' '+(active?'กำลังดูอยู่':'ดู / ปรับ Underlying')+'</button>'
    +'<button class="btn '+(reviewed?'btn-s':'btn-p')+' emp2-review" data-i="'+i+'" style="width:100%;font-size:11px">'+(reviewed?ic('x')+' ยกเลิก review':ic('check')+' ทำเครื่องหมายว่า review แล้ว')+'</button>'
  +'</div>';
}
/* panel รายละเอียด Underlying ของสัญญาที่เปิด */
function emp2Detail(bk,i){
  var editing=EMP2_ADJUST&&EMP2_ADJUST.idx===i, reviewed=!!bk.reviewed;
  var m=emp2Metrics(bk), ul=m.ul, cust=bk.cust||EMP2_CUST_DEF;
  var sumTag=m.short?'<span class="tag tag-er">'+ic('warn')+' Underlying น้อยกว่ายอดจอง · '+fmt(m.ulSum,0)+' / '+fmt(bk.amt,0)+' '+bk.ccy+'</span>':'';
  var overTag=m.anyOver?'<span class="tag tag-er">'+ic('warn')+' มีรายการเกินคงเหลือ Ref</span>':'';

  var rows=ul.map(function(u,j){
    var master=emp2Master(cust,u.ref), isOld=!!master, key=refKey(cust,u.ref), max=emp2Max(key);   /* isOld = Reference เดิมที่มีในระบบ */
    var amt=parseFloat(u.amt)||0;
    var rem=emp2RefRemainFor(u.ref,i,ul,j);   /* คงเหลือที่แถวนี้ใช้ได้ (null = ไม่มี Max → เช็คไม่ได้) */
    var over=rem!=null&&amt>rem+0.001;
    var maxCellView=(max!=null)
      ?fmt(max,0)+' '+(master?master.ccy:u.ccy)+(over?' <span style="color:var(--er);font-weight:700">· เกินคงเหลือ!</span>':'')
      :'<span style="color:var(--t3)">ยังไม่กำหนด</span>';
    /* Max แก้ที่ทะเบียน Reference เท่านั้น — ในนี้แสดง Max + คงเหลือที่ใช้ได้ */
    var maxCell='<td style="text-align:right">'+maxCellView
      +(rem!=null?'<div style="font-size:10px;color:'+(over?'var(--er)':'var(--t3)')+'">คงเหลือใช้ได้ '+fmt(rem,0)+'</div>':'')
      +'<div style="font-size:10px;color:var(--t3)">แก้ที่ทะเบียน Reference</div></td>';
    if(editing){
      var amtStyle='text-align:right'+(over?';border-color:var(--er);background:var(--er-bg)':'');
      /* แก้เลข Reference No ได้ทุกแถว (รวมถึง ref ที่มี Max) · สกุล: ref เดิมล็อกตามทะเบียน · ref ใหม่เลือกได้ */
      var refCell='<td><input type="text" value="'+u.ref+'" class="emp2-inp" data-j="'+j+'" data-f="ref" style="text-transform:uppercase;max-width:160px"></td>';
      var ccyCell=isOld
        ?'<td>'+master.ccy+' <span style="font-size:10px;color:var(--t3)">(ตามทะเบียน)</span></td>'
        :'<td><select class="emp2-inp" data-j="'+j+'" data-f="ccy">'+M.ccys.map(function(c){return '<option value="'+c+'"'+(u.ccy===c?' selected':'')+'>'+c+'</option>';}).join('')+'</select></td>';
      return '<tr>'
        +refCell
        +'<td style="white-space:nowrap">'+cust+'</td>'
        +ccyCell
        +'<td><input type="text" inputmode="numeric" value="'+fmtAmt(u.amt)+'" class="emp2-inp" data-j="'+j+'" data-f="amt" style="'+amtStyle+'">'
          +(over?'<div style="font-size:10px;color:var(--er);margin-top:3px">เกินคงเหลือ ('+fmt(rem,0)+')</div>':'')+'</td>'
        +maxCell
        +'<td>'+emp2DocChips(u.ref)+'</td>'
      +'</tr>';
    }
    return '<tr>'
      +'<td style="font-weight:600">'+u.ref+'</td>'
      +'<td style="white-space:nowrap">'+cust+'</td>'
      +'<td>'+(isOld?master.ccy:u.ccy)+'</td>'
      +'<td style="text-align:right'+(over?';color:var(--er);font-weight:700':'')+'">'+fmt(u.amt,0)+'</td>'
      +'<td style="text-align:right">'+maxCellView+'</td>'
      +'<td>'+emp2DocChips(u.ref)+'</td>'
    +'</tr>';
  }).join('');

  var changed=editing&&emp2Changed(i);
  var ctrl=editing
    ?'<div style="margin-top:10px"><span class="fl">เหตุผลในการแก้ไขจำนวน <span class="req">*</span></span><input type="text" id="emp2-reason" placeholder="ระบุเหตุผล..." value="'+(EMP2_ADJUST.reason||'')+'"></div>'
      +'<div class="btn-row" style="margin-top:8px"><button class="btn btn-s emp2-cancel">ยกเลิก</button>'
      +'<button class="btn btn-r emp2-save" data-i="'+i+'"'+(changed?'':' disabled style="opacity:.45;cursor:not-allowed"')+'>'+ic('check')+' บันทึกการแก้ไขจำนวน</button></div>'
      +(changed?'':'<div style="font-size:11px;color:var(--t3);margin-top:4px;text-align:right">ยังไม่มีการเปลี่ยนแปลงข้อมูล</div>')
    :'<div class="btn-row" style="margin-top:10px"><button class="btn btn-p emp2-edit" data-i="'+i+'" style="font-size:12px">'+ic('file')+' แก้ไขจำนวน</button></div>';

  var hist=bk.ulHistory.length
    ?'<div style="margin-top:10px;border-top:1px solid var(--bdr);padding-top:8px"><div style="font-size:11px;font-weight:700;color:var(--t3);margin-bottom:4px">ประวัติการแก้ไข Underlying</div>'
      +bk.ulHistory.map(function(h){return '<div style="font-size:11px;color:var(--t2);margin-bottom:4px">'+new Date(h.ts).toLocaleString('th-TH')+' · '+h.by+' — '+h.note+' <span style="font-style:italic;color:var(--t3)">('+h.reason+')</span></div>';}).join('')
    +'</div>'
    :'';

  return '<div style="padding:18px 20px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:14px;border-bottom:1px solid var(--bdr);padding-bottom:12px">'
      +'<div><div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Review Underlying</div>'
        +'<strong style="color:var(--blue);font-size:15px">'+bk.ref+'</strong>'
        +'<div style="font-size:12px;color:var(--t3);margin-top:2px">'+(bk.side==='sell'?'ขาย':'ซื้อ')+' '+fmt(bk.amt,0)+' '+bk.ccy+' · custcode '+cust+' · Rate '+fmtR(bk.rate,bk.ccy)+' · สิ้นสุด '+fmtTH(bk.maturity)+'</div>'
        +'<div style="margin-top:6px">'+(reviewed?'<span class="tag tag-ok">'+ic('check')+' review แล้ว</span>':'<span class="tag tag-wn">ยังไม่ review</span>')+'</div></div>'
      +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        +'<button class="btn '+(reviewed?'btn-s':'btn-p')+' emp2-review" data-i="'+i+'" style="font-size:12px;padding:5px 12px">'+(reviewed?ic('x')+' ยกเลิก review':ic('check')+' review แล้ว')+'</button>'
        +'<button class="btn btn-s emp2-close" style="font-size:12px;padding:5px 12px">'+ic('x')+' ปิด</button>'
      +'</div>'
    +'</div>'
    +((sumTag||overTag)?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">'+sumTag+overTag+'</div>':'')
    +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr><th>Reference No.</th><th>Custcode</th><th>สกุล</th><th style="text-align:right">จำนวน</th><th style="text-align:right">Max (วงเงิน Ref)</th><th>เอกสาร</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    +ctrl+hist
  +'</div>';
}
/* หาสกุลของ Reference (จาก REF_DB หรือจาก underlying ที่ใช้ ref นั้น) */
function emp2RefCcy(k){
  if(REF_DB[k])return REF_DB[k].ccy;
  var c='USD';
  BOOKINGS.forEach(function(bk){bk.ul.forEach(function(u){if(u.ref===k)c=u.ccy;});});
  return c;
}
/* ยอด "นอกระบบ" ของ Reference (default 0) */
function emp2Ext(k){return parseFloat(EMP2_REF_EXT[k])||0;}
/* แสดงสกุลเงินเป็นธงชาติ + รหัสสกุล */
function ccyFlag(c){var F={USD:'🇺🇸',EUR:'🇪🇺',GBP:'🇬🇧',JPY:'🇯🇵',CNY:'🇨🇳',SGD:'🇸🇬',HKD:'🇭🇰',AUD:'🇦🇺',THB:'🇹🇭'};return (F[c]||'🏳️')+' '+c;}
/* ตาราง Reference No ทั้งหมด (คีย์ด้วย custcode+RefNo) — ตัวกรอง (ค้นหา + สกุล + สถานะ) · แก้ Max/นอกระบบ · คลิกแถวเพื่อดูสัญญา */
function hEmp2RefTable(){
  /* รวมทุก (custcode + RefNo): จาก REF_DB (master ของแต่ละลูกค้า) + ที่ถูกใช้ในสัญญา (BOOKINGS) */
  var regs={};
  function ensure(key){if(!regs[key])regs[key]={uses:[]};return regs[key];}
  Object.keys(REF_DB).forEach(function(ref){ensure(refKey(REF_DB[ref].cust,ref));});
  Object.keys(EMP2_REF_IMPORTED).forEach(function(key){ensure(key);});
  BOOKINGS.forEach(function(bk,bi){var cust=bk.cust||EMP2_CUST_DEF;bk.ul.forEach(function(u){ensure(refKey(cust,u.ref)).uses.push({bi:bi,bk:bk,amt:parseFloat(u.amt)||0,ccy:u.ccy});});});
  var allKeys=Object.keys(regs).sort();
  /* ---- ตัวกรอง ---- */
  var F=EMP2_REF_FILTER, q=(F.q||'').trim().toUpperCase();
  function rowCcy(key){var m=emp2Master(keyCust(key),keyRef(key));if(m)return m.ccy;var u=regs[key].uses[0];return u?u.ccy:'';}
  var ccySet={};
  allKeys.forEach(function(k){var c=rowCcy(k);if(c)ccySet[c]=1;});
  var ccyOpts=['<option value="">ทุกสกุล</option>'].concat(Object.keys(ccySet).sort().map(function(c){return '<option value="'+c+'"'+(F.ccy===c?' selected':'')+'>'+ccyFlag(c)+'</option>';})).join('');
  var statusOpts=[['','ทุกสถานะ'],['nomax','ยังไม่กำหนด Max'],['over','เกิน Max'],['has','มีคงเหลือ'],['none','คงเหลือ ≤ 0']].map(function(o){return '<option value="'+o[0]+'"'+(F.status===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('');
  function metrics(key){
    var used=regs[key].uses.reduce(function(s,x){return s+x.amt;},0);
    var max=emp2Max(key), ext=emp2Ext(key);
    var remain=max!=null?(max-ext-used):null;
    return {used:used,max:max,ext:ext,remain:remain};
  }
  var shown=allKeys.filter(function(k){
    var ref=keyRef(k), cust=keyCust(k), m=emp2Master(cust,ref);
    if(q){var hay=(ref+' '+cust+' '+(CUST_NAMES[cust]||'')+' '+(m?m.desc:'')).toUpperCase();if(hay.indexOf(q)<0)return false;}
    if(F.ccy&&rowCcy(k)!==F.ccy)return false;
    if(F.status){
      var mt=metrics(k);
      if(F.status==='nomax'&&mt.max!=null)return false;
      if(F.status==='over'&&!(mt.max!=null&&mt.used>mt.max))return false;
      if(F.status==='has'&&!(mt.remain!=null&&mt.remain>0))return false;
      if(F.status==='none'&&!(mt.remain!=null&&mt.remain<=0))return false;
    }
    return true;
  });
  var rows=shown.map(function(k){
    var mt=metrics(k), uses=regs[k].uses, used=mt.used, max=mt.max, ext=mt.ext, remain=mt.remain;
    var ref=keyRef(k), cust=keyCust(k), custName=CUST_NAMES[cust]||'';
    var over=max!=null&&used>max, negRemain=remain!=null&&remain<0;
    var selected=EMP2_REF_SEL===k, editing=EMP2_REF_EDIT===k;
    var caret='<span style="display:inline-block;width:14px;color:var(--t3);font-size:10px">'+(selected?'●':'▶')+'</span>';
    var maxCell,extCell,actCell;
    if(editing){
      maxCell='<td style="text-align:right;white-space:nowrap"><input type="text" inputmode="numeric" class="emp2-refmax-inp" data-k="'+k+'" value="'+(max!=null?fmtAmt(max):'')+'" placeholder="กำหนด max" style="text-align:right;max-width:110px"></td>';
      extCell='<td style="text-align:right;white-space:nowrap"><input type="text" inputmode="numeric" class="emp2-refext-inp" data-k="'+k+'" value="'+(ext?fmtAmt(ext):'')+'" placeholder="0" style="text-align:right;max-width:100px"></td>';
      actCell='<td style="text-align:center;white-space:nowrap"><button class="btn btn-r emp2-refmax-save" data-k="'+k+'" style="font-size:10px;padding:3px 8px">'+ic('check')+' บันทึก</button> <button class="btn btn-s emp2-refmax-cancel" data-k="'+k+'" style="font-size:10px;padding:3px 8px">ยกเลิก</button></td>';
    }else{
      maxCell='<td style="text-align:right;white-space:nowrap">'+(max!=null?fmt(max,0):'<span style="color:var(--t3)">—</span>')+'</td>';
      extCell='<td style="text-align:right;white-space:nowrap">'+(ext?'<span style="color:var(--wn);font-weight:600">'+fmt(ext,0)+'</span>':'<span style="color:var(--t3)">—</span>')+'</td>';
      actCell='<td style="text-align:center;white-space:nowrap"><button class="btn btn-s emp2-refmax-edit" data-k="'+k+'" style="font-size:10px;padding:3px 8px">แก้ไข</button></td>';
    }
    var remainCell='<td style="text-align:right;white-space:nowrap'+(negRemain?';color:var(--er);font-weight:700':(remain!=null?';color:var(--ok);font-weight:600':''))+'">'+(remain!=null?fmt(remain,0):'<span style="color:var(--t3)">—</span>')+'</td>';
    var revTot=uses.length, revDone=uses.filter(function(x){return x.bk.reviewed;}).length;
    var revPct=revTot?Math.round(revDone/revTot*100):0, allRev=revTot>0&&revDone===revTot;
    var reviewCell=revTot
      ?'<td style="min-width:130px"><div style="display:flex;align-items:center;gap:6px">'
        +'<div style="flex:1;min-width:56px;height:8px;background:var(--bdr);border-radius:5px;overflow:hidden"><div style="height:100%;width:'+revPct+'%;background:'+(allRev?'var(--ok)':'var(--blue)')+';transition:width .3s"></div></div>'
        +'<span style="font-size:11px;font-weight:600;color:'+(allRev?'var(--ok)':'var(--t3)')+';white-space:nowrap">'+revDone+'/'+revTot+'</span>'
      +'</div></td>'
      :'<td style="text-align:center"><span class="tag tag-wn">ไม่มีสัญญา</span></td>';
    return '<tr class="emp2-ref-row" data-k="'+k+'" style="cursor:pointer'+(selected?';background:var(--inf-bg)':'')+'">'
      +'<td style="font-weight:600;color:var(--blue);white-space:nowrap">'+caret+' '+ref+'</td>'
      +'<td style="white-space:nowrap"><span style="font-weight:600">'+cust+'</span>'+(custName?'<div style="font-size:10px;color:var(--t3)">'+custName+'</div>':'')+'</td>'
      +'<td style="white-space:nowrap">'+(rowCcy(k)||'—')+'</td>'
      +maxCell
      +extCell
      +'<td style="text-align:right'+(over?';color:var(--er);font-weight:700':'')+'">'+fmt(used,0)+(over?' '+ic('warn'):'')+'</td>'
      +remainCell
      +'<td style="text-align:center"><span class="tag tag-inf">'+uses.length+' สัญญา</span></td>'
      +reviewCell
      +actCell
    +'</tr>';
  }).join('');
  if(!rows)rows='<tr><td colspan="10" style="text-align:center;color:var(--t3);padding:18px">— ไม่พบ Reference ตามเงื่อนไขที่กรอง —</td></tr>';
  var hasFilter=!!(F.q||F.ccy||F.status);
  var filterBar='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">'
    +'<input type="text" id="emp2-ref-q" placeholder="ค้นหา Reference No / custcode / คำอธิบาย..." value="'+(F.q||'').replace(/"/g,'&quot;')+'" style="flex:1;min-width:200px">'
    +'<select id="emp2-ref-ccy" style="max-width:140px">'+ccyOpts+'</select>'
    +'<select id="emp2-ref-status" style="max-width:160px">'+statusOpts+'</select>'
    +(hasFilter?'<button class="btn btn-s" id="emp2-ref-clear" style="font-size:12px">ล้างตัวกรอง</button>':'')
    +'<span style="font-size:11px;color:var(--t3)">'+shown.length+' / '+allKeys.length+' รายการ</span>'
  +'</div>';
  return '<div class="card">'
    +'<div class="card-title">'+ic('bld')+' ทะเบียน Reference No ทั้งหมด</div>'
    +'<div class="alert info">'+ic('info')+'<div>identity ของ Underlying = <strong>custcode + Reference No</strong> (Reference No เดียวกันอาจอยู่คนละ custcode ได้) · <strong>คลิกที่แถว</strong> เพื่อดูสัญญาที่ใช้ · <strong>แก้ Max และ นอกระบบ ได้</strong> (เก็บในแท็บนี้ · ไม่กระทบทะเบียนหลัก) · <strong>คงเหลือ = Max − นอกระบบ − ใช้ไปแล้ว</strong></div></div>'
    +filterBar
    +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr><th>Reference No.</th><th>Custcode</th><th>สกุล</th><th style="text-align:right">Max</th><th style="text-align:right">นอกระบบ</th><th style="text-align:right">ใช้ไปแล้ว</th><th style="text-align:right">คงเหลือ</th><th style="text-align:center">จำนวนสัญญา</th><th style="text-align:center">Review</th><th style="text-align:center">จัดการ</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
  +'</div>';
}
/* การ์ดแยก — สัญญา/ตั๋วที่ใช้ (custcode+RefNo) ที่เลือก */
function hEmp2RefDetail(){
  var key=EMP2_REF_SEL;
  if(key==null)return '';
  var cust=keyCust(key), ref=keyRef(key), custName=CUST_NAMES[cust]||'';
  var uses=[];
  BOOKINGS.forEach(function(bk,bi){if((bk.cust||EMP2_CUST_DEF)!==cust)return;bk.ul.forEach(function(u){if(u.ref===ref)uses.push({bi:bi,bk:bk,amt:parseFloat(u.amt)||0,ccy:u.ccy});});});
  var m=emp2Master(cust,ref);
  var sub=uses.length
    ?uses.map(function(x){
      var rev=x.bk.reviewed?'<span class="tag tag-ok">'+ic('check')+' review แล้ว</span>':'<span class="tag tag-wn">ยังไม่ review</span>';
      return '<tr>'
        +'<td style="font-weight:600;color:var(--blue)">'+x.bk.ref+'</td>'
        +'<td style="white-space:nowrap">'+(x.bk.cust||EMP2_CUST_DEF)+'</td>'
        +'<td>'+(x.bk.side==='sell'?'ขาย':'ซื้อ')+'</td>'
        +'<td style="text-align:right">'+fmt(x.amt,0)+' '+x.ccy+'</td>'
        +'<td>'+fmtTH(x.bk.maturity)+'</td>'
        +'<td>'+rev+'</td>'
        +'<td style="text-align:center"><button class="btn btn-s emp2-goto" data-i="'+x.bi+'" style="font-size:11px;padding:4px 10px">'+ic('file')+' เปิด</button></td>'
      +'</tr>';
    }).join('')
    :'<tr><td colspan="7" style="color:var(--t3)">— ยังไม่มีสัญญาใช้ —</td></tr>';
  return '<div class="card">'
    +'<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>'+ic('file')+' สัญญา/ตั๋วที่ใช้ '+ref+' · '+cust+(custName?' ('+custName+')':'')+(m?' · '+m.desc:'')+'</span>'
      +'<button class="btn btn-s emp2-refsel-close" style="font-size:12px;padding:4px 10px">'+ic('x')+' ปิด</button></div>'
    +'<div style="overflow-x:auto"><table class="rate-table" style="margin:0"><thead><tr><th>สัญญา</th><th>Custcode</th><th>ฝั่ง</th><th style="text-align:right">จำนวนที่ใช้</th><th>วันสิ้นสุด</th><th>สถานะ review</th><th style="text-align:center;width:90px"></th></tr></thead><tbody>'+sub+'</tbody></table></div>'
  +'</div>';
}
/* การ์ดปุ่มเปิด modal นำเข้า Underlying (รายการเดียว / หลายรายการ) */
function hEmp2ImportCard(){
  return '<div class="card">'
    +'<div class="card-title">'+ic('plus')+' นำเข้า Underlying (Import)</div>'
    +'<div class="alert info">'+ic('info')+'<div>เพิ่ม Reference ใหม่เข้าทะเบียน (custcode + Reference No + สกุลเงิน + Max) โดยไม่กระทบข้อมูลเดิม · นำเข้าได้ทั้ง <strong>ทีละรายการ</strong> และ <strong>หลายรายการพร้อมกัน</strong></div></div>'
    +'<div class="btn-row" style="justify-content:flex-start;margin-top:0">'
      +'<button class="btn btn-p emp2-import-open" data-mode="single">'+ic('plus')+' นำเข้ารายการเดียว</button>'
      +'<button class="btn btn-s emp2-import-open" data-mode="bulk">'+ic('plus')+' นำเข้าหลายรายการ (วางข้อมูล)</button>'
    +'</div>'
  +'</div>';
}
/* modal นำเข้า Underlying ทีละรายการ */
function emp2ImportSingleModal(){
  var f=EMP2_IMPORT_SINGLE;
  var custOpts=Object.keys(CUST_NAMES).map(function(c){return '<option value="'+c+'">'+c+' — '+CUST_NAMES[c]+'</option>';}).join('');
  return '<div class="modal-ov show" id="emp2-import-modal"><div style="background:#fff;border-radius:var(--r);max-width:480px;width:92%;max-height:88vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.25)">'
    +'<div style="padding:18px 20px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--bdr);padding-bottom:10px">'
        +'<strong style="color:var(--blue);font-size:15px">'+ic('plus')+' นำเข้า Underlying — รายการเดียว</strong>'
        +'<button class="btn btn-s emp2-import-close" style="font-size:12px;padding:4px 10px">'+ic('x')+' ปิด</button>'
      +'</div>'
      +'<div style="display:flex;flex-direction:column;gap:10px">'
        +'<div><span class="fl">Custcode <span class="req">*</span></span><input type="text" id="emp2-imp-cust" list="emp2-imp-cust-list" value="'+f.cust+'" placeholder="เช่น C00124567" style="text-transform:uppercase"><datalist id="emp2-imp-cust-list">'+custOpts+'</datalist></div>'
        +'<div><span class="fl">Reference No <span class="req">*</span></span><input type="text" id="emp2-imp-ref" value="'+f.ref+'" placeholder="เช่น INV-2026-0100" style="text-transform:uppercase"></div>'
        +'<div><span class="fl">สกุลเงิน <span class="req">*</span></span><select id="emp2-imp-ccy">'+M.ccys.map(function(c){return '<option value="'+c+'"'+(f.ccy===c?' selected':'')+'>'+c+'</option>';}).join('')+'</select></div>'
        +'<div><span class="fl">Max (วงเงิน Ref) <span class="req">*</span></span><input type="text" inputmode="numeric" id="emp2-imp-max" value="'+f.max+'" placeholder="0"></div>'
        +'<div><span class="fl">นอกระบบ</span><input type="text" inputmode="numeric" id="emp2-imp-ext" value="'+f.ext+'" placeholder="0"></div>'
        +'<div><span class="fl">คำอธิบาย</span><input type="text" id="emp2-imp-desc" value="'+f.desc+'" placeholder="เช่น Invoice ส่งออก"></div>'
        +(f.err?'<div class="alert err" style="margin-bottom:0">'+ic('warn')+'<div>'+f.err+'</div></div>':'')
      +'</div>'
      +'<div class="btn-row" style="margin-top:14px"><button class="btn btn-s emp2-import-close">ยกเลิก</button><button class="btn btn-r emp2-import-single-save">'+ic('check')+' บันทึก</button></div>'
    +'</div>'
  +'</div></div>';
}
/* สร้างไฟล์ template CSV (header + ตัวอย่าง 1 แถว) ให้ดาวน์โหลดไปกรอก แล้วนำกลับมา import */
function emp2DownloadCsvTemplate(){
  var sample=['C00124567','INV-2026-0100','USD','500000','0','Invoice ส่งออก'];
  var csv=EMP2_CSV_TEMPLATE_HEADER.join(',')+'\r\n'+sample.join(',')+'\r\n';
  var a=document.createElement('a');
  a.download='underlying-import-template.csv';
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.click();
}
/* แปลงเนื้อหาไฟล์ CSV (คั่นด้วย comma หรือ Tab) เป็นรายการ underlying พร้อม validate + เช็คข้อมูลซ้ำทีละแถว
   รูปแบบต่อบรรทัด: custcode, Reference No, สกุลเงิน, Max, นอกระบบ, คำอธิบาย (นอกระบบ/คำอธิบาย ไม่ใส่ก็ได้)
   แถวแรกถ้าเป็น header (ขึ้นต้นด้วย "custcode") จะถูกข้ามให้อัตโนมัติ */
function emp2ParseBulk(text){
  var lines=(text||'').split(/\r?\n/).map(function(s){return s.trim();}).filter(function(s){return s.length;});
  if(lines.length&&/^custcode$/i.test(lines[0].split(/\t|,/)[0].trim()))lines.shift();
  var seen={};
  return lines.map(function(line,idx){
    var parts=line.split(/\t|,/).map(function(s){return s.trim();});
    var cust=(parts[0]||'').toUpperCase(), ref=(parts[1]||'').toUpperCase(), ccy=(parts[2]||'').toUpperCase();
    var max=parseFloat((parts[3]||'').replace(/,/g,''));
    var ext=parseFloat((parts[4]||'').replace(/,/g,'')); if(isNaN(ext))ext=0;
    var desc=parts[5]||'';
    var errs=[];
    if(!cust)errs.push('ไม่มี custcode');
    if(!ref)errs.push('ไม่มี Reference No');
    if(!ccy||M.ccys.indexOf(ccy)<0)errs.push('สกุลเงินไม่ถูกต้อง');
    if(isNaN(max)||max<=0)errs.push('Max ต้องมากกว่า 0');
    if(ext<0)errs.push('นอกระบบ ต้องไม่ติดลบ');
    var key=(cust&&ref)?refKey(cust,ref):null;
    /* เช็คข้อมูลซ้ำ: ซ้ำกันเองในไฟล์ที่นำเข้า */
    if(key){if(seen[key])errs.push('ซ้ำกับแถวที่ '+seen[key]+' ในไฟล์นี้');else seen[key]=idx+1;}
    /* เช็คข้อมูลซ้ำ: ซ้ำกับ Reference ที่มีอยู่แล้วในทะเบียน (custcode+RefNo เดิม) */
    return {line:idx+1,cust:cust,ref:ref,ccy:ccy,max:max,ext:ext,desc:desc,errs:errs,exists:!!(key&&emp2Master(cust,ref))};
  });
}
/* modal นำเข้า Underlying หลายรายการ: ดาวน์โหลด template CSV → กรอก → อัปโหลดกลับมา → ตรวจสอบ (รวมเช็คซ้ำ) ก่อนยืนยัน */
function emp2ImportBulkModal(){
  var st=EMP2_IMPORT_BULK, rows=st.rows, previewHtml='';
  if(rows){
    var validCount=rows.filter(function(r){return !r.errs.length;}).length;
    var body=rows.map(function(r){
      var status=r.errs.length
        ?'<span class="tag tag-er">'+ic('warn')+' '+r.errs.join('; ')+'</span>'
        :(r.exists?'<span class="tag tag-wn">จะทับของเดิม</span>':'<span class="tag tag-ok">'+ic('check')+' พร้อมนำเข้า</span>');
      return '<tr>'
        +'<td>'+r.line+'</td>'
        +'<td style="white-space:nowrap">'+(r.cust||'—')+'</td>'
        +'<td style="font-weight:600;white-space:nowrap">'+(r.ref||'—')+'</td>'
        +'<td>'+(r.ccy||'—')+'</td>'
        +'<td style="text-align:right">'+(isNaN(r.max)?'—':fmt(r.max,0))+'</td>'
        +'<td style="text-align:right">'+(r.ext?fmt(r.ext,0):'—')+'</td>'
        +'<td>'+(r.desc||'')+'</td>'
        +'<td>'+status+'</td>'
      +'</tr>';
    }).join('');
    previewHtml='<div style="margin-top:12px"><div style="font-size:12px;color:var(--t3);margin-bottom:6px">ไฟล์ "'+st.fileName+'" · พบ '+rows.length+' แถว · พร้อมนำเข้า '+validCount+' แถว'+((rows.length-validCount)?' · ผิดพลาด '+(rows.length-validCount)+' แถว':'')+'</div>'
      +'<div style="overflow-x:auto;max-height:280px;overflow-y:auto"><table class="rate-table" style="margin:0"><thead><tr><th>#</th><th>Custcode</th><th>Reference No</th><th>สกุล</th><th style="text-align:right">Max</th><th style="text-align:right">นอกระบบ</th><th>คำอธิบาย</th><th>สถานะ</th></tr></thead><tbody>'+body+'</tbody></table></div>'
    +'</div>';
  }
  var confirmBtn=(rows&&rows.some(function(r){return !r.errs.length;}))
    ?'<button class="btn btn-r emp2-import-bulk-confirm">'+ic('check')+' ยืนยันนำเข้า ('+rows.filter(function(r){return !r.errs.length;}).length+' รายการ)</button>'
    :'';
  return '<div class="modal-ov show" id="emp2-import-modal"><div style="background:#fff;border-radius:var(--r);max-width:760px;width:96%;max-height:88vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.25)">'
    +'<div style="padding:18px 20px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--bdr);padding-bottom:10px">'
        +'<strong style="color:var(--blue);font-size:15px">'+ic('plus')+' นำเข้า Underlying — หลายรายการ</strong>'
        +'<button class="btn btn-s emp2-import-close" style="font-size:12px;padding:4px 10px">'+ic('x')+' ปิด</button>'
      +'</div>'
      +'<div class="alert info">'+ic('info')+'<div><strong>ขั้นตอน:</strong> 1) ดาวน์โหลด template CSV 2) กรอกข้อมูลต่อแถว: <code>custcode, Reference No, สกุลเงิน, Max, นอกระบบ, คำอธิบาย</code> (นอกระบบ/คำอธิบาย ไม่ใส่ก็ได้) 3) อัปโหลดไฟล์กลับมาเพื่อตรวจสอบก่อนยืนยัน — ระบบจะเช็คข้อมูลซ้ำทั้งในไฟล์และในทะเบียนให้อัตโนมัติ</div></div>'
      +'<div class="btn-row" style="justify-content:flex-start;margin-top:0;margin-bottom:12px">'
        +'<button class="btn btn-s emp2-import-download-tpl">'+ic('file')+' ดาวน์โหลด Template CSV</button>'
        +'<label class="btn btn-p" style="cursor:pointer;margin:0">'+ic('plus')+' เลือกไฟล์ CSV ที่กรอกแล้ว<input type="file" id="emp2-imp-bulk-file" accept=".csv,text/csv" style="display:none"></label>'
      +'</div>'
      +(st.err?'<div class="alert err" style="margin-bottom:0">'+ic('warn')+'<div>'+st.err+'</div></div>':'')
      +previewHtml
      +'<div class="btn-row" style="margin-top:14px">'
        +'<button class="btn btn-s emp2-import-close">ยกเลิก</button>'
        +confirmBtn
      +'</div>'
    +'</div>'
  +'</div></div>';
}
function hEmp2(){
  var grid=BOOKINGS.map(function(bk,i){return emp2GridCard(bk,i);}).join('');
  var modal=(EMP2_OPEN!=null&&BOOKINGS[EMP2_OPEN])
    ?'<div class="modal-ov show" id="emp2-modal"><div style="background:#fff;border-radius:var(--r);max-width:840px;width:94%;max-height:88vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.25)">'
      +emp2Detail(BOOKINGS[EMP2_OPEN],EMP2_OPEN)+'</div></div>'
    :'';
  var importModal=EMP2_IMPORT_MODE==='single'?emp2ImportSingleModal():(EMP2_IMPORT_MODE==='bulk'?emp2ImportBulkModal():'');
  return '<div class="sc">'
    +hEmp2ImportCard()
    +hEmp2RefTable()
    +hEmp2RefDetail()
    +'<div class="card">'
      +'<div class="card-title">'+ic('file')+' จัดการรายการจอง FX (v2) — ปรับ Underlying ภายหลัง</div>'
      +'<div class="alert info">'+ic('info')+'<div>เลือกสัญญาจาก grid แล้วกด <strong>ดู / ปรับ Underlying</strong> เพื่อ review และปรับจำนวน Underlying · Max / คงเหลือ อ้างอิงตาม <strong>custcode</strong> ของสัญญา · หากจำนวนเกินคงเหลือ ระบบเตือนและบล็อกการบันทึก</div></div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">'+grid+'</div>'
    +'</div>'
  +modal+importModal+'</div>';
}

function bindEmp2(){
  function $(id){return document.getElementById(id);}
  /* section "จัดการรายการจอง FX (v2)" (re-enabled): เปิด/ปิด modal review Underlying */
  document.querySelectorAll('.emp2-open').forEach(function(b){b.addEventListener('click',function(){
    var i=+this.dataset.i; EMP2_OPEN=(EMP2_OPEN===i?null:i); EMP2_ADJUST=null; render();
  });});
  document.querySelectorAll('.emp2-close').forEach(function(b){b.addEventListener('click',function(){
    EMP2_OPEN=null; EMP2_ADJUST=null; render();
  });});
  var ov=$('emp2-modal');
  if(ov)ov.addEventListener('click',function(e){if(e.target===ov){EMP2_OPEN=null;EMP2_ADJUST=null;render();}});
  document.querySelectorAll('.emp2-review').forEach(function(b){b.addEventListener('click',function(){
    var i=+this.dataset.i; BOOKINGS[i].reviewed=!BOOKINGS[i].reviewed; render();
  });});
  document.querySelectorAll('.emp2-goto').forEach(function(b){b.addEventListener('click',function(e){
    e.stopPropagation(); EMP2_OPEN=+this.dataset.i; EMP2_ADJUST=null; render();
  });});
  document.querySelectorAll('.emp2-edit').forEach(function(b){b.addEventListener('click',function(){
    var i=+this.dataset.i;
    EMP2_ADJUST={idx:i,reason:'',ul:BOOKINGS[i].ul.map(function(u){return {ref:u.ref,ccy:u.ccy,amt:u.amt};})};
    render();
  });});
  document.querySelectorAll('.emp2-cancel').forEach(function(b){b.addEventListener('click',function(){EMP2_ADJUST=null;render();});});
  document.querySelectorAll('.emp2-inp').forEach(function(inp){inp.addEventListener('change',function(){
    var j=+this.dataset.j,f=this.dataset.f;
    if(f==='amt')EMP2_ADJUST.ul[j].amt=parseFloat(this.value.replace(/,/g,''))||0;
    else if(f==='ref')EMP2_ADJUST.ul[j].ref=this.value.trim().toUpperCase();
    else EMP2_ADJUST.ul[j][f]=this.value;
    render();   /* re-render เพื่ออัปเดต max/เตือนเกิน ตาม Reference ใหม่ */
  });});
  document.querySelectorAll('.emp2-save').forEach(function(b){b.addEventListener('click',function(){
    var i=+this.dataset.i, reason=($('emp2-reason').value||'').trim();
    if(!reason){alert('กรุณาระบุเหตุผลในการแก้ไข');return;}
    if(!EMP2_ADJUST.ul.length){alert('ต้องมี Underlying อย่างน้อย 1 แถว');return;}
    if(EMP2_ADJUST.ul.some(function(u){return !u.ref||!(parseFloat(u.amt)>0);})){alert('กรุณากรอก Reference และจำนวน (มากกว่า 0) ให้ครบทุกแถว');return;}
    var over=EMP2_ADJUST.ul.map(function(u,j){return {u:u,rem:emp2RefRemainFor(u.ref,i,EMP2_ADJUST.ul,j)};})
      .filter(function(x){return x.rem!=null&&(parseFloat(x.u.amt)||0)>x.rem+0.001;});
    if(over.length){
      alert('บันทึกไม่ได้ — มีจำนวนเกิน "คงเหลือ" ของ Reference:\n\n'
        +over.map(function(x){return '• '+x.u.ref+' : '+fmt(parseFloat(x.u.amt)||0,0)+' > คงเหลือ '+fmt(x.rem,0);}).join('\n')
        +'\n\nกรุณาลดจำนวน · เพิ่มค่า Max · หรือลดค่านอกระบบ ของ Reference นั้น');
      return;
    }
    var bk=BOOKINGS[i];
    var ulSum=EMP2_ADJUST.ul.reduce(function(s,u){return s+(u.ccy===bk.ccy?(parseFloat(u.amt)||0):0);},0);
    if(ulSum<bk.amt-0.001){
      alert('บันทึกไม่ได้ — ยอด Underlying รวม ('+fmt(ulSum,0)+' '+bk.ccy+') น้อยกว่ายอดจอง ('+fmt(bk.amt,0)+' '+bk.ccy+')\n\nยอด Underlying รวมต้องมากกว่าหรือเท่ากับยอดจอง');
      return;
    }
    var oldL=bk.ul.map(function(u){return u.ref+' '+u.ccy+' '+fmt(u.amt,0);}).join(', ');
    var newL=EMP2_ADJUST.ul.map(function(u){return u.ref+' '+u.ccy+' '+fmt(u.amt,0);}).join(', ');
    bk.ulHistory.push({ts:Date.now(),by:'Employee (v2)',note:'['+oldL+'] → ['+newL+']',reason:reason});
    bk.ul=EMP2_ADJUST.ul.map(function(u){var m2=emp2Master(bk.cust||EMP2_CUST_DEF,u.ref);var c=m2?m2.ccy:u.ccy;return {ref:u.ref,ccy:c,amt:parseFloat(u.amt)||0};});
    EMP2_ADJUST=null;render();
  });});
  /* คลิกแถว Reference → เลือก (custcode+RefNo) เพื่อแสดงสัญญาในการ์ดแยกด้านล่าง */
  document.querySelectorAll('.emp2-ref-row').forEach(function(tr){tr.addEventListener('click',function(){
    var k=this.dataset.k; EMP2_REF_SEL=(EMP2_REF_SEL===k?null:k); render();
  });});
  document.querySelectorAll('.emp2-refsel-close').forEach(function(b){b.addEventListener('click',function(e){
    e.stopPropagation(); EMP2_REF_SEL=null; render();
  });});
  /* ตัวกรองตารางทะเบียน Reference (ค้นหา + สกุล + สถานะ) */
  (function(){
    var qi=$('emp2-ref-q');
    if(qi)qi.addEventListener('input',function(){
      EMP2_REF_FILTER.q=this.value; var pos=this.selectionStart; render();
      var n=document.getElementById('emp2-ref-q'); if(n){n.focus();try{n.setSelectionRange(pos,pos);}catch(e){}}
    });
    var cc=$('emp2-ref-ccy'); if(cc)cc.addEventListener('change',function(){EMP2_REF_FILTER.ccy=this.value;render();});
    var st=$('emp2-ref-status'); if(st)st.addEventListener('change',function(){EMP2_REF_FILTER.status=this.value;render();});
    var cl=$('emp2-ref-clear'); if(cl)cl.addEventListener('click',function(){EMP2_REF_FILTER={q:'',ccy:'',status:''};render();});
  })();
  /* แก้ไขค่า Max และ นอกระบบ ต่อ (custcode+RefNo) — เก็บใน EMP2_REF_MAX / EMP2_REF_EXT (ไม่แตะ REF_DB) */
  document.querySelectorAll('.emp2-refmax-edit').forEach(function(b){b.addEventListener('click',function(e){
    e.stopPropagation(); EMP2_REF_EDIT=this.dataset.k; render();
  });});
  document.querySelectorAll('.emp2-refmax-cancel').forEach(function(b){b.addEventListener('click',function(e){
    e.stopPropagation(); EMP2_REF_EDIT=null; render();
  });});
  document.querySelectorAll('.emp2-refmax-inp,.emp2-refext-inp').forEach(function(inp){inp.addEventListener('click',function(e){e.stopPropagation();});});
  document.querySelectorAll('.emp2-refmax-save').forEach(function(b){b.addEventListener('click',function(e){
    e.stopPropagation();
    var k=this.dataset.k;
    var inp=document.querySelector('.emp2-refmax-inp[data-k="'+k+'"]');
    var extInp=document.querySelector('.emp2-refext-inp[data-k="'+k+'"]');
    var v=parseFloat((inp&&inp.value||'').replace(/,/g,''));
    var ev=parseFloat((extInp&&extInp.value||'').replace(/,/g,''));
    if(isNaN(v)||v<=0){alert('ค่า Max ต้องมากกว่า 0');return;}
    if(isNaN(ev))ev=0;
    if(ev<0){alert('ค่า "นอกระบบ" ต้องไม่ติดลบ');return;}
    EMP2_REF_MAX[k]=v;
    EMP2_REF_EXT[k]=ev;
    EMP2_REF_EDIT=null; render();
  });});
  /* นำเข้า Underlying (import): เปิด/ปิด modal ทีละรายการ / หลายรายการ */
  document.querySelectorAll('.emp2-import-open').forEach(function(b){b.addEventListener('click',function(){
    EMP2_IMPORT_MODE=this.dataset.mode;
    if(EMP2_IMPORT_MODE==='single')EMP2_IMPORT_SINGLE={cust:'',ref:'',ccy:M.ccys[0],max:'',ext:'',desc:'',err:''};
    else EMP2_IMPORT_BULK={fileName:'',rows:null,err:''};
    render();
  });});
  document.querySelectorAll('.emp2-import-close').forEach(function(b){b.addEventListener('click',function(){
    EMP2_IMPORT_MODE=null; render();
  });});
  var impOv=$('emp2-import-modal');
  if(impOv)impOv.addEventListener('click',function(e){if(e.target===impOv){EMP2_IMPORT_MODE=null;render();}});
  /* บันทึกนำเข้า Underlying ทีละรายการ — เก็บ error/ค่าที่พิมพ์ไว้ใน state เผื่อต้อง re-render ตอนผิดพลาด */
  var impSaveBtn=document.querySelector('.emp2-import-single-save');
  if(impSaveBtn)impSaveBtn.addEventListener('click',function(){
    var cust=($('emp2-imp-cust').value||'').trim().toUpperCase();
    var ref=($('emp2-imp-ref').value||'').trim().toUpperCase();
    var ccy=$('emp2-imp-ccy').value;
    var maxRaw=($('emp2-imp-max').value||'').replace(/,/g,'');
    var extRaw=($('emp2-imp-ext').value||'').replace(/,/g,'');
    var desc=($('emp2-imp-desc').value||'').trim();
    var max=parseFloat(maxRaw), ext=parseFloat(extRaw); if(isNaN(ext))ext=0;
    EMP2_IMPORT_SINGLE={cust:cust,ref:ref,ccy:ccy,max:maxRaw,ext:extRaw,desc:desc,err:''};
    if(!cust||!ref){EMP2_IMPORT_SINGLE.err='กรุณากรอก Custcode และ Reference No';render();return;}
    if(isNaN(max)||max<=0){EMP2_IMPORT_SINGLE.err='กรุณากรอกค่า Max ให้ถูกต้อง (มากกว่า 0)';render();return;}
    if(ext<0){EMP2_IMPORT_SINGLE.err='ค่า "นอกระบบ" ต้องไม่ติดลบ';render();return;}
    if(emp2Master(cust,ref)&&!confirm('Custcode + Reference No "'+ref+'" นี้มีอยู่แล้วในทะเบียน — ต้องการทับค่าเดิมหรือไม่?'))return;
    var key=refKey(cust,ref);
    EMP2_REF_IMPORTED[key]={cust:cust,ref:ref,ccy:ccy,total:max,desc:desc};
    if(ext>0)EMP2_REF_EXT[key]=ext;
    EMP2_IMPORT_MODE=null;
    alert('นำเข้า Underlying "'+ref+'" สำเร็จ');
    render();
  });
  var impTplBtn=document.querySelector('.emp2-import-download-tpl');
  if(impTplBtn)impTplBtn.addEventListener('click',function(){emp2DownloadCsvTemplate();});
  /* อัปโหลดไฟล์ CSV ที่กรอกแล้ว — อ่านไฟล์แล้ว parse + ตรวจสอบ (รวมเช็คซ้ำ) ทันทีเพื่อแสดง preview ก่อนยืนยัน */
  var impFileInp=$('emp2-imp-bulk-file');
  if(impFileInp)impFileInp.addEventListener('change',function(){
    var file=this.files&&this.files[0];
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(){
      var rows=emp2ParseBulk(String(reader.result||''));
      EMP2_IMPORT_BULK={fileName:file.name,rows:rows,err:rows.length?'':'ไม่พบข้อมูลในไฟล์ที่เลือก'};
      render();
    };
    reader.readAsText(file);
  });
  var impConfirmBtn=document.querySelector('.emp2-import-bulk-confirm');
  if(impConfirmBtn)impConfirmBtn.addEventListener('click',function(){
    var all=EMP2_IMPORT_BULK.rows||[], ok=all.filter(function(r){return !r.errs.length;});
    if(!ok.length){alert('ไม่มีรายการที่พร้อมนำเข้า');return;}
    ok.forEach(function(r){
      var key=refKey(r.cust,r.ref);
      EMP2_REF_IMPORTED[key]={cust:r.cust,ref:r.ref,ccy:r.ccy,total:r.max,desc:r.desc};
      if(r.ext>0)EMP2_REF_EXT[key]=r.ext;
    });
    var skipped=all.length-ok.length;
    EMP2_IMPORT_MODE=null;
    alert('นำเข้าสำเร็จ '+ok.length+' รายการ'+(skipped?' · ข้ามที่มีข้อผิดพลาด '+skipped+' รายการ':''));
    render();
  });
}