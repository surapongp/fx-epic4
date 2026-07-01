/* =============================================================================
 * Square Position (SA-1917) — tab "Square Position" (phase 8)
 * แยกออกมาจาก exim_forward_contract (1).html
 *
 * แนวคิด: เกณฑ์แจ้งเตือน "แยกตามสกุลวงเงินที่ให้บริการปีนี้" (USD, CNY)
 *   - แต่ละสกุลวงเงินมีเกณฑ์ต่อรายการ (AC1) + เกณฑ์ยอดรวมสะสม (AC2) ของตัวเอง
 *   - Feed / การรวมยอด "แยกตามวงเงิน" (t.line) ไม่ได้ดูจากสกุลที่ลูกค้าจอง (t.ccy)
 *     เช่น จอง EUR/SGD แต่ตัดวงเงินสกุล USD ก็นับรวมในก้อน USD
 *   - จำนวนที่ใช้เทียบเกณฑ์ = จำนวนที่จอง แปลงเป็นสกุลวงเงิน (saLineAmt)
 *
 * ไฟล์นี้ประกอบด้วย:
 *   - state & data : SA, SA_TXNS
 *   - ประมวลผล      : saLineAmt(), saEvaluate(), saStats()
 *   - render        : saNotifyTag(), hSA1917(), bindSA1917()
 *
 * พึ่งพา global ที่นิยามใน HTML หลัก (โหลดสคริปต์นี้ "หลัง" inline script):
 *   M (rates), fmt(), fmtR(), fmtTH(), fmtAmt(), ic(), render()
 * จุดเชื่อม: render() ใน HTML เรียก hSA1917()/bindSA1917() เมื่อ P.phase===8
 * ============================================================================= */

/* === SA-1917: ตั้งค่าเกณฑ์แจ้งเตือนเพื่อ Square Position === */
/* ค่าตั้งต้น (ราย "สกุลวงเงิน"):
 *   USD: ต่อรายการ 500,000 · ยอดรวม 1,000,000
 *   CNY: ต่อรายการ 3,500,000 · ยอดรวม 7,000,000  (≈ เทียบเท่าเกณฑ์ USD ที่ ~7.25 CNY/USD) */
var SA={
  ccys:['USD','CNY'],                        /* สกุลวงเงินที่ให้บริการในปีนี้ (เกณฑ์/feed อิงตามนี้) */
  perTxn:{USD:500000, CNY:3500000},          /* AC1: แจ้งเมื่อรายการ ≥ ค่านี้ (ในสกุลวงเงิน) */
  agg:   {USD:1000000,CNY:7000000},          /* AC2: แจ้งเมื่อยอดรวมสะสมถึงค่านี้ (ในสกุลวงเงิน) */
  emails:{USD:'fxdesk-usd@exim.go.th; treasury@exim.go.th', CNY:'fxdesk-cny@exim.go.th; treasury@exim.go.th'},   /* ผู้รับแยกตามสกุลวงเงิน */
  notified:{},                   /* id → true : แจ้งแบบรายการเดี่ยว (auto) */
  aggNotified:{},                /* id → true : ถูกรวมไปแจ้งแบบยอดรวม (auto, หักออกจากกองสะสม) */
  txnGroup:{},                   /* id → 'G-USD-1' : รายการนี้อยู่กลุ่มรวมยอดไหน */
  groups:[],                     /* [{gid,ccy,ids,sum}] กลุ่มที่ระบบรวมยอดแล้วแจ้ง (ราย line) */
  pending:[],                    /* id ที่ยังไม่ถึงเกณฑ์ยอดรวม (กองสะสมค้างอยู่ ทุก line รวมกัน) */
  pendingSum:{},                 /* ccy → ยอดค้างในกองของ line นั้น */
  squared:{},                    /* id → true : ทำ square position แล้ว */
  filter:{line:'',notify:'',sq:''}, /* ตัวกรองตาราง Square Position Flag */
  saved:false
};
/* feed จำลอง: ลูกค้ายืนยันจอง Forward online เข้ามาในวัน
 * t.ccy = สกุลที่ลูกค้าจอง · t.line = สกุล "วงเงิน" ที่ตัด (USD/CNY) → ใช้จัดก้อน/เทียบเกณฑ์ */
var SA_TXNS=[
  /* ---- วงเงิน USD : รายการเดี่ยว (≥500k USD) → แจ้งเดี่ยวอัตโนมัติ ---- */
  {id:'FWD-2026-100021',company:'บจ. ไทย เอ็กซ์พอร์ต จำกัด',side:'sell',ccy:'USD',amt:650000,  line:'USD',spot:36.4200,final:36.3000,value:'2026-09-15'},
  /* ---- วงเงิน USD : รายการย่อย → มัดเป็นกลุ่ม G-USD-1 (จองคนละสกุลแต่ตัดวงเงิน USD) ---- */
  {id:'FWD-2026-100022',company:'บจ. สยาม ฟู้ดส์ จำกัด',    side:'buy', ccy:'EUR',amt:300000,  line:'USD',spot:39.6800,final:39.5500,value:'2026-08-20'},
  {id:'FWD-2026-100023',company:'บจ. เอเชีย เทรดดิ้ง จำกัด',  side:'sell',ccy:'USD',amt:250000,  line:'USD',spot:36.4200,final:36.2800,value:'2026-07-30'},
  {id:'FWD-2026-100028',company:'บจ. เมโทร อิเล็คทรอนิกส์ จำกัด',side:'sell',ccy:'SGD',amt:600000,line:'USD',spot:27.1500,final:27.0500,value:'2026-09-05'},
  /* ---- วงเงิน USD : รายการเดี่ยว (≥500k USD) ---- */
  {id:'FWD-2026-100026',company:'บจ. แปซิฟิก สตีล จำกัด',    side:'sell',ccy:'USD',amt:720000,  line:'USD',spot:36.4200,final:36.3100,value:'2026-09-28'},
  /* ---- วงเงิน USD : รายการย่อย → ยังไม่ครบ 1M (ค้างในกองรอแจ้ง) ---- */
  {id:'FWD-2026-100029',company:'บจ. ดราก้อน เทรด จำกัด',   side:'buy', ccy:'USD',amt:350000,  line:'USD',spot:36.4200,final:36.2400,value:'2026-07-22'},
  {id:'FWD-2026-100030',company:'บจ. ซากุระ อิมพอร์ต จำกัด', side:'sell',ccy:'JPY',amt:20000000,line:'USD',spot:0.2438, final:0.2430, value:'2026-10-10'},
  {id:'FWD-2026-100031',company:'บจ. ยูโร เฟรช จำกัด',      side:'buy', ccy:'EUR',amt:100000,  line:'USD',spot:39.6800,final:39.5200,value:'2026-08-30'},

  /* ---- วงเงิน CNY : รายการเดี่ยว (≥3.5M CNY) → แจ้งเดี่ยวอัตโนมัติ ---- */
  {id:'FWD-2026-100040',company:'บจ. หนานหนิง เทรด จำกัด',   side:'sell',ccy:'CNY',amt:4200000, line:'CNY',spot:5.0200, final:5.0000, value:'2026-09-18'},
  /* ---- วงเงิน CNY : รายการย่อย → มัดเป็นกลุ่ม G-CNY-1 ---- */
  {id:'FWD-2026-100025',company:'บจ. นอร์ทเทิร์น ฟาร์ม จำกัด',side:'sell',ccy:'CNY',amt:2000000, line:'CNY',spot:5.0200, final:5.0000, value:'2026-08-05'},
  {id:'FWD-2026-100041',company:'บจ. เสฉวน ฟู้ด จำกัด',     side:'buy', ccy:'CNY',amt:3100000, line:'CNY',spot:5.0200, final:5.0100, value:'2026-08-22'},
  {id:'FWD-2026-100042',company:'บจ. กวางโจว สตีล จำกัด',   side:'sell',ccy:'CNY',amt:2500000, line:'CNY',spot:5.0200, final:5.0000, value:'2026-09-12'},
  /* ---- วงเงิน CNY : รายการเดี่ยว — จอง SGD แต่ตัดวงเงิน CNY (โชว์ feed by วงเงิน) ---- */
  {id:'FWD-2026-100043',company:'บจ. เซี่ยงไฮ้ อิมพอร์ต จำกัด',side:'buy', ccy:'SGD',amt:800000,line:'CNY',spot:27.1500,final:27.0500,value:'2026-10-02'},
  /* ---- วงเงิน CNY : รายการย่อย → ยังไม่ครบ 7M (ค้างในกองรอแจ้ง) ---- */
  {id:'FWD-2026-100044',company:'บจ. คุนหมิง การ์เมนท์ จำกัด',side:'sell',ccy:'CNY',amt:1500000, line:'CNY',spot:5.0200, final:5.0000, value:'2026-10-15'},
];
/* แปลงจำนวนที่จอง → จำนวนใน "สกุลวงเงิน" (line) เพื่อเทียบกับเกณฑ์ของวงเงินนั้น */
function saLineAmt(t){
  var sLine=(M.rates[t.line]?M.rates[t.line].spot:1), sCcy=(M.rates[t.ccy]?M.rates[t.ccy].spot:1);
  return t.ccy===t.line ? t.amt : t.amt*sCcy/sLine;
}
/* ระบบประมวลผลอัตโนมัติ "แยกตามสกุลวงเงิน":
   ไล่รายการของแต่ละวงเงินตามลำดับ → รายการ ≥ เกณฑ์ แจ้งเดี่ยวทันที ·
   รายการย่อยสะสมในกองของวงเงินนั้น พอถึงเกณฑ์ยอดรวมก็มัดเป็นกลุ่ม (G-USD-1, G-CNY-1…) */
function saEvaluate(){
  SA.notified={}; SA.aggNotified={}; SA.txnGroup={}; SA.groups=[]; SA.pending=[]; SA.pendingSum={};
  SA.ccys.forEach(function(ccy){
    var perTxn=SA.perTxn[ccy], agg=SA.agg[ccy];
    var pool=[], poolSum=0, gCount=0;
    SA_TXNS.filter(function(t){return t.line===ccy;}).forEach(function(t){
      var amt=saLineAmt(t);
      if(amt>=perTxn){ SA.notified[t.id]=true; return; }
      pool.push(t); poolSum+=amt;
      if(poolSum>=agg){
        gCount++; var gid='G-'+ccy+'-'+gCount, ids=pool.map(function(x){return x.id;});
        ids.forEach(function(id){SA.aggNotified[id]=true; SA.txnGroup[id]=gid;});
        SA.groups.push({gid:gid, ccy:ccy, ids:ids, sum:poolSum});
        pool=[]; poolSum=0;
      }
    });
    pool.forEach(function(x){SA.pending.push(x.id);});
    SA.pendingSum[ccy]=poolSum;
  });
}
/* สรุปสถิติรายวัน (ใช้ทั้ง mini dashboard และปุ่ม export) */
function saStats(){
  var st={byCcy:{}, total:{email:0,req:0,done:0,pend:0}};
  SA.ccys.forEach(function(ccy){
    var singles=SA_TXNS.filter(function(t){return t.line===ccy&&SA.notified[t.id];});
    var grouped=SA_TXNS.filter(function(t){return t.line===ccy&&SA.aggNotified[t.id];});
    var groups =SA.groups.filter(function(g){return g.ccy===ccy;});
    var reqIds =singles.map(function(t){return t.id;}).concat(grouped.map(function(t){return t.id;}));
    var done   =reqIds.filter(function(id){return SA.squared[id];}).length;
    var pend   =SA_TXNS.filter(function(t){return t.line===ccy&&SA.pending.indexOf(t.id)>=0;});
    var emailCnt=singles.length+groups.length;
    st.byCcy[ccy]={singles:singles.length,groups:groups.length,email:emailCnt,
                   req:reqIds.length,done:done,pend:pend.length,pendSum:SA.pendingSum[ccy]||0};
    st.total.email+=emailCnt; st.total.req+=reqIds.length; st.total.done+=done; st.total.pend+=pend.length;
  });
  return st;
}

/* === SA-1917 — แจ้งเตือนเพื่อ Square Position === */
/* แท็กบอกที่มาการแจ้งเตือนของแต่ละรายการ (ใช้ร่วมกันทั้ง feed และ EOD) */
function saNotifyTag(t){
  if(SA.notified[t.id])return '<span class="tag tag-er">'+ic('mail')+' แจ้งเดี่ยว · '+t.id.slice(-6)+'</span>';
  if(SA.txnGroup[t.id])return '<span class="tag tag-wn">'+ic('mail')+' '+SA.txnGroup[t.id]+'</span>';
  return '<span class="tag tag-inf">รอครบยอดรวม</span>';
}
function hSA1917(){
  saEvaluate();                         /* ระบบประมวลผล + แจ้งเตือนอัตโนมัติทุกครั้งที่เปิด/แก้เกณฑ์ */

  /* ---- (1) ฟอร์มตั้งค่า (AC1/AC2) — แยกตามสกุลวงเงินที่ให้บริการ ---- */
  var cset=SA.ccys.map(function(ccy){
    return '<div style="border:1px solid var(--bdr);border-radius:var(--rs);padding:12px 14px;margin-bottom:10px">'
      +'<div style="font-weight:700;font-size:13px;margin-bottom:8px">'+ic('bld')+' วงเงินสกุล '+ccy+'</div>'
      +'<div class="row">'
        +'<div class="fg"><span class="fl">เกณฑ์ต่อรายการ ('+ccy+') <span class="req">*</span></span>'
          +'<input type="text" inputmode="numeric" class="sa-perTxn" data-ccy="'+ccy+'" value="'+fmtAmt(SA.perTxn[ccy])+'">'
          +'<div style="font-size:11px;color:var(--t3);margin-top:4px">แจ้งทันทีเมื่อรายการเดียว ≥ ค่านี้</div></div>'
        +'<div class="fg"><span class="fl">เกณฑ์ยอดรวมสะสม ('+ccy+') <span class="req">*</span></span>'
          +'<input type="text" inputmode="numeric" class="sa-agg" data-ccy="'+ccy+'" value="'+fmtAmt(SA.agg[ccy])+'">'
          +'<div style="font-size:11px;color:var(--t3);margin-top:4px">รายการย่อยรวมแล้วถึงค่านี้จึงแจ้ง</div></div>'
      +'</div>'
      +'<div class="fg" style="margin-top:8px"><span class="fl">Email ผู้รับ (ส่วนค้าเงินฯ) — วงเงิน '+ccy+'</span>'
        +'<input type="text" class="sa-emails" data-ccy="'+ccy+'" value="'+(SA.emails[ccy]||'')+'"></div>'
    +'</div>';
  }).join('');
  var settings='<div class="card">'
    +'<div class="card-title">'+ic('bld')+' ตั้งค่าเกณฑ์การแจ้งเตือน (AC1 / AC2)</div>'
    +'<div class="alert info">'+ic('info')+'<div>เกณฑ์ขึ้นกับ<strong>สกุลวงเงินที่ให้บริการในปีนี้</strong> — ปัจจุบันคือ <strong>'+SA.ccys.join(', ')+'</strong> · กำหนดจำนวนเงิน<strong>ในสกุลของวงเงิน</strong> (ไม่ใช่สกุลที่ลูกค้าจอง) · แก้แล้วกดบันทึก ระบบประมวลผลใหม่ทันที</div></div>'
    +cset
    +'<div class="btn-row" style="margin-top:12px"><button class="btn btn-p" id="sa-save">'+ic('check')+' บันทึกการตั้งค่า</button></div>'
    +'<div id="sa-save-ok">'+(SA.saved?'<div class="alert success" style="margin-top:10px">'+ic('check')+'<div>บันทึกค่าล่าสุดแล้ว — ระบบประมวลผลใหม่ด้วยเกณฑ์นี้</div></div>':'')+'</div>'
  +'</div>';

  /* ---- (2) feed การจอง + แจ้งเตือนอัตโนมัติ — แยกเป็นบล็อกตามสกุลวงเงิน ---- */
  var feedSections=SA.ccys.map(function(ccy){
    var perTxn=SA.perTxn[ccy], agg=SA.agg[ccy];
    var txns=SA_TXNS.filter(function(t){return t.line===ccy;});
    var rows=txns.map(function(t){
      var amt=saLineAmt(t), meets=amt>=perTxn;
      var stat=meets?'<span class="tag tag-er">≥ เกณฑ์รายการ</span>':'<span class="tag tag-inf">นับยอดรวม</span>';
      return '<tr>'
        +'<td style="font-weight:600">'+t.company+'<div style="font-size:11px;color:var(--t3);font-weight:400">'+t.id+'</div></td>'
        +'<td>'+(t.side==='sell'?'ขาย':'ซื้อ')+'</td>'
        +'<td>'+t.ccy+'</td>'
        +'<td style="text-align:right">'+fmt(t.amt,0)+'</td>'
        +'<td style="text-align:right;color:var(--t2)">'+fmt(amt,0)+'</td>'
        +'<td style="text-align:right">'+fmtR(t.spot,t.ccy)+'</td>'
        +'<td style="text-align:right">'+fmtR(t.final,t.ccy)+'</td>'
        +'<td>'+fmtTH(t.value)+'</td>'
        +'<td style="text-align:center">'+stat+'</td>'
        +'<td style="text-align:center">'+saNotifyTag(t)+'</td>'
      +'</tr>';
    }).join('');
    var pendSum=SA.pendingSum[ccy]||0, pct=Math.min(100, agg>0?pendSum/agg*100:0);
    var pendCount=txns.filter(function(t){return SA.pending.indexOf(t.id)>=0;}).length;
    var aggBox='<div style="margin-top:10px;border:1px solid var(--bdr);border-radius:var(--rs);padding:12px 14px;background:var(--bg)">'
      +'<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:8px"><span>กองสะสมที่ยังไม่ถึงเกณฑ์ (วงเงิน '+ccy+')</span><span>'+fmt(pendSum,0)+' / '+fmt(agg,0)+' '+ccy+'</span></div>'
      +'<div style="height:10px;background:var(--bdr);border-radius:6px;overflow:hidden;margin-bottom:8px"><div style="height:100%;width:'+pct.toFixed(1)+'%;background:var(--blue);transition:width .3s"></div></div>'
      +'<div style="font-size:11px;color:var(--t3)">ครบ '+fmt(agg,0)+' '+ccy+' จะมัดเป็นกลุ่มแล้ว<strong>ส่ง Email เอง</strong> · ตอนนี้ค้าง '+pendCount+' รายการ</div>'
    +'</div>';
    return '<div style="margin-bottom:18px">'
      +'<div style="font-weight:700;font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:6px">'+ic('bld')+' วงเงินสกุล '+ccy
        +' <span style="font-weight:400;color:var(--t3);font-size:11px">เกณฑ์รายการ ≥ '+fmt(perTxn,0)+' · ยอดรวม ≥ '+fmt(agg,0)+'</span></div>'
      +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr>'
        +'<th>บริษัท / เลขที่จอง</th><th>ฝั่ง</th><th>สกุลจอง</th><th style="text-align:right">จำนวน</th><th style="text-align:right">≈ '+ccy+'</th>'
        +'<th style="text-align:right">Spot</th><th style="text-align:right">Final</th><th>Value Date</th><th style="text-align:center">เกณฑ์</th><th style="text-align:center">การแจ้งเตือน</th>'
      +'</tr></thead><tbody>'+rows+'</tbody></table></div>'
      +aggBox
    +'</div>';
  }).join('');

  var feed='<div class="card">'
    +'<div class="card-title">'+ic('refresh')+' Feed การจอง Forward วันนี้ (จำลอง) — AC3 · แจ้งอัตโนมัติ</div>'
    +'<div class="alert info">'+ic('info')+'<div>Feed/การรวมยอด<strong>แยกตามสกุลวงเงิน</strong> (USD / CNY) — ไม่ได้ดูจากสกุลที่ลูกค้าจอง · รายการเดี่ยว ≥ เกณฑ์รายการ ส่ง Email ทันที · รายการย่อยสะสมจนครบเกณฑ์ยอดรวมมัดเป็นกลุ่มแล้วส่ง Email</div></div>'
    +feedSections
    +'<div class="btn-row"><button class="btn btn-s" id="sa-reset">'+ic('refresh')+' รีเซ็ต (เคลียร์ flag square)</button></div>'
  +'</div>';

  /* ---- (3) Email ที่ระบบส่งอัตโนมัติ ---- */
  function emailCard(title, accent, subj, list, totLabel, ccy){
    var erows=list.map(function(t){
      return '<tr>'
        +'<td style="font-weight:600">'+t.company+'</td>'
        +'<td>'+(t.side==='sell'?'ขาย':'ซื้อ')+'</td>'
        +'<td>'+t.ccy+'</td>'
        +'<td style="text-align:right">'+fmt(t.amt,0)+'</td>'
        +'<td style="text-align:right">'+fmtR(t.spot,t.ccy)+'</td>'
        +'<td style="text-align:right">'+fmtR(t.final,t.ccy)+'</td>'
        +'<td>'+fmtTH(t.value)+'</td>'
      +'</tr>';
    }).join('');
    return '<div style="border:1px solid var(--bdr);border-left:3px solid '+accent+';border-radius:var(--rs);overflow:hidden;margin-bottom:12px">'
      +'<div style="background:var(--inf-bg);padding:10px 14px;font-size:12px;line-height:1.8">'
        +'<div style="font-weight:700;color:'+accent+';margin-bottom:2px">'+title+'</div>'
        +'<div><strong>ถึง:</strong> '+(SA.emails[ccy]||'')+'</div>'
        +'<div><strong>เรื่อง:</strong> '+subj+'</div>'
      +'</div>'
      +'<div style="padding:12px 14px">'
        +'<div style="font-size:12px;color:var(--t2);margin-bottom:8px">เรียน ส่วนค้าเงินฯ — มีรายการจอง Forward เข้าเกณฑ์ กรุณาดำเนินการ <strong>square position</strong></div>'
        +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr><th>ชื่อบริษัท</th><th>ฝั่ง</th><th>สกุลเงิน</th><th style="text-align:right">จำนวนเงิน</th><th style="text-align:right">Spot Rate</th><th style="text-align:right">Final Rate</th><th>Value Date</th></tr></thead>'
        +'<tbody>'+erows+'</tbody></table></div>'
        +(totLabel!=null?'<div style="text-align:right;font-size:12px;font-weight:700;margin-top:8px">รวมเทียบเท่า ≈ '+totLabel+'</div>':'')
      +'</div>'
    +'</div>';
  }
  var mails='';
  SA_TXNS.forEach(function(t){
    if(SA.notified[t.id]) mails+=emailCard('Email · แจ้งเดี่ยว (วงเงิน '+t.line+')','var(--er)',
      '[Square Position Alert] รายการจอง Forward '+t.company,[t],null,t.line);
  });
  SA.groups.forEach(function(g){
    var list=g.ids.map(function(id){return SA_TXNS.filter(function(x){return x.id===id;})[0];});
    mails+=emailCard('Email · '+g.gid+' (รวมยอด '+list.length+' รายการ · วงเงิน '+g.ccy+')','var(--wn)',
      '[Square Position Alert] ยอดรวมรายการจอง Forward ครบ '+fmt(SA.agg[g.ccy],0)+' '+g.ccy+' — '+g.gid,list,fmt(g.sum,0)+' '+g.ccy,g.ccy);
  });
  var emailSec='<div class="card">'
    +'<div class="card-title">'+ic('mail')+' Email ที่ระบบส่งอัตโนมัติ</div>'
    +(mails||'<div class="alert info" style="margin:0">'+ic('info')+'<div>ยังไม่มีรายการเข้าเกณฑ์</div></div>')
  +'</div>';

  /* ---- (4) square position flag + EOD reconcile (mini dashboard + filter + export) ---- */
  function txnById(id){return SA_TXNS.filter(function(x){return x.id===id;})[0];}
  function cntSq(ids){return ids.filter(function(id){return SA.squared[id];}).length;}
  /* ตัวกรอง */
  function passFilter(t){
    if(SA.filter.line && t.line!==SA.filter.line) return false;
    var cat=SA.notified[t.id]?'single':SA.aggNotified[t.id]?'group':'pending';
    if(SA.filter.notify && cat!==SA.filter.notify) return false;
    if(SA.filter.sq){ var done=!!SA.squared[t.id];
      if(SA.filter.sq==='done'&&!done)return false;
      if(SA.filter.sq==='todo'&&done)return false; }
    return true;
  }
  /* แถวรายการเดี่ยวในตาราง square */
  function sqRow(t){
    var sq=!!SA.squared[t.id];
    return '<tr'+(SA.txnGroup[t.id]?' style="background:rgba(122,91,0,.04)"':'')+'>'
      +'<td><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" class="sa-sq" data-id="'+t.id+'"'+(sq?' checked':'')+'> '+t.company+'</label></td>'
      +'<td><span class="tag tag-inf">'+t.line+'</span></td>'
      +'<td>'+t.ccy+' '+fmt(t.amt,0)+'</td>'
      +'<td>'+fmtTH(t.value)+'</td>'
      +'<td style="text-align:center">'+saNotifyTag(t)+'</td>'
      +'<td style="text-align:center">'+(sq?'<span class="tag tag-ok">'+ic('check')+' Squared</span>':'<span class="tag tag-wn">ยังไม่ทำ</span>')+'</td>'
    +'</tr>';
  }
  function sectionRow(text){
    return '<tr style="background:var(--inf-bg)"><td colspan="6" style="font-weight:700;font-size:12px;color:var(--inf)">'+text+'</td></tr>';
  }
  /* แถวหัวกลุ่ม + checkbox ติ๊ก square ทั้งกลุ่มทีเดียว */
  function groupRow(g){
    var d=cntSq(g.ids), all=d===g.ids.length;
    return '<tr style="background:var(--wn-bg)"><td colspan="6">'
      +'<label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:700;font-size:12px;color:var(--wn)">'
      +'<input type="checkbox" class="sa-sq-group" data-ids="'+g.ids.join(',')+'"'+(all?' checked':'')+'> '
      +ic('check')+' '+g.gid+' · วงเงิน '+g.ccy+' · รวมยอด '+g.ids.length+' รายการ — ติ๊ก square ทั้งกลุ่ม ('+d+'/'+g.ids.length+')</label></td></tr>';
  }
  /* จัดเรียงเป็นบล็อก: แจ้งเดี่ยว → กลุ่ม Gx → ค้างในกอง (ผ่านตัวกรอง) */
  var sqRows='';
  var singles=SA_TXNS.filter(function(t){return SA.notified[t.id]&&passFilter(t);});
  if(singles.length){sqRows+=sectionRow('แจ้งเดี่ยว (≥ เกณฑ์รายการ)');singles.forEach(function(t){sqRows+=sqRow(t);});}
  SA.groups.forEach(function(g){
    var members=g.ids.map(txnById).filter(passFilter);
    if(!members.length)return;
    sqRows+=groupRow(g);
    members.forEach(function(t){sqRows+=sqRow(t);});
  });
  var pend=SA.pending.map(txnById).filter(passFilter);
  if(pend.length){sqRows+=sectionRow('ยังไม่แจ้ง (กองสะสมค้างรอครบยอดรวม)');pend.forEach(function(t){sqRows+=sqRow(t);});}
  if(!sqRows) sqRows='<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:18px">ไม่มีรายการตามตัวกรอง</td></tr>';

  /* mini dashboard สรุปรายวัน */
  var st=saStats(), tdy=new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});
  function statCard(label,ccy,d){
    return '<div style="flex:1;min-width:180px;border:1px solid var(--bdr);border-radius:var(--rs);padding:12px 14px">'
      +'<div style="font-size:12px;font-weight:700;color:var(--inf);margin-bottom:6px">'+label+'</div>'
      +'<div style="font-size:12px;line-height:1.9">'
        +'<div style="display:flex;justify-content:space-between"><span>Email ที่แจ้ง</span><strong>'+d.email+' ฉบับ</strong></div>'
        +'<div style="display:flex;justify-content:space-between"><span>Square แล้ว</span><strong style="color:'+(d.req>0&&d.done===d.req?'var(--ok)':'var(--wn)')+'">'+d.done+'/'+d.req+'</strong></div>'
        +'<div style="display:flex;justify-content:space-between"><span>ค้างรอแจ้ง</span><strong>'+d.pend+' รายการ</strong></div>'
        +(ccy?'<div style="display:flex;justify-content:space-between"><span>กองสะสมค้าง</span><strong>'+fmt(d.pendSum,0)+' '+ccy+'</strong></div>':'')
      +'</div>'
    +'</div>';
  }
  var dashCards=SA.ccys.map(function(ccy){return statCard('วงเงิน '+ccy,ccy,st.byCcy[ccy]);}).join('');
  dashCards+=statCard('รวมทุกวงเงิน',null,{email:st.total.email,req:st.total.req,done:st.total.done,pend:st.total.pend,pendSum:0});
  var dashboard='<div style="border:1px solid var(--bdr);border-radius:var(--rs);padding:14px 16px;margin-bottom:14px;background:var(--bg)">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">'
      +'<div style="font-size:13px;font-weight:700">'+ic('cal')+' Mini Dashboard สรุปรายวัน · '+tdy+'</div>'
      +'<button class="btn btn-s" id="sa-export" style="padding:6px 12px;font-size:12px">⬇ Export สรุปรายวัน</button>'
    +'</div>'
    +'<div style="display:flex;gap:10px;flex-wrap:wrap">'+dashCards+'</div>'
  +'</div>';

  /* แถบตัวกรอง */
  function opt(v,label,cur){return '<option value="'+v+'"'+(cur===v?' selected':'')+'>'+label+'</option>';}
  var lineOpts=opt('','ทุกวงเงิน',SA.filter.line)+SA.ccys.map(function(c){return opt(c,'วงเงิน '+c,SA.filter.line);}).join('');
  var filterBar='<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">'
    +'<div class="fg" style="margin:0;min-width:140px"><span class="fl" style="font-size:11px">'+ic('filter')+' สกุลวงเงิน</span><select id="sa-fl-line">'+lineOpts+'</select></div>'
    +'<div class="fg" style="margin:0;min-width:160px"><span class="fl" style="font-size:11px">การแจ้งเตือน</span><select id="sa-fl-notify">'
      +opt('','ทั้งหมด',SA.filter.notify)+opt('single','แจ้งเดี่ยว',SA.filter.notify)+opt('group','กลุ่มรวมยอด',SA.filter.notify)+opt('pending','ยังไม่แจ้ง',SA.filter.notify)+'</select></div>'
    +'<div class="fg" style="margin:0;min-width:150px"><span class="fl" style="font-size:11px">สถานะ square</span><select id="sa-fl-sq">'
      +opt('','ทั้งหมด',SA.filter.sq)+opt('done','Squared แล้ว',SA.filter.sq)+opt('todo','ยังไม่ทำ',SA.filter.sq)+'</select></div>'
    +(  (SA.filter.line||SA.filter.notify||SA.filter.sq)
        ?'<button class="btn btn-s" id="sa-fl-clear" style="padding:8px 12px;font-size:12px">'+ic('x')+' ล้างตัวกรอง</button>':'')
  +'</div>';

  /* สรุป reconcile แยกรายกลุ่ม/รายการแจ้งเดี่ยว */
  var reconLines='';
  SA_TXNS.forEach(function(t){
    if(SA.notified[t.id]){
      var ok=!!SA.squared[t.id];
      reconLines+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--bdr)"><span>'+saNotifyTag(t)+' &nbsp;'+t.company+'</span><span style="font-weight:700;color:'+(ok?'var(--ok)':'var(--wn)')+'">'+(ok?1:0)+'/1</span></div>';
    }
  });
  SA.groups.forEach(function(g){
    var d=cntSq(g.ids), done=d===g.ids.length;
    reconLines+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--bdr)"><span><span class="tag tag-wn">'+g.gid+'</span> &nbsp;วงเงิน '+g.ccy+' · รวมยอด '+g.ids.length+' รายการ</span><span style="font-weight:700;color:'+(done?'var(--ok)':'var(--wn)')+'">'+d+'/'+g.ids.length+'</span></div>';
  });
  if(SA.pending.length)
    reconLines+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--bdr)"><span><span class="tag tag-inf">ยังไม่แจ้ง</span> &nbsp;กองสะสมค้าง '+SA.pending.length+' รายการ</span><span style="color:var(--t3)">—</span></div>';

  var notifiedIds=SA_TXNS.filter(function(t){return SA.notified[t.id]||SA.aggNotified[t.id];}).map(function(t){return t.id;});
  var doneN=cntSq(notifiedIds), totalN=notifiedIds.length, allDone=totalN>0&&doneN===totalN;
  var eod='<div class="alert '+(allDone?'success':'warn')+'" style="margin-top:12px">'+ic(allDone?'check':'warn')
    +'<div><strong>EOD Reconcile:</strong> รายการที่แจ้งให้ square แล้วทำครบ '+doneN+'/'+totalN+' รายการ'
    +(allDone?' — square ครบทุกก้อนที่แจ้งไป ✓':' — ยังเหลือ '+(totalN-doneN)+' รายการที่แจ้งไปแล้วแต่ยังไม่ square')+'</div></div>';

  var square='<div class="card">'
    +'<div class="card-title">'+ic('check')+' Square Position Flag &amp; EOD Reconcile</div>'
    +'<div class="alert info">'+ic('info')+'<div>ติ๊ก flag รายการที่ square position แล้ว — ติ๊กทีละรายการ หรือใช้ checkbox <strong>หัวกลุ่ม (สีเหลือง) เพื่อ square ทั้งกลุ่มทีเดียว</strong> · ใช้ตัวกรองด้านล่างช่วยหา · ตอน EOD เช็คได้ว่าแต่ละก้อนที่แจ้งไป square ครบหรือยัง</div></div>'
    +dashboard
    +filterBar
    +'<div style="overflow-x:auto"><table class="rate-table"><thead><tr><th>บริษัท</th><th>วงเงิน</th><th>จำนวน</th><th>Value Date</th><th style="text-align:center">การแจ้งเตือน</th><th style="text-align:center">สถานะ square</th></tr></thead>'
    +'<tbody>'+sqRows+'</tbody></table></div>'
    +'<div style="margin-top:14px;border:1px solid var(--bdr);border-radius:var(--rs);padding:12px 16px">'
      +'<div style="font-size:13px;font-weight:700;margin-bottom:8px">สรุปตามก้อนที่แจ้งเตือน</div>'+reconLines
    +'</div>'+eod
  +'</div>';

  /* ---- header ---- */
  var head='<div class="card">'
    +'<div class="card-title">'+ic('cal')+' SA-1917 — กำหนดจำนวนเงินทำรายการ เพื่อแจ้งเตือนให้ Square Position</div>'
    +'<div class="alert info">'+ic('info')+'<div><strong>โจทย์:</strong> ตั้งค่าจำนวนเงินที่ลูกค้าจอง Forward เพื่อ Alert ให้ส่วนค้าเงินฯ (BU) และ square position ได้ทันที · เกณฑ์<strong>แยกตามสกุลวงเงินที่ให้บริการปีนี้</strong> ('+SA.ccys.join(', ')+') · ระบบ<strong>รวมยอดและส่ง Email อัตโนมัติ</strong> แยกราย line</div></div>'
  +'</div>';

  return '<div class="sc">'+head+settings+feed+emailSec+square+'</div>';
}
function bindSA1917(){
  function $(id){return document.getElementById(id);}
  function on(id,ev,fn){var e=$(id);if(e)e.addEventListener(ev,fn);}
  var save=$('sa-save');
  if(save)save.addEventListener('click',function(){
    var np={}, na={}, ok=true;
    document.querySelectorAll('.sa-perTxn').forEach(function(e){var v=parseFloat((e.value||'').replace(/,/g,''));if(isNaN(v)||v<=0)ok=false;np[e.dataset.ccy]=v;});
    document.querySelectorAll('.sa-agg').forEach(function(e){var v=parseFloat((e.value||'').replace(/,/g,''));if(isNaN(v)||v<=0)ok=false;na[e.dataset.ccy]=v;});
    if(!ok){alert('กรุณากรอกเกณฑ์ของทุกสกุลวงเงินให้ถูกต้อง (มากกว่า 0)');return;}
    var ne={};document.querySelectorAll('.sa-emails').forEach(function(e){ne[e.dataset.ccy]=(e.value||'').trim();});
    SA.perTxn=np; SA.agg=na; SA.emails=ne; SA.saved=true;
    render();
  });
  document.querySelectorAll('.sa-sq').forEach(function(c){
    c.addEventListener('change',function(){SA.squared[this.dataset.id]=this.checked;render();});
  });
  document.querySelectorAll('.sa-sq-group').forEach(function(c){
    c.addEventListener('change',function(){
      var chk=this.checked;
      (this.dataset.ids||'').split(',').filter(Boolean).forEach(function(id){SA.squared[id]=chk;});
      render();
    });
  });
  on('sa-reset','click',function(){ SA.squared={};render(); });
  /* ตัวกรองตาราง Square Position Flag */
  on('sa-fl-line','change',function(){SA.filter.line=this.value;render();});
  on('sa-fl-notify','change',function(){SA.filter.notify=this.value;render();});
  on('sa-fl-sq','change',function(){SA.filter.sq=this.value;render();});
  on('sa-fl-clear','click',function(){SA.filter={line:'',notify:'',sq:''};render();});
  /* Export สรุปรายวัน (mock — ไม่สร้างไฟล์จริง) */
  on('sa-export','click',function(){
    var st=saStats(), tdy=new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});
    var lines=['สรุป Square Position รายวัน — '+tdy,'สกุลวงเงินที่ให้บริการ: '+SA.ccys.join(', '),''];
    SA.ccys.forEach(function(ccy){
      var d=st.byCcy[ccy];
      lines.push('• วงเงิน '+ccy+' : Email '+d.email+' ฉบับ · Square '+d.done+'/'+d.req+' · ค้างรอแจ้ง '+d.pend+' รายการ ('+fmt(d.pendSum,0)+' '+ccy+')');
    });
    lines.push('');
    lines.push('รวมทุกวงเงิน : Email '+st.total.email+' ฉบับ · Square '+st.total.done+'/'+st.total.req+' · ค้าง '+st.total.pend+' รายการ');
    alert(lines.join('\n'));   /* mock export: แสดงสรุป ไม่ปั้นไฟล์จริง */
  });
}
