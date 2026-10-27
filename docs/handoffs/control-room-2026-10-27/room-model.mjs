// Disconnected design fixture. There is no provider adapter or credential path here.
export const revision='control-fixture-r12-treg-v1';
const canonical=x=>JSON.stringify(x,Object.keys(x).sort());
export function initial(){return {fixture:true,job:'fixture-job-01',attempt:'fixture-attempt-01',revision,cursor:0,seen:{},stream:'caught_up',process:'working',work:'in_progress',review:'pending',artifact:'unknown',evidence:'unknown',owner:'builder fixture',model:'not observed',effort:'not observed',quoteMicros:null,chargedMicros:null,callId:null,reservationMicros:0,grant:false,dispatchCount:0,financial:'not_dispatched',cancel:'none',errors:[]};}
export function event(seq,kind,data={}){return {id:'fixture-event-'+seq,seq,job:'fixture-job-01',attempt:'fixture-attempt-01',revision,kind,data};}
export function apply(input,e,principal='worker'){
 const s=structuredClone(input),reject=why=>{s.errors.push(why);return s};
 if(e.job!==s.job||e.attempt!==s.attempt||e.revision!==s.revision)return reject('foreign job, attempt or revision');
 const bytes=JSON.stringify(e);
 if(s.seen[e.id])return s.seen[e.id]===bytes?s:reject('event identity reused with different payload');
 if(e.seq!==s.cursor+1){s.stream='gap_detected';return reject('replay missing contiguous events first');}
 // principal is supplied by the fixture host, never taken from the event payload.
 if(['dispatch_authorized','dispatch_started'].includes(e.kind)&&principal!=='host')return reject('host authority required');
 if(e.kind==='review_cleared'&&principal!=='verifier')return reject('independent review authority required');
 if(e.kind==='review_cleared'&&s.artifact!=='fixture_checked')return reject('checked artifact required');
 if(e.kind==='dispatch_started'&&(!s.grant||s.dispatchCount))return reject('no unused dispatch authorization');
 if(e.kind==='dispatch_authorized'&&(s.financial!=='not_dispatched'||e.data.authorizedMicros!==s.quoteMicros))return reject('new explicit authorization and matching quote required');
 if(e.kind==='charge_recorded'&&(e.data.callId!==s.callId||!Number.isSafeInteger(e.data.micros)||e.data.micros<0))return reject('settlement identity or amount invalid');
 if(e.kind==='charge_recorded'&&s.chargedMicros!==null&&s.chargedMicros!==e.data.micros)return reject('conflicting settlement requires reconciliation');
 s.cursor=e.seq;s.seen[e.id]=bytes;s.stream='caught_up';
 switch(e.kind){
 case 'quote_received':s.quoteMicros=e.data.micros;break;
 case 'dispatch_authorized':s.grant=true;s.reservationMicros=e.data.authorizedMicros;break;
 case 'dispatch_started':s.grant=false;s.dispatchCount++;s.callId=e.data.callId;s.financial='pending';break;
 case 'connector_unknown':s.financial='unknown_outcome';s.process='unknown';break;
 case 'retry_requested':s.errors.push('paid retry held; reconcile existing call, no dispatch');break;
 case 'charge_recorded':s.chargedMicros=e.data.micros;s.financial='settled';s.reservationMicros=0;break;
 case 'cancel_requested':s.cancel='stop_requested';s.process='stop_requested';break;
 case 'cancel_ack':s.cancel='acknowledged';s.process='stopped';break;
 case 'worker_proposal':s.work='completion_proposed';break;
 case 'artifact_checked':if(principal==='fixture_checker')s.artifact='fixture_checked';else s.errors.push('checker authority required');break;
 case 'review_cleared':s.review='fixture_cleared';s.work='fixture_complete';break;
 case 'disconnect':s.process='unknown';s.stream='needs_replay';break;
 }
 return s;
}
export function replay(rows){return rows.reduce((s,r)=>apply(s,r.event,r.principal),initial());}
export function unknownCall(){return [
 {event:event(1,'quote_received',{micros:1000}),principal:'host'},
 {event:event(2,'dispatch_authorized',{authorizedMicros:1000}),principal:'host'},
 {event:event(3,'dispatch_started',{callId:'fixture-call-01'}),principal:'host'},
 {event:event(4,'connector_unknown'),principal:'host'}];}
