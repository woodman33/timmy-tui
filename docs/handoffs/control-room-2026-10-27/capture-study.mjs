// Local fixture capture only. Uses the repository's existing Playwright dependency.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),out=resolve(process.argv[2]||root);
const req=createRequire(process.env.TIMMY_STUDY_PLAYWRIGHT_ROOT?resolve(process.env.TIMMY_STUDY_PLAYWRIGHT_ROOT,'package.json'):import.meta.url);
const {chromium}=req('playwright');await mkdir(out,{recursive:true});
const files={'/':'room.html','/room-ui.mjs':'room-ui.mjs','/room-model.mjs':'room-model.mjs'};
const server=createServer(async(request,response)=>{const f=files[new URL(request.url,'http://localhost').pathname];if(!f){response.writeHead(404);response.end();return}response.setHeader('content-type',f.endsWith('html')?'text/html':'text/javascript');response.end(await readFile(resolve(root,f)))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;const checks=[],errors=[];
try{
 browser=await chromium.launch({headless:true,...(process.env.TIMMY_STUDY_CHROME?{executablePath:process.env.TIMMY_STUDY_CHROME}:{}),args:['--disable-background-networking','--disable-sync','--disable-extensions']});
 const page=await browser.newPage({viewport:{width:1480,height:1120}});page.on('pageerror',e=>errors.push(String(e)));await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 const record=(id,passed)=>checks.push({id,passed});
 record('B01_blank_by_default',await page.locator('body').getAttribute('data-fixture')==='false');
 record('B02_actions_disabled',await page.locator('#proposal').isDisabled());
 record('B03_no_loaded_fixture_identity',await page.locator('#call').textContent()==='not recorded');
 await page.screenshot({path:resolve(out,'blank-preview.png'),fullPage:true});
 await page.click('#load');record('B04_fixture_explicitly_loaded',await page.locator('body').getAttribute('data-fixture')==='true');await page.screenshot({path:resolve(out,'fixture-preview.png'),fullPage:true});
 await page.click('#proposal');record('B05_proposal_keeps_review_pending',await page.locator('#review').textContent()==='pending');
 await page.click('#spoof');record('B06_worker_cannot_self_clear',(await page.locator('#log').textContent()).includes('independent review authority'));
 await page.click('#retry');record('B07_unknown_does_not_retry',await page.locator('#financial').textContent()==='unknown_outcome');
 await page.click('#settle');record('B08_late_settlement_recorded',await page.locator('#charged').textContent()==='$0.001');
 await page.click('#duplicate');record('B09_duplicate_does_not_add_cost',await page.locator('#charged').textContent()==='$0.001');
 record('B10_attention_follows_settlement',await page.locator('#attention').textContent()==='Review remains pending');
 await page.click('#cancel');record('B11_stop_requested_is_explicit',await page.locator('#cancel-state').textContent()==='stop_requested');
 await page.click('#gap');record('B12_gap_is_visible',await page.locator('#stream').textContent()==='gap_detected');
 await page.click('#stale');record('B13_stale_attempt_refused',(await page.locator('#log').textContent()).includes('foreign job, attempt or revision'));
 await page.click('#reopen');record('B14_replay_preserves_charge',await page.locator('#charged').textContent()==='$0.001');
 await page.click('#reset');record('B15_clear_returns_blank',await page.locator('#call').textContent()==='not recorded');
 await page.reload({waitUntil:'networkidle'});record('B16_reload_starts_blank',await page.locator('body').getAttribute('data-fixture')==='false');
 const result={kind:'actual browser interactions on a disconnected local fixture',checks,errors,browser:browser.version(),passed:checks.length===16&&checks.every(c=>c.passed)&&errors.length===0,providerCalls:0};
 await writeFile(resolve(out,'browser-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,checks:checks.length,errors}));if(!result.passed)process.exitCode=1;
}finally{await browser?.close();await new Promise(r=>server.close(r));}
