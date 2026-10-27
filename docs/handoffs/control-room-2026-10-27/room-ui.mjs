import {initial,event,apply,replay,unknownCall} from './room-model.mjs';
let rows=[],s=null,lastSettlement;
const $=id=>document.getElementById(id),money=x=>'$'+(x/1e6).toFixed(3);
function paint(){
 const blank=!s;
 for(const key of ['process','work','review','financial'])$(key).textContent=blank?'not loaded':s[key];
 $('identity').textContent=blank?'not loaded':s.job+' / '+s.attempt;$('owner').textContent=blank?'not assigned':s.owner;$('attempt').textContent=blank?'not loaded':'fixture attempt 01';
 $('cursor').textContent=blank?'no stream':'fixture cursor '+s.cursor;$('stream').textContent=blank?'not connected':s.stream;
 $('quote').textContent=blank?'not recorded':money(s.quoteMicros);$('charged').textContent=blank?'not recorded':s.chargedMicros===null?'unknown':money(s.chargedMicros);
 $('reserved').textContent=blank?'No call or reservation':s.reservationMicros?money(s.reservationMicros)+' reservation retained':'settlement recorded · reservation released';
 $('call').textContent=blank?'not recorded':s.callId;$('provider').textContent=blank?'not recorded':'not observed in this fixture';$('cancel-state').textContent=blank?'none':s.cancel;
 $('attention').textContent=blank?'Choose a fixture to explore':s.financial==='unknown_outcome'?'Outcome unknown':s.financial==='settled'?'Review remains pending':'Inspect fixture state';
 $('attention-detail').textContent=blank?'This study has no execution connection.':s.financial==='settled'?'A settled charge does not clear review.':'Reconcile the existing call before another paid dispatch.';
 $('log').textContent=blank?'Blank workspace. No project, assets or private records loaded.':s.errors.slice(-3).join('\n')||'Fixture projection only. Dispatch count: '+s.dispatchCount+' · review pending.';
 for(const button of document.querySelectorAll('button'))if(!['load','reset'].includes(button.id))button.disabled=blank;
 document.body.dataset.fixture=blank?'false':'true';
}
function send(kind,data={},principal='worker',overrides={}){if(!s)return;const e={...event(s.cursor+1,kind,data),...overrides};s=apply(s,e,principal);rows.push({event:e,principal});paint();return e;}
$('load').onclick=()=>{rows=unknownCall();s=replay(rows);lastSettlement=null;paint()};
$('reset').onclick=()=>{rows=[];s=null;lastSettlement=null;paint()};
$('reopen').onclick=()=>{s=replay(JSON.parse(JSON.stringify(rows)));paint()};
$('proposal').onclick=()=>send('worker_proposal');$('spoof').onclick=()=>send('review_cleared',{actor:'verifier'},'worker');$('cancel').onclick=()=>send('cancel_requested',{},'host');$('retry').onclick=()=>send('retry_requested',{},'host');
$('settle').onclick=()=>{lastSettlement=send('charge_recorded',{callId:'fixture-call-01',micros:1000},'host')};
$('duplicate').onclick=()=>{if(!lastSettlement)lastSettlement=send('charge_recorded',{callId:'fixture-call-01',micros:1000},'host');s=apply(apply(s,lastSettlement,'host'),lastSettlement,'host');paint()};
$('gap').onclick=()=>send('worker_proposal',{},'worker',{seq:s.cursor+2});$('stale').onclick=()=>send('worker_proposal',{},'worker',{attempt:'fixture-old-attempt'});
paint();
